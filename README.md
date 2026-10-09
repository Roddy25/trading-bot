# Tradify Backend Bridge

The static Tradify site cannot place real trades — a web page has no server to hold broker
credentials, no way to keep a session alive when the tab closes, and no safe place to run
order logic. This service is that missing half.

It exposes a small HTTP API, holds your broker credentials **in your own process**, and
routes orders to **MetaTrader 5**, **Exness** or **Deriv**. The published site talks to it
over `localhost`; while it is not running, the site stays in clearly-labelled demo mode.

> ⚠️ **Run this on your own machine and never expose it to the public internet.**
> It is a credential-holding process. Keep it on loopback, or behind your own authenticated
> gateway with TLS, rate limiting and an allow-list.

---

## 1. Quick start

```bash
cd server
npm install
cp -n .env.example .env   # if server/.env does not already exist
npm start                 # -> http://127.0.0.1:8787
```

`GET /health` should answer:

```json
{ "ok": true, "mode": "demo", "dryRun": true, "liveArmed": false, "adapters": ["mt5","exness","deriv"] }
```

Now open the site's **Live Trading** page, set the backend base URL to `http://127.0.0.1:8787`
and press **Test connection**. The status pill should turn green.

### ⚠️ Where you open the page from matters

Browsers treat a request from a **publicly-hosted page to `http://localhost`** as a *Private
Network Access* request and block it. If you load the Live Trading page from the published
`https://…` URL, Chrome refuses the call to your local bridge **even when the bridge is
perfectly healthy**, and the page shows only a bare `Failed to fetch`.

**Recommended: run the front-end locally too.** From the project root:

```bash
python3 -m http.server 8090 --bind 127.0.0.1 --directory frontend
# then open http://localhost:8090/live.html
```

Now the page and the bridge share a private-network origin and everything works. This bridge
sets `Access-Control-Allow-Private-Network: true` to be as permissive as possible, but the
browser's PNA policy is a client-side rule the server cannot override — running the page from
`localhost` (or serving the bridge over HTTPS) is what actually resolves it.


---

## 2. Safety model — read this first

Two independent switches must both be thrown before a single real order can leave your machine:

| Switch | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | While true, `/order` **validates and echoes** the order but never contacts a broker. |
| `TRADING_MODE` | `demo` | Must be exactly `live` to arm live routing. |

`liveArmed = (DRY_RUN === "false") && (TRADING_MODE === "live")`. Anything else keeps you safe.

In addition, the **front-end** enforces its own gate: live order entry stays disabled in the
browser until every statement in the on-page risk acknowledgement is ticked.

**Start in dry run, place a few orders, read the console output, and only then consider arming live.**

---

## 3. Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `PORT` | all | Default `8787`. |
| `ALLOWED_ORIGINS` | all | Comma-separated exact browser origins. Loopback origins are allowed by default; the backend itself binds only to `127.0.0.1`. |
| `MT5_BRIDGE_URL` | MT5 | Base URL of your local MT5 bridge (default `http://localhost:5001`). |
| `MT5_BRIDGE_TOKEN` | MT5 | Shared bearer token required by the included Python bridge. |
| `EXNESS_API_BASE` | Exness | Optional custom REST endpoint implementing the project adapter's `/v1/account`, `/v1/positions`, and `/v1/orders` contract. Retail Exness API access is not universal. |
| `DERIV_APP_ID` | Deriv | Register an app id; default `1089` is Deriv's test app id. |
| `DERIV_API_URL` | Deriv | Default `wss://ws.derivws.com/websockets/v3`. |
| `DRY_RUN` | all | `true` / `false`. |
| `TRADING_MODE` | all | `demo` / `live`. |

---

## 4. API reference

All requests and responses are JSON. Credentials are accepted **only** on `POST /connect`
and are never logged or persisted by this service.

### `GET /health`
Liveness plus the safety state.
```json
{ "ok": true, "mode": "demo", "dryRun": true, "liveArmed": false,
  "connected": false, "broker": null, "adapters": ["mt5","exness","deriv"] }
```

### `POST /connect`
```json
{ "broker": "mt5", "credentials": { "login": "12345678", "password": "…", "server": "Exness-MT5Real8" } }
```
Returns the account snapshot and current positions:
```json
{ "connected": true, "broker": "mt5",
  "account": { "accountId": "12345678", "currency": "USD", "balance": 1000, "equity": 1000, "freeMargin": 950, "leverage": 500 },
  "positions": [] }
```
Per-broker credential shapes:

| Broker | Fields |
|---|---|
| `mt5` | `login`, `password`, `server`, `terminal` *(optional path to terminal64.exe)* |
| `exness` | `apiKey`, `apiSecret`, `accountId` |
| `deriv` | `token` *(needs `trade` scope)*, `appId`, `accountId` |

### `POST /disconnect`
Closes the session. `{ "disconnected": true }`

### `GET /account`
```json
{ "account": { "accountId": "…", "currency": "USD", "balance": 1000, "equity": 1000, "freeMargin": 950, "leverage": 500 } }
```

### `GET /positions`
```json
{ "positions": [ { "ticket": "123", "symbol": "EURUSD", "side": "buy", "volume": 0.1,
                   "openPrice": 1.085, "currentPrice": 1.0871, "sl": 1.08, "tp": 1.095, "profit": 21.0 } ] }
```

### `GET /orders`
Orders this session has handled, newest first.
```json
{ "orders": [ { "ts": 1730000000000, "broker": "mt5", "status": "submitted", "ticket": "987654",
                "symbol": "EURUSD", "side": "buy", "orderType": "market", "volume": 0.1,
                "price": null, "sl": 1.08, "tp": 1.095 } ] }
```

### `POST /order`
```json
{ "symbol": "EURUSD", "side": "buy", "orderType": "market", "volume": 0.1, "price": null, "sl": 1.08, "tp": 1.095 }
```
`orderType` is `market` | `limit` | `stop`; a pending order requires a positive `price`.

**Dry-run response** (`liveArmed === false`):
```json
{ "dryRun": true, "accepted": true, "ticket": "DRY-XXXXXXXX",
  "message": "Dry run — order validated but NOT sent to the broker." }
```

**Live response** (`liveArmed === true`):
```json
{ "dryRun": false, "accepted": true, "ticket": "987654", "message": "MT5 bridge accepted the order" }
```

**Errors** use a consistent shape:
```json
{ "error": "Order rejected: volume must be a positive number", "code": "VALIDATION" }
```
Codes: `VALIDATION` (400) · `MT5_BRIDGE_OFFLINE` / `EXNESS_UNREACHABLE` / `DERIV_UNREACHABLE` (502)
· `EXNESS_NOT_CONFIGURED` (503) · missing session (401).

---

## 5. Broker setup in detail

### MetaTrader 5
Node cannot speak the MT5 terminal protocol directly. This project includes `server/mt5_bridge.py`,
a small loopback-only Python bridge that wraps the official Python `MetaTrader5` package. Follow
the steps in [`server/README.md`](server/README.md) to install and run it. It exposes these endpoints:

```bash
pip install MetaTrader5
```

| Method | Path | Body |
|---|---|---|
| POST | `/connect` | `{ login, password, server, terminal }` → `{ accountId, currency, balance, equity, freeMargin, leverage }` |
| POST | `/disconnect` | `{}` |
| GET | `/account` | – → same shape as `/connect` |
| GET | `/positions` | – → `[{ ticket, symbol, type, volume, price_open, price_current, sl, tp, profit }]` |
| POST | `/order` | `{ symbol, side, volume, type, price, sl, tp }` → `{ ticket, message }` |

Keep the terminal running and logged into the account. `initialize()` in your bridge must
succeed before any order is accepted; return a non-2xx status with `{ "error": "…" }` if not.

### Exness
Retail Exness accounts are normally traded **through MetaTrader 5** — use the `mt5` adapter
with your Exness MT5 server name (`Exness-MT5Real8`, etc.). The optional Exness adapter is a
custom HMAC-signed REST contract, not a universal official retail API. Use it only if your
approved Exness integration implements the contract documented in `server/README.md`.

### Deriv
Create an API token at <https://app.deriv.com/account/api-token> with the **`trade`** scope.
The adapter opens a WebSocket, authorises, then prices a proposal and buys it:
`authorize → balance → proposal → buy`. Notes:

* Deriv trades **contracts**, not lots. `volume` is interpreted as the **stake** in your
  account currency, with a fixed 5-minute duration — adjust in `server/adapters/deriv.js`.
* Symbols are mapped to Deriv's form (`EUR/USD → frxEURUSD`, `BTC/USD → cryBTCUSD`); synthetic
  indices pass through unchanged.

---

## 6. What is *not* built here

Be clear-eyed about the gap between this scaffolding and a production trading system:

* **No persistence.** Sessions and orders live in memory; a restart clears them.
* **No reconciliation.** Positions are read straight from the broker; nothing detects drift.
* **No background strategy loop.** The strategy engine runs in the browser. Real automated
  trading needs a server-side scheduler that survives a closed laptop.
* **No compliance layer.** Licensing, KYC/AML, suitability checks, trade reporting and tax
  obligations are yours, and depend on where you and your clients are located.
* **No secrets management.** `.env` is fine for local use; a deployment needs a real vault.

---

## 7. Project layout

```
.
├── frontend/              Static pages, browser scripts, styles, images, and candle data
├── server/                Node API, broker adapters, MT5 bridge, and server config
├── tools/                 Site data utilities
├── legacy/                Archived v1 bridge files kept for reference
├── index.js               Compatibility entry point for the backend
└── package.json           Root shortcuts for backend start and data refresh
```

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Status pill stays amber | Bridge not running, or the front-end's base URL is wrong. Check `curl http://127.0.0.1:8787/health`. |
| `net::ERR_FAILED` / CORS error | Add the site's exact origin to `ALLOWED_ORIGINS` in `server/.env`, then restart. |
| `MT5_BRIDGE_OFFLINE` | Your Python MT5 bridge isn't running, or `MT5_BRIDGE_URL` is wrong. |
| `EXNESS_NOT_CONFIGURED` | Exness REST keys unset — use the `mt5` adapter with your Exness MT5 server instead. |
| `Deriv request timed out` | Token lacks the `trade` scope, or the symbol/stake wasn't accepted. |
| Orders return `DRY-…` tickets | You are in dry run. That is intentional; set `DRY_RUN=false` and `TRADING_MODE=live` to arm. |

---

## ⚠️ Risk warning

Trading leveraged instruments such as CFDs, margin FX and crypto derivatives carries a
**high risk of losing money rapidly**. You can lose more than your initial deposit. Past
performance does not guarantee future results, and backtest or demo results do not predict
live outcomes. You are responsible for your own regulatory compliance — including any
licensing, KYC/AML, tax and reporting obligations that apply in your jurisdiction. Trade only
with money you can afford to lose. Nothing in this repository is investment advice.

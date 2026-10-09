# Tradify backend bridge

This local Node.js service connects the Live Trading page to a broker adapter. It binds to
`127.0.0.1` only, does not log credentials or order bodies, and starts in dry-run mode.

## Start the Node service

From the project root:

```bash
cd server
npm install
cp -n .env.example .env   # keep an existing .env intact
npm start
```

Leave the terminal open. It should say `Tradify bridge listening on http://127.0.0.1:8787`.
Check `http://127.0.0.1:8787/health`; `dryRun` should be `true` and `liveArmed` should be
`false`.

Serve the frontend from the project root in a second terminal:

```bash
python3 -m http.server 8090 --bind 127.0.0.1 --directory ../frontend
```

Open `http://localhost:8090/live.html`, switch to Live, and click **Test connection**. The
backend accepts localhost origins by default. Add any other exact browser origin to
`ALLOWED_ORIGINS` in `server/.env`, then restart the Node service.

## Safety switches

The service will not place real orders unless both of these are true:

```env
DRY_RUN=false
TRADING_MODE=live
```

Keep the defaults while setting up. In dry-run mode `/order` validates and records the order,
returns a `DRY-...` ticket, and never invokes an adapter's order method. The Live page has its
own acknowledgement gate. Never expose this credential-holding service to the public internet.

## Broker adapters

### MetaTrader 5

Node connects to a small Python service running beside the MT5 terminal. The Python service
is included as `mt5_bridge.py` and binds to loopback port `5001`. On a Windows machine with
MetaTrader 5 installed:

1. Put a long random value in `MT5_BRIDGE_TOKEN` in `server/.env`. The Python bridge reads it from that file too.
2. Install the official package: `py -m pip install MetaTrader5`.
3. Start the Python bridge: `py mt5_bridge.py` (from this directory).
4. Start the Node backend separately with `npm start`.

The Python bridge requires bearer-token authentication and never prints credentials or
trading payloads. Confirm connectivity in dry-run mode before considering any live routing.

### Exness

Most retail Exness accounts should use the MT5 adapter and the MT5 server name. The optional
Exness adapter only works when you have a custom REST integration that matches this project's
`/v1/account`, `/v1/positions`, and `/v1/orders` request contract. Set `EXNESS_API_BASE` for
that integration. These endpoints are not presented as a universal Exness retail API.

### Deriv

Create a Deriv API token with the required account/trading permissions and enter it on the
Live page. The adapter authenticates, reads `balance` and `portfolio`, then obtains a proposal
and buys the returned contract. For this adapter, form volume is treated as stake in account
currency; duration is fixed at five minutes. Limit/stop orders and SL/TP are rejected because
they do not map to this fixed-duration contract flow.

## API

- `GET /health`
- `POST /connect` with `{ "broker": "mt5|exness|deriv", "credentials": { ... } }`
- `POST /disconnect`
- `GET /account`
- `GET /positions`
- `GET /orders`
- `POST /order` with `{ "symbol", "side", "orderType", "volume", "price?", "sl?", "tp?" }`

Sessions and the latest 200 orders are held in memory and cleared on restart. This is a local
bridge, not a production trading platform; it does not reconcile positions, schedule strategies,
or provide compliance controls.

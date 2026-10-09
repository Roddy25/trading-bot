"use strict";

require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const ADAPTERS = {
  mt5: require("./adapters/mt5"),
  exness: require("./adapters/exness"),
  deriv: require("./adapters/deriv")
};

const PORT = Number(process.env.PORT || 8787);
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const TRADING_MODE = String(process.env.TRADING_MODE || "demo").toLowerCase();
const LIVE_ARMED = !DRY_RUN && TRADING_MODE === "live";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
if (!new Set(["demo", "live"]).has(TRADING_MODE)) throw new Error('TRADING_MODE must be "demo" or "live".');

const app = express();
const session = { broker: null, adapter: null, connectedAt: null, orders: [] };
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function originAllowed(origin) {
  return !origin || localOrigin.test(origin) || ALLOWED_ORIGINS.includes(origin);
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (originAllowed(origin)) return callback(null, true);
    const err = new Error("Origin is not allowed. Add it to ALLOWED_ORIGINS in server/.env.");
    err.status = 403;
    return callback(err);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600
}));
app.use(express.json({ limit: "32kb", strict: true }));

function fail(res, err) {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  res.status(status).json({ error: err.message || "Internal server error", ...(err.code ? { code: err.code } : {}) });
}

function requireSession(res) {
  if (session.adapter) return true;
  fail(res, Object.assign(new Error("No broker connected. Connect an account first."), { status: 401, code: "NO_SESSION" }));
  return false;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalPositive(value, name, problems) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) problems.push(`${name} must be a positive number`);
  return number;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tradify-bridge", mode: TRADING_MODE, dryRun: DRY_RUN,
    liveArmed: LIVE_ARMED, connected: Boolean(session.adapter), broker: session.broker,
    adapters: Object.keys(ADAPTERS), warning: LIVE_ARMED
      ? "LIVE: accepted orders will be sent to the connected broker."
      : "DRY RUN: orders are validated and recorded, never sent to a broker." });
});

app.post("/connect", async (req, res) => {
  const body = req.body;
  if (!isObject(body) || !isObject(body.credentials)) {
    return fail(res, Object.assign(new Error("Request must include broker and credentials object."), { status: 400, code: "VALIDATION" }));
  }
  const broker = String(body.broker || "").toLowerCase();
  const adapter = ADAPTERS[broker];
  if (!adapter) return fail(res, Object.assign(new Error(`Unsupported broker. Choose: ${Object.keys(ADAPTERS).join(", ")}.`), { status: 400, code: "VALIDATION" }));

  try {
    if (session.adapter) await session.adapter.disconnect().catch(() => {});
    session.broker = null;
    session.adapter = null;
    session.connectedAt = null;
    const result = await adapter.connect(body.credentials);
    session.broker = broker;
    session.adapter = adapter;
    session.connectedAt = Date.now();
    let positions = [];
    try { positions = (await adapter.positions()).positions || []; } catch { /* Account connection may succeed without portfolio access. */ }
    return res.json({ connected: true, broker, account: result.account || null, positions });
  } catch (err) {
    session.broker = null;
    session.adapter = null;
    session.connectedAt = null;
    return fail(res, err);
  }
});

app.post("/disconnect", async (_req, res) => {
  try { if (session.adapter) await session.adapter.disconnect(); } catch { /* Clear the local session even if remote disconnect fails. */ }
  session.broker = null;
  session.adapter = null;
  session.connectedAt = null;
  res.json({ disconnected: true });
});

app.get("/account", async (_req, res) => {
  if (!requireSession(res)) return;
  try { res.json(await session.adapter.account()); } catch (err) { fail(res, err); }
});

app.get("/positions", async (_req, res) => {
  if (!requireSession(res)) return;
  try { res.json(await session.adapter.positions()); } catch (err) { fail(res, err); }
});

app.get("/orders", (_req, res) => res.json({ orders: session.orders }));

app.post("/order", async (req, res) => {
  if (!requireSession(res)) return;
  if (!isObject(req.body)) return fail(res, Object.assign(new Error("Order body must be a JSON object."), { status: 400, code: "VALIDATION" }));

  const input = req.body;
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  const side = String(input.side || "").toLowerCase();
  const orderType = String(input.orderType || "market").toLowerCase();
  const volume = Number(input.volume);
  const problems = [];
  if (!symbol || symbol.length > 40) problems.push("symbol is required and must be 40 characters or fewer");
  if (side !== "buy" && side !== "sell") problems.push('side must be "buy" or "sell"');
  if (!Number.isFinite(volume) || volume <= 0) problems.push("volume must be a positive number");
  if (!["market", "limit", "stop"].includes(orderType)) problems.push("orderType must be market, limit or stop");
  const price = optionalPositive(input.price, "price", problems);
  const sl = optionalPositive(input.sl, "stop-loss", problems);
  const tp = optionalPositive(input.tp, "take-profit", problems);
  if (orderType !== "market" && price === null) problems.push("pending orders require a positive price");
  if (problems.length) return res.status(400).json({ error: `Order rejected: ${problems.join("; ")}`, code: "VALIDATION" });

  const order = { symbol, side, orderType, volume, price, sl, tp };
  const record = { ts: Date.now(), broker: session.broker, status: "pending", ...order };
  if (!LIVE_ARMED) {
    record.status = "dry-run";
    record.ticket = `DRY-${require("node:crypto").randomBytes(4).toString("hex").toUpperCase()}`;
    session.orders.unshift(record);
    session.orders.length = Math.min(session.orders.length, 200);
    return res.json({ dryRun: true, accepted: true, ticket: record.ticket,
      message: "Dry run — order validated but NOT sent to the broker.", order });
  }

  try {
    const result = await session.adapter.order(order);
    record.status = "submitted";
    record.ticket = result.ticket || null;
    session.orders.unshift(record);
    session.orders.length = Math.min(session.orders.length, 200);
    return res.json({ dryRun: false, accepted: true, ...result, order });
  } catch (err) {
    record.status = "rejected";
    record.error = err.message;
    session.orders.unshift(record);
    session.orders.length = Math.min(session.orders.length, 200);
    return fail(res, err);
  }
});

app.use((req, res) => res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.path}`, code: "NOT_FOUND" }));
app.use((err, _req, res, _next) => fail(res, err));

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Tradify bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Mode: ${TRADING_MODE}; dry run: ${DRY_RUN}; live armed: ${LIVE_ARMED}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "localhost and 127.0.0.1 only"}`);
  console.log("Broker credentials and order payloads are not logged.");
});

async function shutdown() {
  try { if (session.adapter) await session.adapter.disconnect(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

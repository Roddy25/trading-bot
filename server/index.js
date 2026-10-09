"use strict";

require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });

const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const OrderStore = require("./order-store");
const ADAPTERS = {
  mt5: require("./adapters/mt5"),
  exness: require("./adapters/exness"),
  deriv: require("./adapters/deriv")
};

const PORT = Number(process.env.PORT || 8787);
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";
const TRADING_MODE = String(process.env.TRADING_MODE || "demo").toLowerCase();
const ALLOW_LIVE_TRADING = String(process.env.ALLOW_LIVE_TRADING || "false").toLowerCase() === "true";
const MAX_ORDER_VOLUME = Number(process.env.MAX_ORDER_VOLUME || 0);
const EXECUTION_POLICY_ENABLED = !DRY_RUN && (TRADING_MODE === "demo" || ALLOW_LIVE_TRADING);
const EXECUTION_ENABLED = EXECUTION_POLICY_ENABLED && Number.isFinite(MAX_ORDER_VOLUME) && MAX_ORDER_VOLUME > 0;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:8090,http://127.0.0.1:8090")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const ORDER_STORE = new OrderStore();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
if (!new Set(["demo", "live"]).has(TRADING_MODE)) throw new Error('TRADING_MODE must be "demo" or "live".');

const app = express();
const session = { broker: null, adapter: null, connectedAt: null, account: null, accountMode: null };
let operationQueue = Promise.resolve();
let server = null;

function exclusive(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => {});
  return result;
}

function originAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.includes(origin);
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
    const err = new Error("Origin is not allowed. Add its exact URL to ALLOWED_ORIGINS in server/.env.");
    err.status = 403;
    return callback(err);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  exposedHeaders: ["Idempotency-Key"],
  maxAge: 600
}));
app.use(express.json({ limit: "32kb", strict: true }));

function failure(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function fail(res, err) {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  res.status(status).json({ error: err.message || "Internal server error", ...(err.code ? { code: err.code } : {}) });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function requireSession(res) {
  if (session.adapter) return true;
  fail(res, failure("No broker connected. Connect an account first.", 401, "NO_SESSION"));
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

function normalizedAccountMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["demo", "virtual", "practice"].includes(mode)) return "demo";
  if (["live", "real"].includes(mode)) return "live";
  return null;
}

function publicOrder(record) {
  const { payloadHash, responseBody, ...visible } = record;
  return visible;
}

function sendStoredResponse(res, record, replayed = false) {
  const body = record.responseBody || { orderId: record.id, status: record.status };
  return res.status(record.responseStatus || 200).json({ ...body, ...(replayed ? { replayed: true } : {}) });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tradify-bridge", mode: TRADING_MODE, dryRun: DRY_RUN,
    executionEnabled: EXECUTION_ENABLED, liveTradingAllowed: ALLOW_LIVE_TRADING,
    liveArmed: EXECUTION_ENABLED && TRADING_MODE === "live", connected: Boolean(session.adapter),
    broker: session.broker, accountMode: session.accountMode, adapters: Object.keys(ADAPTERS),
    warning: DRY_RUN ? "DRY RUN: orders are recorded but never sent to a broker."
      : !EXECUTION_POLICY_ENABLED ? "ORDER ROUTING DISABLED: live trading has not been explicitly enabled."
        : !EXECUTION_ENABLED ? "ORDER ROUTING DISABLED: configure a positive MAX_ORDER_VOLUME limit."
          : `EXECUTION ENABLED: ${TRADING_MODE} account orders may be sent to the broker.` });
});

app.post("/connect", asyncRoute((req, res) => exclusive(async () => {
  const body = req.body;
  if (!isObject(body) || !isObject(body.credentials)) {
    return fail(res, failure("Request must include broker and credentials object.", 400, "VALIDATION"));
  }
  const broker = String(body.broker || "").toLowerCase();
  const adapter = ADAPTERS[broker];
  if (!adapter) return fail(res, failure(`Unsupported broker. Choose: ${Object.keys(ADAPTERS).join(", ")}.`, 400, "VALIDATION"));

  try {
    if (session.adapter) await session.adapter.disconnect().catch(() => {});
    Object.assign(session, { broker: null, adapter: null, connectedAt: null, account: null, accountMode: null });
    const result = await adapter.connect(body.credentials);
    const account = result.account || null;
    session.broker = broker;
    session.adapter = adapter;
    session.connectedAt = Date.now();
    session.account = account;
    session.accountMode = normalizedAccountMode(account?.mode);
    let positions = [];
    try { positions = (await adapter.positions()).positions || []; } catch { /* Account connection can succeed without portfolio access. */ }
    return res.json({ connected: true, broker, account, positions });
  } catch (err) {
    Object.assign(session, { broker: null, adapter: null, connectedAt: null, account: null, accountMode: null });
    return fail(res, err);
  }
})));

app.post("/disconnect", asyncRoute((_req, res) => exclusive(async () => {
  try { if (session.adapter) await session.adapter.disconnect(); } catch { /* Clear local state even if remote disconnect fails. */ }
  Object.assign(session, { broker: null, adapter: null, connectedAt: null, account: null, accountMode: null });
  res.json({ disconnected: true });
})));

app.get("/account", asyncRoute(async (_req, res) => {
  if (!requireSession(res)) return;
  try { res.json(await session.adapter.account()); } catch (err) { fail(res, err); }
}));

app.get("/positions", asyncRoute(async (_req, res) => {
  if (!requireSession(res)) return;
  try { res.json(await session.adapter.positions()); } catch (err) { fail(res, err); }
}));

app.get("/orders", (_req, res) => res.json({ orders: ORDER_STORE.list().map(publicOrder) }));

app.get("/orders/:id", (req, res) => {
  const record = ORDER_STORE.get(req.params.id);
  if (!record) return fail(res, failure("Order was not found.", 404, "ORDER_NOT_FOUND"));
  return res.json({ order: publicOrder(record) });
});

app.post("/orders/:id/resolve", asyncRoute((req, res) => exclusive(async () => {
  const record = ORDER_STORE.get(req.params.id);
  if (!record) return fail(res, failure("Order was not found.", 404, "ORDER_NOT_FOUND"));
  if (record.status !== "unknown") return fail(res, failure("Only an unresolved order can be reconciled.", 409, "ORDER_NOT_UNRESOLVED"));
  const outcome = String(req.body?.outcome || "").toLowerCase();
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!note || note.length < 12) return fail(res, failure("Add a reconciliation note of at least 12 characters.", 400, "VALIDATION"));
  if (outcome === "submitted") {
    const ticket = String(req.body?.ticket || "").trim();
    if (!ticket) return fail(res, failure("A broker ticket is required to mark an order submitted.", 400, "VALIDATION"));
    record.status = "submitted";
    record.ticket = ticket;
    record.responseStatus = 200;
    record.responseBody = { dryRun: false, accepted: true, ticket, message: "Order reconciled against the broker.", orderId: record.id, order: record.order };
  } else if (outcome === "rejected" && req.body?.brokerConfirmedAbsent === true) {
    record.status = "rejected";
    record.responseStatus = 409;
    record.responseBody = { error: "Broker history confirmed that this order was not accepted.", code: "ORDER_RECONCILED_REJECTED", orderId: record.id };
  } else {
    return fail(res, failure('Use outcome "submitted" with a broker ticket, or confirm the broker shows no order.', 400, "VALIDATION"));
  }
  record.updatedAt = new Date().toISOString();
  record.reconciliationNote = note;
  await ORDER_STORE.save(record);
  return res.json({ order: publicOrder(record) });
})));

app.post("/order", asyncRoute((req, res) => exclusive(async () => {
  if (!requireSession(res)) return;
  if (!isObject(req.body)) return fail(res, failure("Order body must be a JSON object.", 400, "VALIDATION"));

  const input = req.body;
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  const side = String(input.side || "").toLowerCase();
  const orderType = String(input.orderType || "market").toLowerCase();
  const volume = Number(input.volume);
  const problems = [];
  if (!symbol || symbol.length > 40) problems.push("symbol is required and must be 40 characters or fewer");
  if (side !== "buy" && side !== "sell") problems.push('side must be "buy" or "sell"');
  if (!Number.isFinite(volume) || volume <= 0) problems.push("volume must be a positive number");
  if (!new Set(["market", "limit", "stop"]).has(orderType)) problems.push("orderType must be market, limit or stop");
  const price = optionalPositive(input.price, "price", problems);
  const sl = optionalPositive(input.sl, "stop-loss", problems);
  const tp = optionalPositive(input.tp, "take-profit", problems);
  if (orderType !== "market" && price === null) problems.push("pending orders require a positive price");
  if (problems.length) return fail(res, failure(`Order rejected: ${problems.join("; ")}`, 400, "VALIDATION"));

  const idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return fail(res, failure("A valid Idempotency-Key header is required.", 400, "IDEMPOTENCY_KEY_REQUIRED"));
  }
  const order = { symbol, side, orderType, volume, price, sl, tp };
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify({ broker: session.broker, order })).digest("hex");
  const prior = ORDER_STORE.getByIdempotencyKey(idempotencyKey);
  if (prior) {
    if (prior.payloadHash !== payloadHash) return fail(res, failure("This idempotency key was already used for a different order.", 409, "IDEMPOTENCY_CONFLICT"));
    if (["unknown", "pending"].includes(prior.status)) {
      return res.status(409).json({ error: "This order may still be unresolved. Reconcile it before retrying.", code: "ORDER_UNRESOLVED", orderId: prior.id, status: prior.status });
    }
    return sendStoredResponse(res, prior, true);
  }

  const accountId = String(session.account?.accountId || "unknown");
  if (ORDER_STORE.hasUnresolved()) {
    return fail(res, failure("An earlier order has an unknown outcome. Reconcile it before sending any new order.", 423, "ORDER_UNRESOLVED"));
  }

  const record = {
    id: crypto.randomUUID(), idempotencyKey, payloadHash, broker: session.broker,
    accountId, accountMode: session.accountMode, order, status: "pending",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  if (DRY_RUN) {
    record.status = "dry-run";
    record.ticket = `DRY-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    record.responseBody = { dryRun: true, accepted: true, ticket: record.ticket,
      message: "Dry run — order validated but not sent to the broker.", orderId: record.id, order };
    record.responseStatus = 200;
    record.updatedAt = new Date().toISOString();
    await ORDER_STORE.save(record);
    return sendStoredResponse(res, record);
  }

  if (!EXECUTION_POLICY_ENABLED) {
    record.status = "rejected";
    record.responseStatus = 423;
    record.responseBody = { error: "Order routing is disabled. Keep dry run on, or explicitly enable the selected account mode.", code: "EXECUTION_DISABLED", orderId: record.id };
    record.updatedAt = new Date().toISOString();
    await ORDER_STORE.save(record);
    return sendStoredResponse(res, record);
  }

  if (!Number.isFinite(MAX_ORDER_VOLUME) || MAX_ORDER_VOLUME <= 0) {
    record.status = "rejected";
    record.responseStatus = 423;
    record.responseBody = { error: "Order execution is disabled until MAX_ORDER_VOLUME is set to a positive, broker-appropriate limit.", code: "RISK_LIMIT_NOT_CONFIGURED", orderId: record.id };
    record.updatedAt = new Date().toISOString();
    await ORDER_STORE.save(record);
    return sendStoredResponse(res, record);
  }
  if (volume > MAX_ORDER_VOLUME) {
    record.status = "rejected";
    record.responseStatus = 422;
    record.responseBody = { error: `Order volume exceeds the configured maximum of ${MAX_ORDER_VOLUME}.`, code: "ORDER_LIMIT_EXCEEDED", orderId: record.id };
    record.updatedAt = new Date().toISOString();
    await ORDER_STORE.save(record);
    return sendStoredResponse(res, record);
  }

  if (!session.accountMode || session.accountMode !== TRADING_MODE) {
    record.status = "rejected";
    record.responseStatus = 403;
    record.responseBody = { error: `The connected account mode could not be verified as ${TRADING_MODE}.`, code: "ACCOUNT_MODE_MISMATCH", orderId: record.id };
    record.updatedAt = new Date().toISOString();
    await ORDER_STORE.save(record);
    return sendStoredResponse(res, record);
  }

  // Persist before calling the broker. A process crash from this point onward
  // must be treated as an unresolved outcome after the next startup.
  await ORDER_STORE.save(record);

  try {
    const result = await session.adapter.order(order);
    const ticket = String(result.ticket || "").trim();
    if (!ticket) {
      record.status = "unknown";
      record.responseStatus = 502;
      record.responseBody = { error: "The broker response did not include a ticket. Reconcile before retrying.", code: "ORDER_OUTCOME_UNKNOWN", orderId: record.id };
    } else {
      record.status = "submitted";
      record.ticket = ticket;
      record.responseStatus = 200;
      record.responseBody = { dryRun: false, accepted: true, ticket, message: result.message || "Broker accepted the order.", orderId: record.id, order };
    }
  } catch (err) {
    const isUncertain = !Number.isInteger(err.status) || err.status >= 500 ||
      ["MT5_BRIDGE_OFFLINE", "DERIV_TIMEOUT", "DERIV_UNREACHABLE", "EXNESS_UNREACHABLE"].includes(err.code);
    record.status = isUncertain ? "unknown" : "rejected";
    record.responseStatus = isUncertain ? 502 : (err.status || 400);
    record.responseBody = isUncertain
      ? { error: "The broker outcome is unknown. Check the broker account and reconcile this order before retrying.", code: "ORDER_OUTCOME_UNKNOWN", orderId: record.id }
      : { error: err.message || "Broker rejected the order.", code: err.code || "ORDER_REJECTED", orderId: record.id };
  }

  record.updatedAt = new Date().toISOString();
  await ORDER_STORE.save(record);
  return sendStoredResponse(res, record);
})));

app.use((req, res) => res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.path}`, code: "NOT_FOUND" }));
app.use((err, _req, res, _next) => fail(res, err));

async function shutdown() {
  await exclusive(async () => {
    try { if (session.adapter) await session.adapter.disconnect(); } catch { /* best effort */ }
  });
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

ORDER_STORE.init().then(() => {
  server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Tradify bridge listening on http://127.0.0.1:${PORT}`);
    console.log(`Mode: ${TRADING_MODE}; dry run: ${DRY_RUN}; execution enabled: ${EXECUTION_ENABLED}; max order volume: ${MAX_ORDER_VOLUME || "unset (execution blocked)"}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ") || "none"}`);
    console.log("Order journal is local; broker credentials are not persisted or logged.");
  });
}).catch((err) => {
  console.error(`Could not initialize the order journal: ${err.message}`);
  process.exitCode = 1;
});

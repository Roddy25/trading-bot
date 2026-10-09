"use strict";

// This adapter implements the optional REST contract documented by this project.
// Exness does not provide this generic retail REST interface to every account.
const crypto = require("node:crypto");

let session = null;
const BASE = (process.env.EXNESS_API_BASE || "").replace(/\/+$/, "");

function failure(message, status, code) {
  const err = new Error(message); err.status = status; err.code = code; return err;
}

async function call(path, method = "GET", payload) {
  if (!BASE) throw failure("Direct Exness REST is not configured. For retail accounts, connect through MT5.", 503, "EXNESS_NOT_CONFIGURED");
  if (!session) throw failure("No Exness session. Connect first.", 401, "NO_SESSION");
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac("sha256", session.apiSecret)
    .update(timestamp + method + path + body).digest("hex");
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-EXNESS-APIKEY": session.apiKey,
        "X-EXNESS-TIMESTAMP": timestamp,
        "X-EXNESS-SIGNATURE": signature,
        "X-EXNESS-ACCOUNT": session.accountId
      },
      body: body || undefined,
      signal: AbortSignal.timeout(12_000)
    });
  } catch (cause) {
    throw failure(`Exness REST endpoint unavailable: ${cause.message}`, 502, "EXNESS_UNREACHABLE");
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw failure(data.error || `Exness REST returned HTTP ${response.status}`, response.status, "EXNESS_REJECTED");
  return data;
}

function mapAccount(data = {}) {
  const a = data.account || data;
  return { accountId: String(a.accountId || a.account || session.accountId || "—"),
    currency: a.currency || "USD", balance: Number(a.balance || 0),
    equity: Number(a.equity ?? a.balance ?? 0),
    freeMargin: Number(a.freeMargin ?? a.marginFree ?? 0), leverage: a.leverage || null };
}

module.exports = {
  id: "exness",
  async connect(credentials = {}) {
    if (!credentials.apiKey || !credentials.apiSecret || !credentials.accountId) {
      throw failure("Exness REST requires API key, API secret, and account ID.", 400, "VALIDATION");
    }
    if (!BASE) throw failure("Direct Exness REST is not configured. Most retail accounts should connect through MT5.", 503, "EXNESS_NOT_CONFIGURED");
    session = { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret, accountId: String(credentials.accountId) };
    try { return { account: mapAccount(await call("/v1/account")) }; }
    catch (err) { session = null; throw err; }
  },
  async disconnect() { session = null; return { disconnected: true }; },
  async account() { return { account: mapAccount(await call("/v1/account")) }; },
  async positions() {
    const data = await call("/v1/positions");
    const rows = Array.isArray(data) ? data : data.positions || [];
    return { positions: rows.map((p) => ({ ticket: String(p.id ?? p.ticket ?? ""),
      symbol: p.symbol, side: String(p.side || p.type || "buy").toLowerCase(),
      volume: Number(p.volume ?? p.lots ?? 0), openPrice: p.openPrice ?? p.price,
      currentPrice: p.currentPrice ?? p.markPrice, sl: p.sl ?? null, tp: p.tp ?? null,
      profit: Number(p.profit ?? p.pnl ?? 0) })) };
  },
  async order(order) {
    const data = await call("/v1/orders", "POST", {
      symbol: order.symbol, side: order.side, volume: order.volume,
      orderType: order.orderType, price: order.price, sl: order.sl, tp: order.tp
    });
    return { ticket: String(data.orderId ?? data.id ?? ""), message: data.message || "Exness accepted the order" };
  }
};

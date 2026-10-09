"use strict";

const BASE = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/+$/, "");
const TOKEN = process.env.MT5_BRIDGE_TOKEN || "";

function error(message, status = 502, code = "MT5_BRIDGE_ERROR") {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function call(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000)
    });
  } catch (cause) {
    throw error(`MT5 bridge unavailable at ${BASE}: ${cause.message}`, 502, "MT5_BRIDGE_OFFLINE");
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw error(data.error || `MT5 bridge returned HTTP ${response.status}`, response.status);
  return data;
}

function mapType(order) {
  if (order.orderType === "market") return "market";
  if (order.side === "buy") return order.orderType === "limit" ? "buy_limit" : "buy_stop";
  return order.orderType === "limit" ? "sell_limit" : "sell_stop";
}

function snapshot(data = {}) {
  return {
    accountId: String(data.accountId || data.login || "—"),
    mode: data.mode === "demo" || data.mode === "live" ? data.mode : null,
    currency: data.currency || "USD",
    balance: Number(data.balance || 0),
    equity: Number(data.equity ?? data.balance ?? 0),
    freeMargin: Number(data.freeMargin ?? data.margin_free ?? 0),
    leverage: data.leverage || null
  };
}

module.exports = {
  id: "mt5",
  async connect(credentials = {}) {
    if (!credentials.login || !credentials.password || !credentials.server) {
      const err = error("MT5 requires login, password, and server.", 400, "VALIDATION");
      throw err;
    }
    const data = await call("/connect", "POST", {
      login: credentials.login,
      password: credentials.password,
      server: credentials.server,
      ...(credentials.terminal ? { terminal: credentials.terminal } : {})
    });
    return { account: snapshot(data) };
  },
  async disconnect() { return call("/disconnect", "POST", {}); },
  async account() { return { account: snapshot(await call("/account")) }; },
  async positions() {
    const data = await call("/positions");
    const rows = Array.isArray(data) ? data : data.positions || [];
    return { positions: rows.map((p) => ({
      ticket: String(p.ticket ?? ""), symbol: p.symbol,
      side: String(p.type ?? p.side).toLowerCase().includes("sell") || p.type === 1 ? "sell" : "buy",
      volume: Number(p.volume ?? p.lots ?? 0),
      openPrice: p.price_open ?? p.openPrice,
      currentPrice: p.price_current ?? p.currentPrice,
      sl: p.sl ?? null, tp: p.tp ?? null, profit: Number(p.profit || 0)
    })) };
  },
  async order(order) {
    const data = await call("/order", "POST", {
      symbol: order.symbol, side: order.side, volume: order.volume,
      type: mapType(order), price: order.price, sl: order.sl, tp: order.tp
    });
    return { ticket: String(data.ticket ?? data.order ?? ""), message: data.message || "MT5 accepted the order" };
  }
};

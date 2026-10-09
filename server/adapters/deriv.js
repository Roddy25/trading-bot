"use strict";

const WebSocket = require("ws");

const DEFAULT_URL = process.env.DERIV_API_URL || "wss://ws.derivws.com/websockets/v3";
let socket = null;
let appId = null;
let authorised = null;
let sequence = 0;
const pending = new Map();

function failure(message, status = 502, code = "DERIV_ERROR") {
  const err = new Error(message); err.status = status; err.code = code; return err;
}

function closeSocket() {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(failure("Deriv connection closed.", 502, "DERIV_UNREACHABLE"));
    pending.delete(id);
  }
  if (socket) socket.terminate();
  socket = null;
  appId = null;
  authorised = null;
}

function open(requestedAppId) {
  const selectedAppId = String(requestedAppId || process.env.DERIV_APP_ID || "1089");
  if (socket && socket.readyState === WebSocket.OPEN && appId === selectedAppId) return Promise.resolve(socket);
  if (socket) closeSocket();

  const url = new URL(DEFAULT_URL);
  url.searchParams.set("app_id", selectedAppId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    socket = ws;
    appId = selectedAppId;
    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
        reject(failure("Deriv connection timed out.", 504, "DERIV_TIMEOUT"));
      }
    }, 15_000);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.on("message", (buffer) => {
      let message;
      try { message = JSON.parse(buffer.toString()); } catch { return; }
      const id = message.req_id;
      const entry = id == null ? null : pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(failure(message.error.message || "Deriv rejected the request.", 400, "DERIV_REJECTED"));
      } else entry.resolve(message);
    });
    ws.on("error", (cause) => {
      clearTimeout(timer);
      if (socket === ws) socket = null;
      reject(failure(`Deriv WebSocket unavailable: ${cause.message}`, 502, "DERIV_UNREACHABLE"));
    });
    ws.on("close", () => {
      if (socket === ws) { socket = null; authorised = null; appId = null; }
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(failure("Deriv connection closed.", 502, "DERIV_UNREACHABLE"));
        pending.delete(id);
      }
    });
  });
}

async function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw failure("Deriv is not connected.", 401, "NO_SESSION");
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(failure("Deriv request timed out.", 504, "DERIV_TIMEOUT"));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ ...payload, req_id: id }), (err) => {
      if (!err) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(failure(`Could not send Deriv request: ${err.message}`, 502, "DERIV_UNREACHABLE"));
    });
  });
}

function mapSymbol(input) {
  const symbol = String(input || "").toUpperCase().replaceAll("/", "");
  if (symbol.startsWith("BTC")) return "cryBTCUSD";
  if (symbol.startsWith("ETH")) return "cryETHUSD";
  if (/^[A-Z]{6}$/.test(symbol)) return `frx${symbol}`;
  if (symbol.startsWith("XAU")) return "frxXAUUSD";
  if (symbol.startsWith("XAG")) return "frxXAGUSD";
  return symbol;
}

module.exports = {
  id: "deriv",
  async connect(credentials = {}) {
    if (!credentials.token) throw failure("Deriv requires an API token.", 400, "VALIDATION");
    await open(credentials.appId);
    try {
      const data = await send({ authorize: credentials.token });
      const account = data.authorize || {};
      if (credentials.accountId && String(credentials.accountId) !== String(account.loginid)) {
        throw failure("The authorized Deriv account does not match the account ID entered.", 403, "ACCOUNT_MISMATCH");
      }
      authorised = { loginid: String(account.loginid || credentials.accountId || "—"), currency: account.currency || "USD" };
      return this.account();
    } catch (err) {
      closeSocket();
      throw err;
    }
  },
  async disconnect() { closeSocket(); return { disconnected: true }; },
  async account() {
    if (!authorised) throw failure("No Deriv account connected.", 401, "NO_SESSION");
    const data = await send({ balance: 1 });
    const b = data.balance || {};
    return { account: { accountId: authorised.loginid, currency: b.currency || authorised.currency,
      balance: Number(b.balance || 0), equity: Number(b.balance || 0),
      freeMargin: Number(b.balance || 0), leverage: null } };
  },
  async positions() {
    if (!authorised) throw failure("No Deriv account connected.", 401, "NO_SESSION");
    const data = await send({ portfolio: 1 });
    const rows = data.portfolio?.contracts || [];
    return { positions: rows.map((p) => ({ ticket: String(p.contract_id),
      symbol: p.underlying_symbol || p.symbol || p.display_name,
      side: String(p.contract_type || "CALL").toUpperCase().includes("PUT") ? "sell" : "buy",
      volume: Number(p.buy_price || 0), openPrice: p.entry_spot ?? p.entry_tick,
      currentPrice: p.current_spot, sl: null, tp: null, profit: Number(p.profit || 0) })) };
  },
  async order(order) {
    if (!authorised) throw failure("No Deriv account connected.", 401, "NO_SESSION");
    if (order.orderType !== "market") throw failure("Deriv fixed-duration contracts do not support limit or stop orders in this adapter.", 400, "UNSUPPORTED_ORDER_TYPE");
    if (order.sl != null || order.tp != null) throw failure("Stop-loss and take-profit are not supported by this fixed-duration contract adapter.", 400, "UNSUPPORTED_PROTECTION");
    const symbol = mapSymbol(order.symbol);
    const contractType = order.side === "sell" ? "PUT" : "CALL";
    const stake = Number(order.volume);
    const proposal = await send({ proposal: 1, amount: stake, basis: "stake", contract_type: contractType,
      currency: authorised.currency, duration: 5, duration_unit: "m", symbol });
    const proposalId = proposal.proposal?.id;
    if (!proposalId) throw failure("Deriv did not return a proposal for this symbol and stake.", 400, "PROPOSAL_REJECTED");
    const result = await send({ buy: proposalId, price: Number(proposal.proposal.ask_price || stake) });
    return { ticket: String(result.buy?.contract_id || ""),
      message: `Deriv bought a ${contractType} contract on ${symbol}; volume is treated as stake in ${authorised.currency}.` };
  }
};

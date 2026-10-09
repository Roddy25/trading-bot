"""Loopback-only HTTP adapter for a local MetaTrader 5 terminal.

Install the official MetaTrader5 Python package on a supported Windows machine,
then set MT5_BRIDGE_TOKEN to the same random secret used by the Node bridge.
"""

import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import MetaTrader5 as mt5
except ImportError as exc:
    raise SystemExit("Install the MetaTrader5 Python package first: py -m pip install MetaTrader5") from exc

def load_bridge_token():
    token = os.environ.get("MT5_BRIDGE_TOKEN", "")
    if token:
        return token
    env_file = Path(__file__).with_name(".env")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("MT5_BRIDGE_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


HOST = "127.0.0.1"
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "5001"))
TOKEN = load_bridge_token()
LOCK = threading.RLock()
CONNECTED = False

if not TOKEN:
    raise SystemExit("Set MT5_BRIDGE_TOKEN before starting this service.")


def account_snapshot():
    account = mt5.account_info()
    if account is None:
        raise RuntimeError(f"MT5 account unavailable: {mt5.last_error()}")
    trade_mode = "demo" if account.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO else (
        "live" if account.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL else "contest"
    )
    return {
        "accountId": str(account.login),
        "mode": trade_mode,
        "currency": account.currency,
        "balance": account.balance,
        "equity": account.equity,
        "freeMargin": account.margin_free,
        "leverage": account.leverage,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TradifyMT5Bridge/1.0"

    def log_message(self, _format, *_args):
        # Do not log request bodies, credentials, or account details.
        return

    def send_json(self, status, value):
        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        return hmac.compare_digest(supplied.encode(), expected.encode())

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 65536:
                raise ValueError("Request body is too large.")
            value = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(value, dict):
                raise ValueError("JSON body must be an object.")
            return value
        except (ValueError, json.JSONDecodeError) as exc:
            raise ValueError("Invalid JSON request.") from exc

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "Unauthorized"})
        with LOCK:
            if not CONNECTED:
                return self.send_json(401, {"error": "MT5 terminal is not connected."})
            try:
                if self.path == "/account":
                    return self.send_json(200, account_snapshot())
                if self.path == "/positions":
                    rows = mt5.positions_get()
                    if rows is None:
                        raise RuntimeError(f"Could not read positions: {mt5.last_error()}")
                    return self.send_json(200, {"positions": [
                        {"ticket": str(p.ticket), "symbol": p.symbol,
                         "type": "sell" if p.type == mt5.POSITION_TYPE_SELL else "buy",
                         "volume": p.volume, "price_open": p.price_open,
                         "price_current": p.price_current, "sl": p.sl,
                         "tp": p.tp, "profit": p.profit}
                        for p in rows
                    ]})
                return self.send_json(404, {"error": "Unknown endpoint."})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})

    def do_POST(self):
        global CONNECTED
        if not self.authorized():
            return self.send_json(401, {"error": "Unauthorized"})
        try:
            body = self.read_json()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

        with LOCK:
            try:
                if self.path == "/connect":
                    login = int(body.get("login", 0))
                    password = str(body.get("password", ""))
                    broker_server = str(body.get("server", ""))
                    terminal = str(body.get("terminal", ""))
                    if not login or not password or not broker_server:
                        return self.send_json(400, {"error": "login, password, and server are required."})
                    mt5.shutdown()
                    options = {"login": login, "password": password, "server": broker_server}
                    if terminal:
                        options["path"] = terminal
                    if not mt5.initialize(**options):
                        CONNECTED = False
                        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
                    CONNECTED = True
                    try:
                        snapshot = account_snapshot()
                    except Exception:
                        mt5.shutdown()
                        CONNECTED = False
                        raise
                    return self.send_json(200, snapshot)

                if self.path == "/disconnect":
                    mt5.shutdown()
                    CONNECTED = False
                    return self.send_json(200, {"disconnected": True})

                if not CONNECTED:
                    return self.send_json(401, {"error": "Connect an MT5 account first."})

                if self.path == "/order":
                    symbol = str(body.get("symbol", "")).strip().replace("/", "")
                    side = str(body.get("side", "")).lower()
                    order_type = str(body.get("type", "market")).lower()
                    volume = float(body.get("volume", 0))
                    if not symbol or side not in ("buy", "sell") or volume <= 0:
                        return self.send_json(400, {"error": "Invalid symbol, side, or volume."})
                    info = mt5.symbol_info(symbol)
                    if info is None:
                        return self.send_json(400, {"error": f"Unknown MT5 symbol: {symbol}"})
                    if not info.visible and not mt5.symbol_select(symbol, True):
                        return self.send_json(400, {"error": f"Could not select MT5 symbol: {symbol}"})
                    if volume < info.volume_min or volume > info.volume_max:
                        return self.send_json(400, {"error": f"Volume must be between {info.volume_min} and {info.volume_max}."})
                    steps = round((volume - info.volume_min) / info.volume_step)
                    if abs(info.volume_min + steps * info.volume_step - volume) > 1e-8:
                        return self.send_json(400, {"error": f"Volume must use steps of {info.volume_step}."})

                    mapping = {
                        ("buy", "market"): mt5.ORDER_TYPE_BUY,
                        ("sell", "market"): mt5.ORDER_TYPE_SELL,
                        ("buy", "buy_limit"): mt5.ORDER_TYPE_BUY_LIMIT,
                        ("sell", "sell_limit"): mt5.ORDER_TYPE_SELL_LIMIT,
                        ("buy", "buy_stop"): mt5.ORDER_TYPE_BUY_STOP,
                        ("sell", "sell_stop"): mt5.ORDER_TYPE_SELL_STOP,
                    }
                    key = (side, order_type)
                    if key not in mapping:
                        return self.send_json(400, {"error": "Unsupported MT5 order type."})
                    order_kind = mapping[key]
                    is_market = order_type == "market"
                    tick = mt5.symbol_info_tick(symbol)
                    if tick is None:
                        return self.send_json(502, {"error": f"No current price for {symbol}."})
                    price = (tick.ask if side == "buy" else tick.bid) if is_market else float(body.get("price", 0))
                    if price <= 0:
                        return self.send_json(400, {"error": "A pending order requires a positive price."})

                    request = {
                        "action": mt5.TRADE_ACTION_DEAL if is_market else mt5.TRADE_ACTION_PENDING,
                        "symbol": symbol, "volume": volume, "type": order_kind,
                        "price": round(price, info.digits), "sl": float(body.get("sl") or 0),
                        "tp": float(body.get("tp") or 0), "deviation": 20,
                        "magic": 8787, "comment": "Tradify local bridge",
                        "type_time": mt5.ORDER_TIME_GTC,
                    }
                    if is_market:
                        filling = info.filling_mode
                        if filling & mt5.SYMBOL_FILLING_FOK:
                            request["type_filling"] = mt5.ORDER_FILLING_FOK
                        elif filling & mt5.SYMBOL_FILLING_IOC:
                            request["type_filling"] = mt5.ORDER_FILLING_IOC
                        else:
                            request["type_filling"] = mt5.ORDER_FILLING_RETURN
                    result = mt5.order_send(request)
                    if result is None:
                        raise RuntimeError(f"MT5 order_send failed: {mt5.last_error()}")
                    accepted_codes = {mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL}
                    if result.retcode not in accepted_codes:
                        return self.send_json(400, {"error": f"MT5 rejected order ({result.retcode}): {result.comment}"})
                    ticket = result.order or result.deal
                    return self.send_json(200, {"ticket": str(ticket), "message": "MT5 accepted the order."})

                return self.send_json(404, {"error": "Unknown endpoint."})
            except (ValueError, TypeError) as exc:
                return self.send_json(400, {"error": f"Invalid request value: {exc}"})
            except Exception as exc:
                return self.send_json(502, {"error": str(exc)})


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    server = LocalServer((HOST, PORT), Handler)
    print(f"MT5 bridge listening on http://{HOST}:{PORT}; credentials and orders are not logged.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with LOCK:
            mt5.shutdown()
        server.server_close()

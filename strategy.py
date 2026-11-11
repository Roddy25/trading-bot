"""
strategy.py — multi-timeframe trend-following with momentum and S/R.

The strategy answers one question per market: *is there a high-quality
directional setup right now, and in which direction?* It returns a
:class:`Signal` carrying a score and the reasons behind it.

Scoring
-------
The score is a **confluence count**, not a probability. It is the sum of
weighted conditions that are true. A score of 80 means "most of the things I
look for lined up", NOT "80% chance of winning". The bot never presents it as
a win probability, and neither should any UI built on top of it.

Components (weights sum to 100):
    EMA agreement (1m)         25
    HTF (1h) confirmation      20
    RSI momentum band          15
    S/R reaction               25
    Candlestick confirmation   15

A signal is only actionable when:
  * the 1m trend is not sideways,
  * RSI is inside the configured band,
  * the 1h trend agrees if REQUIRE_HTF_CONFIRMATION,
  * a candle confirmation is present (if REQUIRE_CANDLE_CONFIRMATION),
  * the weighted confluence score meets MIN_SIGNAL_SCORE (S/R is one score
    component, not an unconditional veto).

No look-ahead
-------------
Every input comes from ``CandleSeries.completed()``. The decision is made on
closed bars only, and the entry is assumed to occur at the next bar's open.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from config import Config
from indicators import (
    atr,
    classify_trend,
    ema,
    find_swing_levels,
    is_bearish_rejection,
    is_bullish_rejection,
    is_strong_bearish_close,
    is_strong_bullish_close,
    nearest_level,
    rsi,
)
from logger_config import get_logger
from market_data import Candle, CandleSeries

log = get_logger("strategy")


# Weights — must sum to 100.
W_EMA = 25
W_HTF = 20
W_RSI = 15
W_SR = 25
W_CANDLE = 15
assert W_EMA + W_HTF + W_RSI + W_SR + W_CANDLE == 100


@dataclass
class Signal:
    symbol: str
    index_value: Optional[int]
    direction: str                 # "CALL" (rise) or "PUT" (fall) or "NONE"
    score: int
    reasons: List[str] = field(default_factory=list)
    ema_fast: Optional[float] = None
    ema_mid: Optional[float] = None
    ema_slow: Optional[float] = None
    rsi_value: Optional[float] = None
    atr_value: Optional[float] = None
    support: Optional[float] = None
    resistance: Optional[float] = None
    price: Optional[float] = None
    candle_epoch: Optional[int] = None
    trend_1m: str = "sideways"
    trend_1h: str = "sideways"
    ai_score: Optional[float] = None
    ai_note: str = ""
    strategy_variant: str = "baseline"
    strategy_id: str = "trend_confluence_v1"
    selected_duration: Optional[int] = None
    selected_duration_unit: str = "m"
    contract_type: Optional[str] = None
    price_action: Dict[str, object] = field(default_factory=dict)
    shadow_id: Optional[int] = None

    @property
    def actionable(self) -> bool:
        return (self.direction in ("CALL", "PUT")
                or self.contract_type in ("MULTUP", "MULTDOWN"))

    def summary(self) -> str:
        return (
            f"{self.symbol} {self.direction} score={self.score} "
            f"trend1m={self.trend_1m} trend1h={self.trend_1h} "
            f"rsi={self.rsi_value:.1f}" if self.rsi_value is not None
            else f"{self.symbol} {self.direction} score={self.score}"
        )


class Strategy:
    strategy_id = "trend_confluence_v1"

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    # ------------------------------------------------------------------
    def evaluate(self, symbol: str, series: Dict[str, CandleSeries],
                 index_value: Optional[int] = None,
                 now: Optional[float] = None) -> Signal:
        """Evaluate one market across the three timeframes."""
        s1h, s5m, s1m = series["1h"], series["5m"], series["1m"]

        c1m = s1m.completed(now)
        c5m = s5m.completed(now)
        c1h = s1h.completed(now)

        if not c1m or not c5m or not c1h:
            return Signal(symbol, index_value, "NONE", 0,
                          ["insufficient completed candles"])

        closes_1m = [c.close for c in c1m]
        highs_1m = [c.high for c in c1m]
        lows_1m = [c.low for c in c1m]
        closes_1h = [c.close for c in c1h]

        price = closes_1m[-1]
        last = c1m[-1]

        # --- indicators on 1m -----------------------------------------
        ema_f = ema(closes_1m, self.cfg.ema_fast)
        ema_m = ema(closes_1m, self.cfg.ema_mid)
        ema_s = ema(closes_1m, self.cfg.ema_slow)
        rsi_vals = rsi(closes_1m, self.cfg.rsi_period)
        atr_vals = atr(highs_1m, lows_1m, closes_1m, 14)

        ef, em, es = ema_f[-1], ema_m[-1], ema_s[-1]
        rv = rsi_vals[-1]
        av = atr_vals[-1]

        if ef is None or em is None or es is None or rv is None:
            return Signal(symbol, index_value, "NONE", 0,
                          ["indicators not warmed up"],
                          ema_fast=ef, ema_mid=em, ema_slow=es,
                          rsi_value=rv, price=price,
                          candle_epoch=last.epoch)

        trend_1m = classify_trend(ef, em, es, price)

        # --- 1h context ------------------------------------------------
        ema_f_1h = ema(closes_1h, self.cfg.ema_fast)
        ema_s_1h = ema(closes_1h, self.cfg.ema_slow)
        trend_1h = "sideways"
        if ema_f_1h[-1] is not None and ema_s_1h[-1] is not None:
            if ema_f_1h[-1] > ema_s_1h[-1]:
                trend_1h = "up"
            elif ema_f_1h[-1] < ema_s_1h[-1]:
                trend_1h = "down"

        # --- S/R -------------------------------------------------------
        supports, resistances = find_swing_levels(
            highs_1m, lows_1m, lookback=self.cfg.sr_lookback, strength=2
        )
        sup = nearest_level(price, supports)
        res = nearest_level(price, resistances)

        reasons: List[str] = []
        score = 0

        # --- 1. EMA agreement -----------------------------------------
        if trend_1m == "up":
            score += W_EMA
            reasons.append(f"EMA stack bullish (20>50>200) +{W_EMA}")
        elif trend_1m == "down":
            score += W_EMA
            reasons.append(f"EMA stack bearish (20<50<200) +{W_EMA}")
        else:
            reasons.append("EMA stack sideways/contradictory +0")

        # Direction is decided by the 1m trend. No trend => no trade.
        if trend_1m == "sideways":
            return Signal(
                symbol, index_value, "NONE", score, reasons,
                ema_fast=ef, ema_mid=em, ema_slow=es, rsi_value=rv,
                atr_value=av, support=sup, resistance=res, price=price,
                candle_epoch=last.epoch, trend_1m=trend_1m, trend_1h=trend_1h,
            )

        direction = "CALL" if trend_1m == "up" else "PUT"

        # --- 2. HTF confirmation --------------------------------------
        htf_ok = (trend_1h == trend_1m)
        if htf_ok:
            score += W_HTF
            reasons.append(f"1h trend agrees ({trend_1h}) +{W_HTF}")
        else:
            reasons.append(f"1h trend disagrees ({trend_1h}) +0")

        # --- 3. RSI momentum band -------------------------------------
        rsi_ok = self.cfg.rsi_min <= rv <= self.cfg.rsi_max
        if direction == "PUT":
            # For a fall we want momentum in the lower half of the band.
            rsi_ok = (100 - self.cfg.rsi_max) <= rv <= (100 - self.cfg.rsi_min)
        if rsi_ok:
            score += W_RSI
            reasons.append(f"RSI {rv:.1f} inside momentum band +{W_RSI}")
        else:
            reasons.append(f"RSI {rv:.1f} outside momentum band +0")

        # --- 4. S/R reaction ------------------------------------------
        sr_ok, sr_reason = self._sr_reaction(
            direction, price, last, sup, res, av
        )
        if sr_ok:
            score += W_SR
            reasons.append(f"{sr_reason} +{W_SR}")
        else:
            reasons.append(f"{sr_reason} +0")

        # --- 5. Candlestick confirmation ------------------------------
        candle_ok, candle_reason = self._candle_confirmation(direction, last)
        if candle_ok:
            score += W_CANDLE
            reasons.append(f"{candle_reason} +{W_CANDLE}")
        else:
            reasons.append(f"{candle_reason} +0")

        # --- Gate ------------------------------------------------------
        actionable = True
        if self.cfg.require_htf_confirmation and not htf_ok:
            actionable = False
            reasons.append("BLOCKED: HTF confirmation required")
        if self.cfg.require_candle_confirmation and not candle_ok:
            actionable = False
            reasons.append("BLOCKED: candle confirmation required")
        if score < self.cfg.min_signal_score:
            actionable = False
            reasons.append(
                f"BLOCKED: score {score} < min {self.cfg.min_signal_score}"
            )

        return Signal(
            symbol=symbol,
            index_value=index_value,
            direction=direction if actionable else "NONE",
            score=score,
            reasons=reasons,
            ema_fast=ef, ema_mid=em, ema_slow=es,
            rsi_value=rv, atr_value=av,
            support=sup, resistance=res, price=price,
            candle_epoch=last.epoch,
            trend_1m=trend_1m, trend_1h=trend_1h,
            price_action={
                "setup_key": "|".join((trend_1m, trend_1h,
                    "rsi_low" if rv < 40 else "rsi_mid" if rv < 60 else "rsi_high",
                    "sr_reaction" if sr_ok else "no_sr_reaction",
                    "candle_confirm" if candle_ok else "no_candle_confirm")),
                "trend_1m": trend_1m, "trend_1h": trend_1h,
                "rsi": round(float(rv), 2), "atr": round(float(av), 8) if av is not None else None,
                "sr_reaction": bool(sr_ok), "candle_confirmation": bool(candle_ok),
                "ema_alignment": "bullish" if trend_1m == "up" else "bearish" if trend_1m == "down" else "sideways",
                "candle_body": round(abs(last.close - last.open), 8),
                "candle_range": round(max(0.0, last.high - last.low), 8),
                "close_location": round((last.close - last.low) / max(last.high - last.low, 1e-12), 3),
            },
        )

    # ------------------------------------------------------------------
    def _sr_reaction(self, direction: str, price: float, last: Candle,
                     support: Optional[float], resistance: Optional[float],
                     atr_value: Optional[float]) -> tuple:
        """
        Require a *reaction* at a level, never a bare touch.

        For a CALL: price is testing support and has rejected it (closed back
        above the level, with a bullish rejection or strong close).
        For a PUT: price is testing resistance and has rejected it.

        A "touch" alone — price merely reaching the level — is explicitly not
        enough, because on a random-walk index a touch is noise.
        """
        if atr_value is None or atr_value <= 0:
            return False, "S/R: no ATR for proximity test"

        prox = self.cfg.sr_proximity_atr * atr_value

        if direction == "CALL":
            if support is None:
                return False, "S/R: no support level identified"
            near = abs(price - support) <= prox or (
                last.low <= support + prox and last.close > support
            )
            if not near:
                return False, "S/R: price not at support"
            rejected = (last.close > support
                        and (is_bullish_rejection(last.open, last.high,
                                                  last.low, last.close)
                             or is_strong_bullish_close(last.open, last.high,
                                                        last.low, last.close)))
            if not rejected:
                return False, "S/R: at support but no bullish rejection"
            return True, f"S/R: bullish rejection at support {support:.2f}"

        # PUT
        if resistance is None:
            return False, "S/R: no resistance level identified"
        near = abs(price - resistance) <= prox or (
            last.high >= resistance - prox and last.close < resistance
        )
        if not near:
            return False, "S/R: price not at resistance"
        rejected = (last.close < resistance
                    and (is_bearish_rejection(last.open, last.high,
                                              last.low, last.close)
                         or is_strong_bearish_close(last.open, last.high,
                                                    last.low, last.close)))
        if not rejected:
            return False, "S/R: at resistance but no bearish rejection"
        return True, f"S/R: bearish rejection at resistance {resistance:.2f}"

    # ------------------------------------------------------------------
    def _candle_confirmation(self, direction: str, last: Candle) -> tuple:
        o, h, l, c = last.open, last.high, last.low, last.close
        if direction == "CALL":
            if is_bullish_rejection(o, h, l, c):
                return True, "candle: bullish rejection"
            if is_strong_bullish_close(o, h, l, c):
                return True, "candle: strong bullish close"
            return False, "candle: no bullish confirmation"
        if is_bearish_rejection(o, h, l, c):
            return True, "candle: bearish rejection"
        if is_strong_bearish_close(o, h, l, c):
            return True, "candle: strong bearish close"
        return False, "candle: no bearish confirmation"

    # ------------------------------------------------------------------
    def rank(self, signals: List[Signal]) -> List[Signal]:
        """Actionable signals, strongest first."""
        return sorted(
            [s for s in signals if s.actionable],
            key=lambda s: s.score,
            reverse=True,
        )


class GridSignalStrategy(Strategy):
    """Single-contract, Deriv-compatible adaptation of a range grid.

    It does not place a ladder of pending orders. Instead, it takes at most
    one fixed-expiry Rise/Fall entry when a closed candle rejects an edge of a
    well-defined sideways range. Existing risk controls still govern entry.
    """

    strategy_id = "deriv_grid_range_v1"

    def evaluate(self, symbol: str, series: Dict[str, CandleSeries],
                 index_value: Optional[int] = None,
                 now: Optional[float] = None) -> Signal:
        c1m = series["1m"].completed(now)
        c1h = series["1h"].completed(now)
        if (len(c1m) < max(30, self.cfg.sr_lookback)
                or len(c1h) < self.cfg.ema_slow):
            return Signal(symbol, index_value, "NONE", 0,
                          ["GRID-inspired range: insufficient completed candles"],
                          strategy_id=self.strategy_id)

        lookback = min(self.cfg.sr_lookback, len(c1m))
        window = c1m[-lookback:]
        closes = [c.close for c in c1m]
        highs = [c.high for c in c1m]
        lows = [c.low for c in c1m]
        h1_closes = [c.close for c in c1h]
        ef, em, es = (ema(closes, n)[-1] for n in
                      (self.cfg.ema_fast, self.cfg.ema_mid, self.cfg.ema_slow))
        rv = rsi(closes, self.cfg.rsi_period)[-1]
        av = atr(highs, lows, closes, 14)[-1]
        h1_fast = ema(h1_closes, self.cfg.ema_fast)[-1]
        h1_slow = ema(h1_closes, self.cfg.ema_slow)[-1]
        last = c1m[-1]
        price = last.close
        trend_1m = classify_trend(ef, em, es, price) if None not in (ef, em, es) else "sideways"
        trend_1h = ("up" if h1_fast is not None and h1_slow is not None and h1_fast > h1_slow
                    else "down" if h1_fast is not None and h1_slow is not None and h1_fast < h1_slow
                    else "sideways")
        if rv is None or av is None or av <= 0:
            return Signal(symbol, index_value, "NONE", 0,
                          ["GRID-inspired range: indicators not warmed up"],
                          price=price, candle_epoch=last.epoch,
                          trend_1m=trend_1m, trend_1h=trend_1h,
                          strategy_id=self.strategy_id)

        floor = min(c.low for c in window)
        ceiling = max(c.high for c in window)
        width = ceiling - floor
        near = max(av * 0.35, width * 0.12)
        range_ok = (trend_1m == "sideways" and trend_1h == "sideways"
                    and 2.0 * av <= width <= 8.0 * av)
        at_floor = last.low <= floor + near and price > floor
        at_ceiling = last.high >= ceiling - near and price < ceiling
        rsi_shift = self.cfg.rsi_min - 50.0
        call_rsi_limit = max(5.0, min(95.0, 45.0 - rsi_shift))
        put_rsi_limit = max(5.0, min(95.0, 55.0 + rsi_shift))
        call_rejection = (at_floor and (is_bullish_rejection(
            last.open, last.high, last.low, last.close)
            or is_strong_bullish_close(last.open, last.high,
                                       last.low, last.close)) and rv <= call_rsi_limit)
        put_rejection = (at_ceiling and (is_bearish_rejection(
            last.open, last.high, last.low, last.close)
            or is_strong_bearish_close(last.open, last.high,
                                       last.low, last.close)) and rv >= put_rsi_limit)
        direction = "CALL" if call_rejection else "PUT" if put_rejection else "NONE"
        reasons = [
            ("sideways range and higher timeframe confirmed" if range_ok
             else "range filter blocked: market is not a contained sideways range"),
            (f"price rejected range floor {floor:.5f}" if at_floor else
             f"price rejected range ceiling {ceiling:.5f}" if at_ceiling else
             "price is not at a range edge"),
            f"RSI {rv:.1f}: reversal threshold {'met' if call_rejection or put_rejection else 'not met'}",
            ("closed candle confirms edge rejection" if call_rejection or put_rejection
             else "waiting for a closed-candle reversal at the edge"),
        ]
        if not range_ok:
            direction = "NONE"
        score = (35 + (25 if at_floor or at_ceiling else 0)
                 + (20 if call_rejection or put_rejection else 0)
                 + (20 if range_ok else 0))
        if direction != "NONE" and score < self.cfg.min_signal_score:
            reasons.append(f"BLOCKED: score {score} < range threshold {self.cfg.min_signal_score}")
            direction = "NONE"
        reasons.insert(0, "GRID-inspired single-entry range strategy")
        return Signal(
            symbol, index_value, direction, score, reasons,
            ema_fast=ef, ema_mid=em, ema_slow=es, rsi_value=rv,
            atr_value=av, support=floor, resistance=ceiling, price=price,
            candle_epoch=last.epoch, trend_1m=trend_1m, trend_1h=trend_1h,
            strategy_id=self.strategy_id,
            price_action={"setup_key": f"range_edge_{direction.lower()}",
                          "range_low": floor, "range_high": ceiling,
                          "range_width_atr": round(width / av, 3),
                          "mode": "single_entry_range"},
        )


class DcaPullbackStrategy(Strategy):
    """Single-contract trend-pullback entry inspired by DCA concepts.

    Deriv Rise/Fall contracts cannot average a live position, so this strategy
    waits for a pullback and confirmation before one fixed-expiry entry. It
    never adds contracts to an existing position.
    """

    strategy_id = "deriv_dca_pullback_v1"

    def evaluate(self, symbol: str, series: Dict[str, CandleSeries],
                 index_value: Optional[int] = None,
                 now: Optional[float] = None) -> Signal:
        c1m = series["1m"].completed(now)
        c5m = series["5m"].completed(now)
        c1h = series["1h"].completed(now)
        if (len(c1m) < self.cfg.ema_slow
                or len(c5m) < self.cfg.ema_slow
                or len(c1h) < self.cfg.ema_slow):
            return Signal(symbol, index_value, "NONE", 0,
                          ["DCA-inspired pullback: insufficient completed candles"],
                          strategy_id=self.strategy_id)

        closes = [c.close for c in c1m]
        highs = [c.high for c in c1m]
        lows = [c.low for c in c1m]
        last = c1m[-1]
        price = last.close
        ef, em, es = (ema(closes, n)[-1] for n in
                      (self.cfg.ema_fast, self.cfg.ema_mid, self.cfg.ema_slow))
        rv = rsi(closes, self.cfg.rsi_period)[-1]
        av = atr(highs, lows, closes, 14)[-1]
        c5 = [c.close for c in c5m]
        c1h_close = [c.close for c in c1h]
        tf5_fast, tf5_slow = ema(c5, self.cfg.ema_fast)[-1], ema(c5, self.cfg.ema_slow)[-1]
        tf1h_fast, tf1h_slow = ema(c1h_close, self.cfg.ema_fast)[-1], ema(c1h_close, self.cfg.ema_slow)[-1]
        trend_1m = classify_trend(ef, em, es, price) if None not in (ef, em, es) else "sideways"
        trend_1h = ("up" if tf1h_fast is not None and tf1h_slow is not None and tf1h_fast > tf1h_slow
                    else "down" if tf1h_fast is not None and tf1h_slow is not None and tf1h_fast < tf1h_slow
                    else "sideways")
        if rv is None or av is None or av <= 0 or ef is None or em is None:
            return Signal(symbol, index_value, "NONE", 0,
                          ["DCA-inspired pullback: indicators not warmed up"],
                          price=price, candle_epoch=last.epoch,
                          trend_1m=trend_1m, trend_1h=trend_1h,
                          strategy_id=self.strategy_id)

        trend_ok = (trend_1m == trend_1h and trend_1m in ("up", "down")
                    and tf5_fast is not None and tf5_slow is not None
                    and ((trend_1m == "up" and tf5_fast > tf5_slow)
                         or (trend_1m == "down" and tf5_fast < tf5_slow)))
        if trend_1m == "up":
            direction = "CALL"
            pullback = last.low <= ef + av * 0.25 and price > ef
            candle_ok = (is_bullish_rejection(last.open, last.high, last.low, last.close)
                         or is_strong_bullish_close(last.open, last.high, last.low, last.close))
            rsi_low = max(0.0, 42.0 + self.cfg.rsi_min - 50.0)
            rsi_high = min(100.0, 65.0 + self.cfg.rsi_max - 70.0)
            rsi_ok = rsi_low <= rv <= rsi_high
        elif trend_1m == "down":
            direction = "PUT"
            pullback = last.high >= ef - av * 0.25 and price < ef
            candle_ok = (is_bearish_rejection(last.open, last.high, last.low, last.close)
                         or is_strong_bearish_close(last.open, last.high, last.low, last.close))
            rsi_low = max(0.0, 35.0 + self.cfg.rsi_min - 50.0)
            rsi_high = min(100.0, 58.0 + self.cfg.rsi_max - 70.0)
            rsi_ok = rsi_low <= rv <= rsi_high
        else:
            direction = "NONE"
            pullback = candle_ok = rsi_ok = False
        score = (35 + (25 if trend_ok else 0) + (20 if pullback else 0)
                 + (10 if candle_ok else 0) + (10 if rsi_ok else 0))
        reasons = [
            "DCA-inspired single-entry trend-pullback strategy",
            f"trend 1m={trend_1m}, 1h={trend_1h}; 5m confirmation {'agrees' if trend_ok else 'blocked'}",
            ("closed candle pulled back to EMA and recovered" if pullback
             else "no confirmed pullback to EMA yet"),
            ("closed candle confirms trend continuation" if candle_ok
             else "waiting for trend continuation candle"),
            f"RSI {rv:.1f}: pullback band {'met' if rsi_ok else 'not met'}",
        ]
        if not (trend_ok and pullback and candle_ok and rsi_ok):
            direction = "NONE"
        if direction != "NONE" and score < self.cfg.min_signal_score:
            reasons.append(f"BLOCKED: score {score} < pullback threshold {self.cfg.min_signal_score}")
            direction = "NONE"
        return Signal(
            symbol, index_value, direction, score, reasons,
            ema_fast=ef, ema_mid=em, ema_slow=es, rsi_value=rv,
            atr_value=av, price=price, candle_epoch=last.epoch,
            trend_1m=trend_1m, trend_1h=trend_1h,
            strategy_id=self.strategy_id,
            price_action={"setup_key": f"trend_pullback_{direction.lower()}",
                          "mode": "single_entry_trend_pullback",
                          "pullback_to_ema_fast": bool(pullback),
                          "trend_confirmed": bool(trend_ok)},
        )


class BoomCrashStrategy:
    """Fade a completed spike toward the index's usual between-spike drift.

    Boom indices spike upward and tend to drift down between spikes; Crash
    indices spike downward and tend to drift up. This strategy waits for a
    large, closed 1m candle, then takes a small fixed-multiplier contract in
    the opposite direction. It does not claim to predict when spikes occur.
    """

    strategy_id = "boom_crash_spike_fade_v1"

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def evaluate(self, symbol: str, series: Dict[str, CandleSeries],
                 index_value: Optional[int] = None,
                 now: Optional[float] = None) -> Signal:
        market = symbol.upper()
        if market.startswith("BOOM"):
            direction, contract_type, spike_direction, drift = (
                "PUT", "MULTDOWN", 1, "down"
            )
            family = "Boom"
        elif market.startswith("CRASH"):
            direction, contract_type, spike_direction, drift = (
                "CALL", "MULTUP", -1, "up"
            )
            family = "Crash"
        else:
            return Signal(symbol, index_value, "NONE", 0,
                          ["not a Boom/Crash market"])

        c1m = series["1m"].completed(now)
        if len(c1m) < 31:
            return Signal(symbol, index_value, "NONE", 0,
                          ["Boom/Crash spike study needs 31 completed 1m candles"])

        previous, last = c1m[-31:-1], c1m[-1]
        prior_bodies = [abs(c.close - c.open) for c in previous]
        prior_ranges = [max(0.0, c.high - c.low) for c in previous]
        median_body = statistics.median(prior_bodies)
        median_range = statistics.median(prior_ranges)
        body = abs(last.close - last.open)
        full_range = max(0.0, last.high - last.low)
        sign = 1 if last.close > last.open else -1 if last.close < last.open else 0
        body_ratio = body / full_range if full_range else 0.0
        threshold = max(4.5, min(
            8.0, 6.0 + (self.cfg.min_signal_score - 60) * 0.08
        ))
        body_multiple = body / median_body if median_body > 0 else 0.0
        is_spike = (
            sign == spike_direction
            and body_ratio >= 0.60
            and body >= max(median_body * threshold, median_range * 1.8)
        )
        score = min(100, int(65 + max(0.0, body_multiple - threshold) * 8))
        reasons = [
            f"{family} spike-fade strategy",
            f"latest body {body_multiple:.1f}x prior median; threshold {threshold:.1f}x",
            f"expected between-spike drift: {drift}",
            (f"confirmed closed spike; candidate {direction}" if is_spike
             else "waiting for a confirmed spike candle"),
        ]
        return Signal(
            symbol=symbol, index_value=index_value,
            direction=direction if is_spike else "NONE",
            score=score if is_spike else 0, reasons=reasons,
            price=last.close, candle_epoch=last.epoch,
            trend_1m=drift, trend_1h="spike-fade",
            contract_type=contract_type if is_spike else None,
            price_action={
                "setup_key": f"{family.lower()}_spike_fade|body_{'extreme' if body_multiple >= threshold * 1.5 else 'large'}|range_{'wide' if median_range and full_range >= median_range * 2 else 'normal'}",
                "family": family, "spike_direction": "up" if sign > 0 else "down" if sign < 0 else "flat",
                "drift_direction": drift, "body_multiple": round(body_multiple, 3),
                "body_ratio": round(body_ratio, 3), "median_body": round(median_body, 8),
                "median_range": round(median_range, 8), "threshold": round(threshold, 3),
            },
        )


def strategy_for_market(symbol: str, cfg: Config):
    """Select the configured Deriv signal model, retaining Boom/Crash routing."""
    if symbol.upper().startswith(("BOOM", "CRASH")):
        return BoomCrashStrategy(cfg)
    if cfg.deriv_strategy_mode == "grid":
        return GridSignalStrategy(cfg)
    if cfg.deriv_strategy_mode == "dca":
        return DcaPullbackStrategy(cfg)
    return Strategy(cfg)

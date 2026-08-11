# Quant Hub V5.2 — Dual Spot Strategy Lab

V5.2 remains SPOT ONLY: no futures, no leverage, no short selling.

## New strategy profiles

### EXHAUSTION_SCALP_SPOT (default)
Alpha-style oversold/exhaustion entry. Short-term bearish MACD, EMA9/21 and below-VWAP conditions are allowed; they can be part of the dip rather than automatic rejection reasons.

Positive evidence includes:
- Stochastic oversold
- Williams %R oversold
- CCI oversold
- MFI oversold
- RSI cooled down
- price near/below lower Bollinger region
- SMA20 >= SMA50 medium structure
- ADX as trend-strength context
- optional oscillator turn-up

Risk penalties include:
- bearish/CHOCH structure
- large bearish ATR candle
- liquidation-like relative-volume spike
- sharp 3-candle breakdown
- excessive distance below support
- extreme ATR/Bollinger expansion

The strategy buys only spot and returns to cash on exit.

### TREND_PULLBACK_SPOT
Established uptrend + controlled pullback + reversal confirmation. V5.2 explicitly prevents overbought Stochastic/RSI setups from being classified as strong pullback entries.

### Control profiles
- RESEARCH_SPOT
- V4_REGIME_SPOT
- V3_BASELINE
- legacy PULLBACK_SPOT remains supported internally for old saved runs

## Live dashboard
Tech Signals now has a Strategy selector. Auto Portfolio uses the same currently selected Tech Signals strategy and BUY/STRONG BUY pool.

Recommended starting research:
- EXHAUSTION_SCALP_SPOT: 5m and 15m, TP2 initially
- TREND_PULLBACK_SPOT: 30m and 1h, TP2/TP3

## Research CSV additions
Per-trade CSV now includes CCI, MFI, Williams %R, ROC9, SMA20/SMA50, exhaustion score, raw oversold score, breakdown penalty, Bollinger position, previous Stochastic/Williams values, oscillator direction and breakdown diagnostics.

Do not add DCA until the entry profiles are validated independently. Conditional capped DCA can then be backtested as a separate layer.

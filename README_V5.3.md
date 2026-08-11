# Quant Hub V5.3 — Pullback Validity Gates + Separate Breakout Model

V5.3 remains **SPOT ONLY**: no futures, leverage, or short selling.

## Main changes

### TREND_PULLBACK_SPOT
Hard validity gates now run before score thresholds. A high score cannot override a bad location.

Required before a pullback BUY can qualify:
- EMA21 > EMA50
- price > EMA50
- EMA21 rising
- ADX >= 22
- structure is not CHOP or bearish/CHOCH
- price is near EMA21/VWAP now, or recently retested one and is still close
- pullback depth >= 0.6% and at least 2 bars since the local high
- no upper-Bollinger / CCI / excessive VWAP extension
- Stochastic <= 72 and RSI <= 68
- reversal confirmation and usable relative volume

STRONG BUY is stricter: ADX >= 25, better location/confirmation, RSI <= 64, Stoch <= 62, CCI <= 125 and BB position <= 0.90.

### MOMENTUM_BREAKOUT_SPOT
Breakouts are now their own profile instead of being mislabeled as pullbacks. It requires a fresh break of the prior 20-bar high plus trend, ADX, volume, momentum and extension checks.

### EXHAUSTION_SCALP_SPOT
Kept as a separate oversold-reversal strategy.

## Research exports
Per-trade CSV now records `setup_type`, `breakout_score`, ATR distance to EMA21/VWAP/recent high, and each pullback hard-gate result.

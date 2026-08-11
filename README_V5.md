# Quant Hub V5.0 — Spot Trend Pullback

V5 replaces the default "everything is bullish, buy now" entry model with a spot-only trend-pullback model.

## Default profile: PULLBACK_SPOT

A BUY now requires three things:

1. Established trend
   - EMA21 > EMA50
   - price above EMA50
   - EMA21 rising
2. Useful pullback location
   - price retraced from a recent high
   - price is near/touched EMA21 or VWAP
   - RSI cooled before the entry
3. Upward-turn confirmation
   - RSI starts rising
   - MACD histogram improves
   - price closes back above EMA9
   - bullish candle confirmation

Extreme extension, bearish structure, excessive RSI, extreme RVOL and extreme volatility reduce or block entries.

BTC higher-timeframe regime remains in the live and historical exports as context, but PULLBACK_SPOT does not use BTC regime as a hard entry gate.

## Research profiles retained

- PULLBACK_SPOT — V5 default
- RESEARCH_SPOT — broad V3-style signal sample
- V4_REGIME_SPOT — strict V4 control
- V3_BASELINE — original control

## New CSV features

Per-trade research exports now include:
- EMA21/EMA50 distance %
- VWAP distance %
- distance from recent high/low
- pullback depth %
- bars since local high
- EMA21 3-bar slope
- RSI current + previous 2 values + deltas
- MACD histogram current/previous/delta
- previous 3 candle returns
- recent EMA21/VWAP touch flags
- trend-state score
- pullback-quality score
- reversal-confirmation score
- participation score
- extension penalty

The sequential coin-by-coin research workflow from V4.9 is preserved.

See README_V5.2.md for the current dual-strategy changes.

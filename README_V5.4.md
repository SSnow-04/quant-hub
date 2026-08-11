# Quant Hub V5.4 — Timeframe-Specific Edge Model

V5.4 remains **SPOT ONLY**: no futures, leverage, or short selling.

## What changed

The previous universal BUY/STRONG BUY score was replaced by a timeframe-specific profile:

- **30m — EXHAUSTION_REVERSAL_30M**
  - Controlled 3-bar decline, moderate (not maximum) exhaustion, RVOL participation, useful ATR window, no accelerating breakdown, and early reversal evidence.
- **1h — CONTROLLED_TREND_1H**
  - EMA21/EMA50 trend, ADX strength, non-CHOP structure, VWAP support, no chase, and acceptable participation.
- **4h — TREND_CONTINUATION_4H**
  - Strong trend/structure first; a textbook EMA/VWAP pullback is not required. CHOP is rejected.
- **5m — ENTRY_CONFIRMATION_5M**
  - Confirmation-only in the new profile. It cannot independently open a trade.

The older profiles are still available as control groups.

## Research-oriented design

The thresholds are intentionally broad and rounded. They reflect the uploaded research batches but are not tuned to exact decimal cutoffs from one short interval.

Every sequential research run now additionally writes `signal_study_summary.csv`, which breaks trade performance down by:

- setup type
- BUY vs STRONG BUY
- SMC structure
- VWAP state
- BTC regime
- ADX band
- RVOL band
- ATR band
- exhaustion band
- Stochastic band
- recent 3-bar return band
- bullish candle
- Stochastic rising
- Williams %R rising
- selloff deceleration
- edge-quality band

This makes it possible to see which signals are adding edge and which are hurting the model without manually merging every per-coin CSV first.

## Faster historical research

Historical fetching now defaults to:

- up to 3 scheduled historical requests in flight
- 90 ms minimum global request-start gap
- 1000-candle pages
- 120 warmup candles

The sequential per-coin research behavior is unchanged: one coin is completed and saved before the next coin is processed.

Environment variables can still lower load if Binance/network conditions require it:

- `HISTORICAL_CONCURRENCY`
- `HISTORICAL_MIN_GAP_MS`
- `HISTORICAL_PAGE_SIZE`
- `RESEARCH_WARMUP_CANDLES`
- `BINANCE_HISTORICAL_TIMEOUT_MS`

## Important

DCA is intentionally not part of this research update. First validate that the new entry model improves win rate, net P/L, profit factor, and drawdown across independent periods. Conditional DCA can then be tested as a separate variable.

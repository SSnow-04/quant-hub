# Changelog

## V5.16 — Looser 30m Dual-Path Router
- Added 30m `RECOVERY BUY` and `TREND CONTINUATION BUY` paths.
- Lowered the recovery score threshold modestly while retaining bearish breakdown vetoes.
- Bullish EMA/VWAP/structure/MACD/UT/cloud evidence can now qualify a 30m continuation entry without a fresh exhaustion event.
- Overbought conditions become penalties or `EXTENDED / WAIT FOR DIP` rather than universal rejection.
- Kronos is no longer a mild bearish veto on 30m. Only high-confidence, materially bearish forecasts can downgrade a technical BUY.
- Bullish Kronos can promote a technically supported 30m WATCH state to `EARLY TREND BUY + KRONOS`.
- Spot-only behavior retained. No shorts, futures, or leverage.

## V5.16 — Timeframe Router + Kronos
- Added optional local Kronos Python forecasting service.
- Added Windows/Linux setup and start scripts.
- Added `/api/kronos/status` health endpoint.
- Live screener now displays Kronos direction, forecast return, and score.
- Kronos forecast is a bounded overlay, never an unrestricted trade generator.
- 30m Recovery Reversal remains conservative and Kronos can only confirm/downgrade it.
- 1h+ timeframe logic changed from all-or-nothing gates to weighted technical evidence with hard bearish vetoes only.
- Overbought/extended higher-timeframe trends now become `EXTENDED / WAIT FOR DIP` rather than automatically disappearing into CASH.
- Added `TREND BUY + KRONOS`, `WATCH / BULLISH`, and extended-state behavior.
- Spot-only constraint retained.

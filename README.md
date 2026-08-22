# Institutional Quant Hub V5.16 — Timeframe Router + Kronos

Spot-only research and paper-trading build. No futures, leverage, or short selling.

## What changed

V5.16 keeps the validated 30m Recovery Reversal logic conservative, but makes 1h+ continuation logic weighted instead of binary. High RSI/Stoch now usually means **EXTENDED / WAIT FOR DIP**, not automatic rejection.

Live Timeframe Edge signals can also use **Kronos** as an optional forecast overlay. Kronos never has unlimited authority: it can confirm/downgrade existing setups and can promote a technically bullish higher-timeframe WATCH/CASH setup only when enough technical evidence is already present.

Live states include:
- STRONG BUY
- TREND BUY
- BUY
- WATCH / BULLISH
- EXTENDED / WAIT FOR DIP
- CASH / NO ENTRY
- AVOID / CASH

## Start Quant Hub

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

## Enable Kronos

Kronos is optional. Quant Hub runs normally if the service is offline.

Requirements: Python 3.10+, Git, internet for first model download. A CUDA GPU is strongly preferred but CPU mode is supported and slower.

```powershell
cd kronos-service
.\setup-kronos.ps1
.\start-kronos.ps1
```

Then start Quant Hub in another terminal. After first setup you can also run:

```powershell
.\start-v5.15.ps1
```

Kronos defaults:
- model: `NeoQuasar/Kronos-small`
- tokenizer: `NeoQuasar/Kronos-Tokenizer-base`
- service: `http://127.0.0.1:8765`
- lookback: 192 candles
- probabilistic samples: 3

Environment variables:

```text
KRONOS_ENABLED=true
KRONOS_URL=http://127.0.0.1:8765
KRONOS_MODEL=NeoQuasar/Kronos-small
KRONOS_TOKENIZER=NeoQuasar/Kronos-Tokenizer-base
KRONOS_DEVICE=auto
KRONOS_LOOKBACK=192
KRONOS_SAMPLE_COUNT=3
```

Check `http://localhost:3000/api/kronos/status` to see whether the model service is available.

## How Kronos is used

The Python service forecasts the next few candles from OHLCV. Quant Hub converts the forecast to a bounded score and combines it with the technical score.

- 30m: two entry paths are available: Recovery Reversal and Trend Continuation. Kronos is supporting evidence and may promote a technically bullish WATCH state; only strong high-confidence bearish forecasts can downgrade an existing BUY.
- 5m/15m: Kronos can strengthen a real trigger/watch state but cannot create a trade from a completely invalid setup.
- 1h+: a bullish Kronos forecast can promote a technically bullish WATCH/CASH state into `TREND BUY + KRONOS` when at least four technical confirmations are already present.
- A bearish Kronos forecast with meaningful confidence can downgrade a BUY to WATCH.

This is intentionally conservative: Kronos is a forecasting feature, not a guaranteed alpha source.

## Timeframe routing

1m/3m execution only; 5m entry trigger; 15m trend pullback/reclaim; 30m recovery reversal; 1h controlled trend; 2h swing pullback; 4h/6h/8h trend continuation; 12h macro pullback; 1d/3d/1w macro/position trend.


## V5.16 looser 30m router
30m no longer requires every opportunity to come from a fresh exhaustion/reclaim sequence. It accepts either a recovery entry or a technically healthy trend-continuation entry. Oscillator extension is mainly a penalty/watch state rather than an automatic rejection.

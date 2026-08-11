# Quant Hub V4.9 — Sequential Per-Coin Research

V4.9 changes the historical research runner to a strict sequential workflow.

1. Choose interval, timeframe, budget, strategy profile, TP mode, and universe.
2. The server builds the eligible Binance spot universe.
3. It loads BTC benchmark history once for the interval.
4. It takes exactly ONE coin at a time.
5. For that coin it downloads the complete interval plus warm-up candles, scans candle-by-candle, opens spot positions on valid BUY signals, exits, waits, and re-enters on later valid BUY signals until the end.
6. Immediately after the coin finishes, its own CSV is written to `research_exports/<run-id>/`.
7. Only after the CSV is safely saved does the runner move to the next coin.
8. NO_SIGNALS and DATA_ERROR coins also receive CSV files.
9. `coin_summary.csv` and `run_manifest.json` are updated after every coin.
10. At completion the server creates `all_coin_results.zip` containing all per-coin CSV files and the summary/manifest.

The browser polls job progress, so the long research job does not depend on keeping one huge HTTP request open.

This remains spot-only: no futures, no leverage, no short entries.

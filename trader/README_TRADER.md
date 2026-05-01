Algo Trading Bot (Backtesting + Strategies)

Overview
- Python backtesting toolkit with three retail‑friendly strategies:
  - 200DMA Trend Filter (monthly)
  - Dual Momentum Rotation (monthly)
  - RSI(2) Mean Reversion (daily)
- Pluggable data via Yahoo Finance (yfinance)
- CLI to run backtests with configurable universes/params

Quick Start
1) Create a Python 3.10+ virtualenv
2) Install dependencies: `pip install -r trader/requirements.txt`
3) Run sample backtests:
   - 200DMA Trend on SPY: `python -m trader.cli sma200 --symbol SPY --start 2005-01-01`
   - Dual Momentum (SPY, EFA) with AGG fallback: `python -m trader.cli dual-momentum --symbols SPY EFA --fallback AGG --start 2005-01-01`
   - RSI(2) Mean Reversion on US large caps: `python -m trader.cli rsi2 --universe-file trader/sample_data/sp100.txt --start 2010-01-01`

Using Your Own Dataset (CSV)
- Ingest from Yahoo to a cache:
  `python -m trader.cli ingest-yf SPY QQQ EFA AGG --start 2000-01-01 --out data_cache`
- Backtest using cached CSVs (no network): add `--csv-folder data_cache` to commands, e.g.:
  `python -m trader.cli sma200 --symbol SPY --start 2005-01-01 --csv-folder data_cache`
- You can also drop your own CSVs into the cache folder. Expected format per file: `SYMBOL.csv` with columns `Date,Open,High,Low,Close,Adj Close,Volume` (Adj Close optional; Close is used if missing).

Compare Strategies Side-by-Side
- With Yahoo (on-the-fly):
  `python -m trader.cli compare --start 2005-01-01 --sma-symbol SPY --dm-symbols SPY EFA --dm-fallback AGG --rsi-universe-file trader/sample_data/sp100.txt`
- With cached CSVs:
  `python -m trader.cli compare --csv-folder data_cache --start 2005-01-01 --sma-symbol SPY --dm-symbols SPY EFA --dm-fallback AGG --rsi-universe-file trader/sample_data/sp100.txt`

Notes
- Backtests use adjusted close and execute signals at next day open approximation (applied using next day returns) to avoid look‑ahead.
- Transaction costs modeled via `--fees-bps` and `--slippage-bps` applied on turnover at rebalances.
- Results include equity curve and summary stats printed to console; CSV outputs can be enabled with `--out`.

Next Steps
- Wire a paper/live broker once broker API is chosen (e.g., Zerodha/Angel/Alpaca/Binance).
- Add parameterized configs and plotting as needed.

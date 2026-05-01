from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import typer
from rich.console import Console
from tabulate import tabulate

from .backtester import backtest_from_weights
from .data import align_prices, download_history
from .datasets import load_prices_csv, save_prices_csv
from .strategies.dual_momentum import DualMomentumConfig, generate_weights as gen_dm
from .strategies.rsi2_mean_reversion import RSI2Config, generate_weights as gen_rsi2
from .strategies.sma200_trend import SMA200Config, generate_weights as gen_sma200


app = typer.Typer(add_completion=False)
console = Console()


def print_stats(stats: dict):
    percent_keys = {"Total Return", "CAGR", "Volatility", "Max Drawdown"}
    ratio_keys = {"Sharpe", "Calmar"}
    rows = []
    for k, v in stats.items():
        if k in percent_keys:
            rows.append((k, f"{v:.2%}"))
        elif k in ratio_keys:
            rows.append((k, f"{v:.2f}"))
        else:
            rows.append((k, v))
    console.print(tabulate(rows, headers=["Metric", "Value"], tablefmt="simple"))


@app.command(name="ingest-yf")
def ingest_yf(
    symbols: List[str] = typer.Argument(..., help="Symbols to download (space-separated)"),
    start: str = typer.Option("2000-01-01", help="Start date (YYYY-MM-DD)"),
    end: Optional[str] = typer.Option(None, help="End date (YYYY-MM-DD)"),
    out: Path = typer.Option(Path("data_cache"), help="Folder to store CSV files"),
):
    data = download_history(symbols, start=start, end=end, progress=True)
    save_prices_csv(data, out)
    console.print(f"Saved {len(data)} symbols to {out}")


def maybe_load_data(symbols: List[str], start: str, end: Optional[str], csv_folder: Optional[Path]):
    if csv_folder:
        return load_prices_csv(symbols, csv_folder)
    return download_history(symbols, start=start, end=end)


@app.command()
def sma200(
    symbol: str = typer.Option(..., help="Symbol to trade (e.g., SPY)"),
    start: str = typer.Option("2000-01-01", help="Backtest start date"),
    end: Optional[str] = typer.Option(None, help="Backtest end date"),
    window: int = typer.Option(200, help="SMA window"),
    fees_bps: float = typer.Option(1.0, help="Fees (bps) per turnover"),
    slippage_bps: float = typer.Option(0.0, help="Slippage (bps) per turnover"),
    out: Optional[Path] = typer.Option(None, help="Optional CSV output folder"),
    csv_folder: Optional[Path] = typer.Option(None, help="Optional CSV cache folder to load prices from"),
):
    data = maybe_load_data([symbol], start=start, end=end, csv_folder=csv_folder)
    cfg = SMA200Config(symbol=symbol, window=window)
    weights = gen_sma200(data, cfg)
    prices = align_prices(data)
    res = backtest_from_weights(prices, weights, fees_bps=fees_bps, slippage_bps=slippage_bps)
    console.print(f"200DMA Trend Filter on {symbol}")
    print_stats(res.stats)
    if out:
        out.mkdir(parents=True, exist_ok=True)
        res.equity.to_csv(out / "equity.csv")
        res.weights.to_csv(out / "weights.csv")
        res.trades.to_csv(out / "trades.csv")


@app.command(name="dual-momentum")
def dual_momentum(
    symbols: List[str] = typer.Argument(..., help="Symbols to rank, e.g., SPY EFA QQQ"),
    fallback: Optional[str] = typer.Option(None, help="Fallback symbol when no positive momentum (e.g., AGG)"),
    start: str = typer.Option("2000-01-01", help="Backtest start date"),
    end: Optional[str] = typer.Option(None, help="Backtest end date"),
    lookback_days: int = typer.Option(252, help="Momentum lookback in trading days (~252 for 12m)"),
    top_n: int = typer.Option(1, help="Number of top assets to hold"),
    fees_bps: float = typer.Option(1.0, help="Fees (bps) per turnover"),
    slippage_bps: float = typer.Option(0.0, help="Slippage (bps) per turnover"),
    out: Optional[Path] = typer.Option(None, help="Optional CSV output folder"),
    csv_folder: Optional[Path] = typer.Option(None, help="Optional CSV cache folder to load prices from"),
):
    all_syms = list(symbols)
    if fallback:
        all_syms.append(fallback)
    data = maybe_load_data(all_syms, start=start, end=end, csv_folder=csv_folder)
    cfg = DualMomentumConfig(symbols=list(symbols), fallback=fallback, lookback_days=lookback_days, top_n=top_n)
    weights = gen_dm(data, cfg)
    prices = align_prices(data)
    res = backtest_from_weights(prices, weights, fees_bps=fees_bps, slippage_bps=slippage_bps)
    console.print(f"Dual Momentum on {', '.join(symbols)}" + (f" (fallback {fallback})" if fallback else ""))
    print_stats(res.stats)
    if out:
        out.mkdir(parents=True, exist_ok=True)
        res.equity.to_csv(out / "equity.csv")
        res.weights.to_csv(out / "weights.csv")
        res.trades.to_csv(out / "trades.csv")


@app.command(name="rsi2")
def rsi2(
    universe_file: Optional[Path] = typer.Option(None, help="Path to a text file with one symbol per line"),
    symbols: List[str] = typer.Option([], help="Symbols list if not using file"),
    start: str = typer.Option("2010-01-01", help="Backtest start date"),
    end: Optional[str] = typer.Option(None, help="Backtest end date"),
    max_positions: int = typer.Option(10, help="Max concurrent positions"),
    rsi_buy: float = typer.Option(5.0, help="RSI(2) buy threshold"),
    rsi_sell: float = typer.Option(60.0, help="RSI(2) sell threshold"),
    long_ma: int = typer.Option(200, help="Trade only above this SMA"),
    fees_bps: float = typer.Option(1.0, help="Fees (bps) per turnover"),
    slippage_bps: float = typer.Option(0.0, help="Slippage (bps) per turnover"),
    out: Optional[Path] = typer.Option(None, help="Optional CSV output folder"),
    csv_folder: Optional[Path] = typer.Option(None, help="Optional CSV cache folder to load prices from"),
):
    universe: List[str]
    if universe_file and universe_file.exists():
        universe = [line.strip() for line in universe_file.read_text().splitlines() if line.strip() and not line.startswith('#')]
    else:
        universe = list(symbols)
    if not universe:
        console.print("Provide symbols via --symbols or --universe-file")
        raise typer.Exit(code=1)

    data = maybe_load_data(universe, start=start, end=end, csv_folder=csv_folder)
    cfg = RSI2Config(symbols=universe, max_positions=max_positions, rsi_buy=rsi_buy, rsi_sell=rsi_sell, long_ma=long_ma)
    weights = gen_rsi2(data, cfg)
    prices = align_prices(data)
    res = backtest_from_weights(prices, weights, fees_bps=fees_bps, slippage_bps=slippage_bps)
    console.print(f"RSI(2) Mean Reversion on {len(universe)} symbols")
    print_stats(res.stats)
    if out:
        out.mkdir(parents=True, exist_ok=True)
        res.equity.to_csv(out / "equity.csv")
        res.weights.to_csv(out / "weights.csv")
        res.trades.to_csv(out / "trades.csv")


@app.command()
def compare(
    start: str = typer.Option("2005-01-01", help="Backtest start date"),
    end: Optional[str] = typer.Option(None, help="Backtest end date"),
    csv_folder: Optional[Path] = typer.Option(None, help="Optional CSV cache folder to load prices from"),
    fees_bps: float = typer.Option(1.0, help="Fees (bps) per turnover"),
    slippage_bps: float = typer.Option(0.0, help="Slippage (bps) per turnover"),
    # SMA200
    sma_symbol: str = typer.Option("SPY", help="SMA200 symbol"),
    sma_window: int = typer.Option(200, help="SMA window"),
    # Dual Momentum
    dm_symbols: List[str] = typer.Option([], help="Dual momentum symbols, space-separated"),
    dm_fallback: Optional[str] = typer.Option("AGG", help="Dual momentum fallback"),
    dm_lookback_days: int = typer.Option(252, help="Dual momentum lookback days"),
    dm_top_n: int = typer.Option(1, help="Dual momentum top N"),
    # RSI2
    rsi_universe_file: Optional[Path] = typer.Option(None, help="RSI2 universe file (.txt, one symbol per line)"),
    rsi_symbols: List[str] = typer.Option([], help="RSI2 symbols if not using file"),
    rsi_max_positions: int = typer.Option(10, help="RSI2 max concurrent positions"),
    rsi_buy: float = typer.Option(5.0, help="RSI2 buy threshold"),
    rsi_sell: float = typer.Option(60.0, help="RSI2 sell threshold"),
    rsi_long_ma: int = typer.Option(200, help="RSI2 long MA filter"),
    out: Optional[Path] = typer.Option(None, help="Folder to write per-strategy CSV outputs"),
):
    # Defaults
    if not dm_symbols:
        dm_symbols = ["SPY", "EFA"]

    # Build a union of needed symbols
    rsi_universe: List[str]
    if rsi_universe_file and rsi_universe_file.exists():
        rsi_universe = [line.strip() for line in rsi_universe_file.read_text().splitlines() if line.strip() and not line.startswith('#')]
    else:
        rsi_universe = list(rsi_symbols) if rsi_symbols else []

    union_syms = set([sma_symbol]) | set(dm_symbols) | set([dm_fallback] if dm_fallback else []) | set(rsi_universe)
    union_syms = [s for s in union_syms if s]

    data = maybe_load_data(union_syms, start=start, end=end, csv_folder=csv_folder)

    # SMA200
    sma_cfg = SMA200Config(symbol=sma_symbol, window=sma_window)
    sma_weights = gen_sma200(data, sma_cfg)
    prices = align_prices(data)
    sma_res = backtest_from_weights(prices, sma_weights, fees_bps=fees_bps, slippage_bps=slippage_bps)

    # Dual Momentum
    dm_cfg = DualMomentumConfig(symbols=dm_symbols, fallback=dm_fallback, lookback_days=dm_lookback_days, top_n=dm_top_n)
    dm_weights = gen_dm(data, dm_cfg)
    dm_res = backtest_from_weights(prices, dm_weights, fees_bps=fees_bps, slippage_bps=slippage_bps)

    # RSI2
    if not rsi_universe:
        # Fallback to sample SP100 if present
        default_file = Path(__file__).resolve().parent / "sample_data" / "sp100.txt"
        if default_file.exists():
            rsi_universe = [line.strip() for line in default_file.read_text().splitlines() if line.strip() and not line.startswith('#')]
    rsi_cfg = RSI2Config(symbols=rsi_universe, max_positions=rsi_max_positions, rsi_buy=rsi_buy, rsi_sell=rsi_sell, long_ma=rsi_long_ma)
    rsi_weights = gen_rsi2(data, rsi_cfg)
    rsi_res = backtest_from_weights(prices, rsi_weights, fees_bps=fees_bps, slippage_bps=slippage_bps)

    # Print comparison table
    rows = []
    def fmt_pct(x):
        return f"{x:.2%}"
    def fmt_ratio(x):
        return f"{x:.2f}"
    for name, res in [
        ("SMA200", sma_res),
        ("DualMomentum", dm_res),
        ("RSI2", rsi_res),
    ]:
        st = res.stats
        rows.append([
            name,
            fmt_pct(st.get("Total Return", float('nan'))),
            fmt_pct(st.get("CAGR", float('nan'))),
            fmt_ratio(st.get("Sharpe", float('nan'))),
            fmt_pct(st.get("Max Drawdown", float('nan'))),
            fmt_pct(st.get("Volatility", float('nan'))),
        ])
    console.print(tabulate(rows, headers=["Strategy", "Total Return", "CAGR", "Sharpe", "Max DD", "Vol"], tablefmt="simple"))

    if out:
        out.mkdir(parents=True, exist_ok=True)
        # Save in subfolders
        for name, res in [("sma200", sma_res), ("dual_momentum", dm_res), ("rsi2", rsi_res)]:
            sub = out / name
            sub.mkdir(exist_ok=True)
            res.equity.to_csv(sub / "equity.csv")
            res.weights.to_csv(sub / "weights.csv")
            res.trades.to_csv(sub / "trades.csv")


if __name__ == "__main__":
    app()

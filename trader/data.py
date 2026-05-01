from __future__ import annotations

import os
from typing import Dict, Iterable, List

import pandas as pd
import yfinance as yf


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def to_month_end_index(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    # Align to month end dates for rebalancing
    return df.resample("M").last()


def download_history(
    symbols: Iterable[str],
    start: str | None = None,
    end: str | None = None,
    auto_adjust: bool = True,
    progress: bool = False,
) -> Dict[str, pd.DataFrame]:
    """Download daily OHLCV for symbols using yfinance.

    Returns dict of DataFrames indexed by UTC‑naive DatetimeIndex with columns:
    [Open, High, Low, Close, Adj Close, Volume]
    """
    syms: List[str] = list(dict.fromkeys([s.upper().strip() for s in symbols]))
    if not syms:
        return {}

    data: Dict[str, pd.DataFrame] = {}
    # yfinance multi-download returns a multi-index dataframe
    df = yf.download(
        tickers=syms,
        start=start,
        end=end,
        auto_adjust=False,
        progress=progress,
        group_by="ticker",
        threads=True,
    )

    if isinstance(df.columns, pd.MultiIndex):
        for sym in syms:
            if sym not in df.columns.get_level_values(0):
                continue
            sub = df[sym].copy()
            sub.index = pd.to_datetime(sub.index).tz_localize(None)
            # Ensure standard column order
            cols = [c for c in ["Open", "High", "Low", "Close", "Adj Close", "Volume"] if c in sub.columns]
            sub = sub[cols]
            data[sym] = sub.dropna(how="all")
    else:
        # Single symbol case
        sub = df.copy()
        sub.index = pd.to_datetime(sub.index).tz_localize(None)
        data[syms[0]] = sub.dropna(how="all")

    return data


def align_prices(data: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return a wide DataFrame of Adj Close for all symbols, aligned on dates."""
    frames = []
    for sym, df in data.items():
        s = df["Adj Close"].rename(sym)
        frames.append(s)
    if not frames:
        return pd.DataFrame()
    prices = pd.concat(frames, axis=1).dropna(how="all")
    return prices

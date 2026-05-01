from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
import pandas as pd

from ..indicators import rsi, sma


@dataclass
class RSI2Config:
    symbols: List[str]
    max_positions: int = 10
    rsi_period: int = 2
    rsi_buy: float = 5.0
    rsi_sell: float = 60.0
    long_ma: int = 200  # trade only above long MA
    rebalance: str = "D"  # daily


def generate_weights(data: Dict[str, pd.DataFrame], cfg: RSI2Config) -> pd.DataFrame:
    # Build aligned price frame
    frames = []
    for s in cfg.symbols:
        s = s.upper()
        if s not in data:
            continue
        frames.append(data[s]["Adj Close"].rename(s))
    prices = pd.concat(frames, axis=1).dropna(how="all").sort_index()
    if prices.empty:
        return pd.DataFrame()

    # Indicators per symbol
    rsi_df = prices.apply(lambda col: rsi(col, cfg.rsi_period))
    ma_df = prices.apply(lambda col: sma(col, cfg.long_ma))

    # Eligibility: above long MA
    eligible = prices > ma_df

    # Weights per day: select lowest RSI among eligible below buy threshold
    weights = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    current_positions: List[str] = []

    for i, dt in enumerate(prices.index):
        # Exit signals for current positions when RSI crosses above sell threshold or loses eligibility
        exits = []
        for sym in list(current_positions):
            if np.isnan(rsi_df.at[dt, sym]) or np.isnan(eligible.at[dt, sym]):
                continue
            if (rsi_df.at[dt, sym] >= cfg.rsi_sell) or (not eligible.at[dt, sym]):
                exits.append(sym)
        for sym in exits:
            if sym in current_positions:
                current_positions.remove(sym)

        # Entry candidates: eligible and RSI below buy threshold
        candidates = []
        for sym in prices.columns:
            if not eligible.at[dt, sym]:
                continue
            rv = rsi_df.at[dt, sym]
            if np.isnan(rv):
                continue
            if rv <= cfg.rsi_buy and sym not in current_positions:
                candidates.append((sym, rv))
        # Sort by lowest RSI first
        candidates.sort(key=lambda x: x[1])

        # Fill up to max positions
        for sym, _ in candidates:
            if len(current_positions) >= cfg.max_positions:
                break
            current_positions.append(sym)

        # Set equal weights for current positions
        if current_positions:
            w = 1.0 / len(current_positions)
            for sym in current_positions:
                weights.at[dt, sym] = w
        # else all cash

    # Rebalance daily by design; weights already at daily index
    return weights

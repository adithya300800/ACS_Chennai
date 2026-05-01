from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

import pandas as pd

from ..indicators import sma


@dataclass
class SMA200Config:
    symbol: str
    window: int = 200
    rebalance: str = "M"  # monthly


def generate_weights(data: Dict[str, pd.DataFrame], cfg: SMA200Config) -> pd.DataFrame:
    sym = cfg.symbol.upper()
    if sym not in data:
        raise ValueError(f"Missing data for {sym}")
    df = data[sym].copy()
    px = df["Adj Close"].dropna()
    ma = sma(px, cfg.window)
    # Signal: in market if price > MA
    signal = (px > ma).astype(float)
    # Rebalance schedule
    schedule = signal.resample(cfg.rebalance).last().reindex(signal.index).ffill()
    # Target weight 1 or 0
    w = (schedule > 0).astype(float)
    weights = pd.DataFrame({sym: w})
    return weights

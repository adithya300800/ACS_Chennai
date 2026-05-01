from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import pandas as pd


@dataclass
class DualMomentumConfig:
    symbols: List[str]
    fallback: str | None = None  # e.g., AGG; if None then go to cash
    lookback_days: int = 252  # ~12 months
    top_n: int = 1
    rebalance: str = "M"  # monthly


def generate_weights(data: Dict[str, pd.DataFrame], cfg: DualMomentumConfig) -> pd.DataFrame:
    syms = [s.upper() for s in cfg.symbols]
    all_syms = list(syms)
    if cfg.fallback:
        all_syms.append(cfg.fallback.upper())

    # Build a prices panel of Adj Close
    frames = []
    for s in all_syms:
        if s not in data:
            continue
        frames.append(data[s]["Adj Close"].rename(s))
    prices = pd.concat(frames, axis=1).dropna(how="all")
    prices = prices.sort_index()

    # Monthly schedule mapped to last trading day of each month
    month_end = prices.resample(cfg.rebalance).last()
    sched_idx = month_end.index

    weights = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)

    # Compute momentum on daily index using only candidate symbols (not fallback)
    mom = prices[syms].pct_change(cfg.lookback_days)

    for dt in sched_idx:
        # Map calendar month-end to last available trading day on/before dt
        px_dt = prices.index[prices.index.get_loc(dt, method="ffill")]
        # Select available symbols on this date
        candidates = [s for s in syms if pd.notna(prices.at[px_dt, s])]
        if not candidates:
            continue
        # Rank by relative momentum
        m_slice = mom.loc[px_dt, candidates].dropna()
        if m_slice.empty:
            continue
        ranked = m_slice.sort_values(ascending=False)
        # Filter by absolute momentum > 0
        pos = [s for s in ranked.index if m_slice.loc[s] > 0]
        picks = pos[: cfg.top_n]

        if picks:
            w = 1.0 / len(picks)
            for s in picks:
                weights.at[px_dt, s] = w
        else:
            # Move to fallback if provided
            if cfg.fallback and cfg.fallback.upper() in prices.columns:
                weights.at[px_dt, cfg.fallback.upper()] = 1.0
            # else remain in cash

    weights = weights.reindex(prices.index).ffill().fillna(0.0)
    return weights

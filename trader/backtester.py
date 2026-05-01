from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

import numpy as np
import pandas as pd


@dataclass
class BacktestResult:
    equity: pd.Series
    returns: pd.Series
    trades: pd.DataFrame
    weights: pd.DataFrame
    stats: Dict[str, float]


def compute_stats(equity: pd.Series) -> Dict[str, float]:
    if equity.empty:
        return {}
    ret = equity.pct_change().fillna(0.0)
    total_return = equity.iloc[-1] / equity.iloc[0] - 1
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1 if years > 0 else np.nan
    vol = ret.std() * np.sqrt(252)
    sharpe = ret.mean() / (ret.std() + 1e-12) * np.sqrt(252)
    dd = (equity / equity.cummax() - 1)
    max_dd = dd.min()
    calmar = cagr / abs(max_dd) if max_dd < 0 else np.nan
    return {
        "Total Return": float(total_return),
        "CAGR": float(cagr),
        "Volatility": float(vol),
        "Sharpe": float(sharpe),
        "Max Drawdown": float(max_dd),
        "Calmar": float(calmar),
    }


def backtest_from_weights(
    prices: pd.DataFrame,
    weights: pd.DataFrame,
    initial_capital: float = 100_000.0,
    fees_bps: float = 1.0,
    slippage_bps: float = 0.0,
) -> BacktestResult:
    """Backtest using precomputed target weights.

    - prices: wide DataFrame of Adj Close with symbols as columns
    - weights: wide DataFrame of target weights (same columns). Will be ffilled.
    - Rebalances occur whenever weights change; transaction costs applied to turnover.
    - Returns are applied from next day's price changes to avoid look‑ahead.
    """
    prices = prices.sort_index().copy()
    weights = weights.sort_index().reindex(prices.index).ffill().fillna(0.0)
    # Ensure columns align
    weights = weights.reindex(columns=prices.columns).fillna(0.0)

    daily_ret = prices.pct_change().fillna(0.0)
    # Apply next-day returns for signals decided at t
    next_ret = daily_ret.shift(-1).fillna(0.0)

    # Compute portfolio returns from weights at t times returns at t+1
    port_ret = (weights * next_ret).sum(axis=1)

    # Turnover: sum abs change in weights vs previous day when weights changed
    delta_w = weights.diff().fillna(weights.iloc[0])
    turnover = delta_w.abs().sum(axis=1)
    # Costs in return space
    cost_perc = turnover * ((fees_bps + slippage_bps) / 10_000.0)
    port_ret_after_cost = port_ret - cost_perc

    equity = (1 + port_ret_after_cost).cumprod() * initial_capital
    trades = pd.DataFrame({
        "Turnover": turnover,
        "Cost": cost_perc,
        "PortRet": port_ret,
        "PortRetAfterCost": port_ret_after_cost,
    })

    stats = compute_stats(equity)
    return BacktestResult(
        equity=equity,
        returns=port_ret_after_cost,
        trades=trades,
        weights=weights,
        stats=stats,
    )

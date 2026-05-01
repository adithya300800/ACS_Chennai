from __future__ import annotations

import pandas as pd


def sma(s: pd.Series, window: int) -> pd.Series:
    return s.rolling(window=window, min_periods=window).mean()


def ema(s: pd.Series, window: int) -> pd.Series:
    return s.ewm(span=window, adjust=False, min_periods=window).mean()


def rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    roll_up = up.ewm(alpha=1 / period, adjust=False).mean()
    roll_down = down.ewm(alpha=1 / period, adjust=False).mean()
    rs = roll_up / (roll_down.replace(0, 1e-12))
    out = 100 - (100 / (1 + rs))
    return out

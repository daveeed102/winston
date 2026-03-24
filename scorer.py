"""
scorer.py — Momentum Scoring Engine (0-100) for Winston v12

Scores each candidate token on 5 weighted factors:
  - Volume spike (25%) — is volume spiking vs normal?
  - Price momentum (25%) — is it moving up right now?
  - X/Twitter buzz (20%) — mention velocity in last 2 hours
  - Trending presence (15%) — is it on trending lists?
  - Buyer momentum (15%) — is price action accelerating?

Score >= 60 = eligible to buy
Score < 35 on existing position = sell signal
"""

import scanner
from logger import log


def _score_volume(volume_24h: float, market_cap: float, volume_1h: float = 0) -> int:
    """Score based on volume/mcap ratio and 1h volume spike."""
    if market_cap <= 0 or volume_24h <= 0:
        # If we have 1h volume but no mcap, score based on raw volume
        if volume_1h > 100_000:
            return 60
        elif volume_1h > 50_000:
            return 45
        elif volume_1h > 10_000:
            return 30
        return 20

    ratio = volume_24h / market_cap

    if ratio >= 1.0:
        score = 100
    elif ratio >= 0.5:
        score = 85
    elif ratio >= 0.3:
        score = 70
    elif ratio >= 0.15:
        score = 55
    elif ratio >= 0.08:
        score = 35
    else:
        score = 15

    # Bonus for 1h volume spike (1h should be ~4% of 24h normally)
    if volume_24h > 0 and volume_1h > 0:
        hourly_normal = volume_24h / 24
        if volume_1h > hourly_normal * 3:
            score = min(100, score + 15)  # 3x normal hourly = spiking

    return score


def _score_price_momentum(candidate: dict) -> int:
    """Score based on multi-timeframe price action from Coinbase candles.
    Uses 15m, 1h, 2h, 6h, 24h to build a complete picture."""

    pct_15m = candidate.get("pct_15m", 0)
    pct_1h = candidate.get("pct_1h", 0)
    pct_2h = candidate.get("pct_2h", 0)
    pct_6h = candidate.get("pct_6h", 0)
    pct_24h = candidate.get("pct_24h", 0)
    vol_spike = candidate.get("volume_spike_5m", 0)

    score = 30  # neutral baseline

    # Short-term momentum (15m + 1h) — most important
    short_term = (pct_15m * 2 + pct_1h) / 3  # Weight 15m more
    if short_term >= 10:
        score = 95
    elif short_term >= 5:
        score = 80
    elif short_term >= 2:
        score = 65
    elif short_term >= 0.5:
        score = 50
    elif short_term >= 0:
        score = 35
    elif short_term >= -2:
        score = 20
    else:
        score = 10

    # Medium-term confirmation (2h, 6h)
    if pct_2h > 0 and pct_1h > 0:
        score = min(100, score + 5)  # 2h confirms 1h direction
    if pct_6h > 5 and pct_1h > 0:
        score = min(100, score + 10)  # Strong 6h uptrend + recent continuation

    # 24h context — bonus if recovering from dip (bounce play)
    if pct_24h < -5 and pct_1h > 2:
        score = min(100, score + 10)  # Bounce from 24h dip

    # Volume spike bonus
    if vol_spike >= 3:
        score = min(100, score + 10)  # 3x normal 5-min volume
    elif vol_spike >= 2:
        score = min(100, score + 5)

    return score

    # Bonus if 24h trend confirms 1h direction
    if pct_24h > 0 and pct_1h > 0:
        score = min(100, score + 10)
    elif pct_24h < -10 and pct_1h > 5:
        # Reversal from 24h dump = could be a bounce play
        score = min(100, score + 5)

    return score


def _score_x_mentions(mention_data: dict) -> int:
    """Score based on X/Twitter mention velocity."""
    mentions = mention_data.get("mentions", 0)
    sentiment = mention_data.get("sentiment", 0)
    influencer = mention_data.get("has_influencer", False)

    score = 10  # baseline

    if mentions >= 100:
        score = 80
    elif mentions >= 50:
        score = 65
    elif mentions >= 20:
        score = 50
    elif mentions >= 10:
        score = 35
    elif mentions >= 5:
        score = 25

    # Sentiment bonus
    if sentiment > 0.5:
        score = min(100, score + 10)
    elif sentiment < -0.3:
        score = max(0, score - 15)

    # Influencer bonus
    if influencer:
        score = min(100, score + 15)

    return score


def _score_trending(sources: list) -> int:
    """Score based on how many sources found the coin and which ones."""
    score = 0
    if "trending" in sources:
        score += 35  # On CoinGecko trending
    if "mover" in sources:
        score += 25  # Big price/volume move detected
    if "x_early_buzz" in sources:
        score += 30  # Grok found early Twitter buzz (leading signal)
    if len(sources) >= 2:
        score += 20  # Multiple signals = much stronger
    if len(sources) >= 3:
        score += 10  # Triple confirmed = very strong

    return min(100, score)


def _score_buyer_momentum(candidate: dict) -> int:
    """
    Score based on actual buyer vs seller activity from DEXScreener.
    Also factors in acceleration (1h outperforming 24h average).
    """
    buys_1h = candidate.get("buys_1h", 0)
    sells_1h = candidate.get("sells_1h", 0)
    pct_1h = candidate.get("pct_1h", 0)
    pct_24h = candidate.get("pct_24h", 0)

    score = 20  # baseline

    # Buy/sell ratio (if we have the data)
    total_txns = buys_1h + sells_1h
    if total_txns > 0:
        buy_ratio = buys_1h / total_txns
        if buy_ratio >= 0.75:
            score = 90
        elif buy_ratio >= 0.65:
            score = 70
        elif buy_ratio >= 0.55:
            score = 50
        elif buy_ratio >= 0.45:
            score = 30
        else:
            score = 10
    else:
        # No txn data, fall back to price acceleration
        if pct_24h != 0:
            hourly_avg = pct_24h / 24
        else:
            hourly_avg = 0

        if pct_1h > 0:
            if hourly_avg > 0:
                acceleration = pct_1h / hourly_avg
            else:
                acceleration = pct_1h * 10
            if acceleration >= 5: score = 80
            elif acceleration >= 3: score = 60
            elif acceleration >= 1: score = 40

    # Bonus for high transaction count (active market)
    if total_txns >= 500:
        score = min(100, score + 10)

    return score


def score_token(candidate: dict, skip_x: bool = False) -> dict:
    """
    Score a token on momentum (0-100).

    Weights:
      volume_spike:     25%
      price_momentum:   25%
      x_mentions:       20%
      trending:         15%
      buyer_momentum:   15%

    Returns: {score: int, breakdown: {factor: score}, reason: str}
    """
    symbol = candidate.get("symbol", "???")

    vol_score = _score_volume(
        candidate.get("volume_24h", 0),
        candidate.get("market_cap", 0),
        candidate.get("volume_1h", 0),
    )

    price_score = _score_price_momentum(candidate)

    # X mentions — skip if we're just rescoring (expensive API call)
    # X mentions — use Grok discovery data if we already have it, otherwise fetch
    if skip_x:
        x_score = candidate.get("_cached_x_score", 30)
        x_data = {}
    elif candidate.get("grok_mention_count", 0) > 0:
        # Already have mention data from Grok discovery — no need for second call
        grok_mentions = candidate["grok_mention_count"]
        x_data = {"mentions": grok_mentions, "sentiment": 0.5, "has_influencer": grok_mentions > 50}
        x_score = _score_x_mentions(x_data)
        log(f"[SCORER] {symbol}: using Grok discovery data (~{grok_mentions} mentions)")
    else:
        x_data = scanner.get_x_mention_velocity(symbol)
        x_score = _score_x_mentions(x_data)

    trending_score = _score_trending(candidate.get("sources", []))

    buyer_score = _score_buyer_momentum(candidate)

    # Chart shape score — computed from candle data
    chart_trending = candidate.get("chart_trending_up", None)
    pct_6h = candidate.get("pct_6h", 0)

    if chart_trending is not None:
        chart_score = 50  # baseline
        if chart_trending:
            chart_score += 20  # last 3 candles trending up
        if pct_6h > 5:
            chart_score += 20  # solid 6h uptrend
        elif pct_6h > 0:
            chart_score += 10
        elif pct_6h < -5:
            chart_score -= 20  # 6h downtrend = bad
        chart_score = max(0, min(100, chart_score))
        chart_label = "up" if chart_trending else "down"
    else:
        chart_score = 40  # no data
        chart_label = "no_data"

    # 6 factors now, with chart shape as a key component
    has_market_data = candidate.get("volume_24h", 0) > 0 or candidate.get("pct_1h", 0) != 0

    if has_market_data:
        total = (
            vol_score * 0.15 +
            price_score * 0.20 +
            x_score * 0.15 +
            trending_score * 0.15 +
            buyer_score * 0.10 +
            chart_score * 0.25    # Chart shape is crucial — don't buy the top
        )
    else:
        total = (
            vol_score * 0.05 +
            price_score * 0.05 +
            x_score * 0.35 +
            trending_score * 0.30 +
            buyer_score * 0.05 +
            chart_score * 0.20
        )

    final_score = int(round(total))

    breakdown = {
        "volume": vol_score,
        "price": price_score,
        "x_buzz": x_score,
        "trending": trending_score,
        "acceleration": buyer_score,
        "chart": chart_score,
    }

    # Build reason string
    chart_phase = candidate.get("chart_phase", "unknown")
    reasons = []
    if chart_score >= 60:
        reasons.append(f"chart: {chart_phase}")
    if price_score >= 60:
        reasons.append(f"+{candidate.get('pct_1h', 0):.1f}% in 1h")
    if vol_score >= 60:
        reasons.append("high volume/mcap ratio")
    if x_score >= 50:
        buzz = x_data.get("buzz", "")
        reasons.append(f"X buzz: {buzz}" if buzz else "active on CT")
    if "x_early_buzz" in candidate.get("sources", []):
        grok_reason = candidate.get("grok_reason", "")
        if grok_reason:
            reasons.append(f"Grok early signal: {grok_reason}")
    if trending_score >= 50:
        sources = candidate.get("sources", [])
        reasons.append(f"found in {len(sources)} sources: {', '.join(sources)}")
    if buyer_score >= 60:
        reasons.append("momentum accelerating")

    reason = " | ".join(reasons) if reasons else "moderate signals across indicators"

    log(f"[SCORER] {symbol}: {final_score}/100 — vol={vol_score} price={price_score} "
        f"x={x_score} trend={trending_score} accel={buyer_score} chart={chart_score}({chart_label})")

    return {
        "score": final_score,
        "breakdown": breakdown,
        "reason": reason,
        "_cached_x_score": x_score,
    }

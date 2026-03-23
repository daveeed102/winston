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


def _score_volume(volume_24h: float, market_cap: float) -> int:
    """Score based on volume/mcap ratio. High ratio = unusual activity."""
    if market_cap <= 0 or volume_24h <= 0:
        return 20  # No data, neutral

    ratio = volume_24h / market_cap
    # Normal is ~0.05-0.10. High is 0.3+. Insane is 1.0+
    if ratio >= 1.0:
        return 100
    elif ratio >= 0.5:
        return 85
    elif ratio >= 0.3:
        return 70
    elif ratio >= 0.15:
        return 55
    elif ratio >= 0.08:
        return 35
    else:
        return 15


def _score_price_momentum(pct_1h: float, pct_24h: float) -> int:
    """Score based on recent price action."""
    # 1h is more important than 24h for short-term trades
    score = 30  # neutral baseline

    # 1h momentum (dominant factor)
    if pct_1h >= 20:
        score = 100
    elif pct_1h >= 10:
        score = 85
    elif pct_1h >= 5:
        score = 70
    elif pct_1h >= 2:
        score = 55
    elif pct_1h >= 0:
        score = 40
    elif pct_1h >= -3:
        score = 25
    else:
        score = 10

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
    """Score based on how many trending lists the coin appears on."""
    score = 0
    if "trending" in sources:
        score += 50  # On CoinGecko trending
    if "mover" in sources:
        score += 30  # Big price/volume move detected
    if len(sources) >= 2:
        score += 20  # Multiple signals = stronger

    return min(100, score)


def _score_buyer_momentum(pct_1h: float, pct_24h: float) -> int:
    """
    Score based on whether momentum is accelerating.
    If 1h change is much higher than 24h/24 (hourly avg), it's accelerating.
    """
    if pct_24h == 0:
        hourly_avg = 0
    else:
        hourly_avg = pct_24h / 24

    if pct_1h <= 0:
        return 15

    # How much is 1h outperforming the average hourly move?
    if hourly_avg > 0:
        acceleration = pct_1h / hourly_avg
    else:
        acceleration = pct_1h * 10  # Any positive 1h on a flat/negative 24h = strong signal

    if acceleration >= 10:
        return 100
    elif acceleration >= 5:
        return 80
    elif acceleration >= 3:
        return 65
    elif acceleration >= 2:
        return 50
    elif acceleration >= 1:
        return 35
    else:
        return 20


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
    )

    price_score = _score_price_momentum(
        candidate.get("pct_1h", 0),
        candidate.get("pct_24h", 0),
    )

    # X mentions — skip if we're just rescoring (expensive API call)
    if skip_x:
        x_score = candidate.get("_cached_x_score", 30)
        x_data = {}
    else:
        x_data = scanner.get_x_mention_velocity(symbol)
        x_score = _score_x_mentions(x_data)

    trending_score = _score_trending(candidate.get("sources", []))

    buyer_score = _score_buyer_momentum(
        candidate.get("pct_1h", 0),
        candidate.get("pct_24h", 0),
    )

    # Weighted average
    total = (
        vol_score * 0.25 +
        price_score * 0.25 +
        x_score * 0.20 +
        trending_score * 0.15 +
        buyer_score * 0.15
    )
    final_score = int(round(total))

    breakdown = {
        "volume": vol_score,
        "price": price_score,
        "x_buzz": x_score,
        "trending": trending_score,
        "acceleration": buyer_score,
    }

    # Build reason string
    reasons = []
    if price_score >= 60:
        reasons.append(f"+{candidate.get('pct_1h', 0):.1f}% in 1h")
    if vol_score >= 60:
        reasons.append("high volume/mcap ratio")
    if x_score >= 50:
        buzz = x_data.get("buzz", "")
        reasons.append(f"X buzz: {buzz}" if buzz else "active on CT")
    if trending_score >= 50:
        reasons.append("trending on CoinGecko")
    if buyer_score >= 60:
        reasons.append("momentum accelerating")

    reason = " | ".join(reasons) if reasons else "moderate signals across indicators"

    log(f"[SCORER] {symbol}: {final_score}/100 — vol={vol_score} price={price_score} "
        f"x={x_score} trend={trending_score} accel={buyer_score}")

    return {
        "score": final_score,
        "breakdown": breakdown,
        "reason": reason,
        "_cached_x_score": x_score,
    }

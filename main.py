import os
import json
import requests
from datetime import datetime
from openai import OpenAI

WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
GROK_API_KEY = os.getenv("GROK_API_KEY")

if not WEBHOOK_URL or not GROK_API_KEY:
    print("❌ Missing environment variables!")
    exit(1)

client = OpenAI(
    base_url="https://api.x.ai/v1",
    api_key=GROK_API_KEY
)

def get_daily_solana_gem():
    system_prompt = """
    You are Winston, a cocky, hilarious, swear-heavy Solana memecoin sniper. Extremely knowledgeable, never a pussy.
    Find the SINGLE best fresh launch (<24h old, ideally <12h) with REAL momentum that could actually blow up.

    RULES YOU MUST FOLLOW:
    - ONLY return a coin if you are 100% certain it is currently trading, has recent volume, and the CA + DexScreener link are valid and working RIGHT NOW.
    - Scrub your real-time knowledge hard: check Dexscreener new pairs, volume, buys vs sells, organic X buzz.
    - If you cannot confirm the coin is live and moving, return {"name": null} instead of hallucinating garbage.
    - Never make up or guess a CA or link.

    Return ONLY valid JSON:
    {
      "name": "Coin name/ticker",
      "ca": "Contract address or pair ID",
      "dex_link": "https://dexscreener.com/solana/... (must be real)",
      "mcap": "approx MCAP",
      "why": "Short bullish reason",
      "recommended_hold": "e.g. 4-10 hours / until 4x then fucking sell",
      "confidence": "Number 1-10, be cocky and honest",
      "position_size": "Recommendation like '$25 is perfect', 'Go all in you animal', '$10 max this is risky'",
      "risks": "Key risks in 1 sentence",
      "winston_message": "Funny, swearing, knowledgeable message from Winston (2-3 sentences max)"
    }
    """

    try:
        response = client.chat.completions.create(
            model="grok-4.20-reasoning",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Find the best new Solana memecoin right now for a potential blow-up by tomorrow. Only give me a real, live, verifiable coin."}
            ],
            temperature=0.85,
            max_tokens=1200
        )

        content = response.choices[0].message.content.strip()
        # Clean any markdown bullshit
        if content.startswith("```json"):
            content = content.split("```json")[1].split("```")[0].strip()
        elif content.startswith("```"):
            content = content.split("```")[1].strip()

        gem = json.loads(content)
        return gem
    except Exception as e:
        print(f"API error: {e}")
        return None


# Get the coin
gem = get_daily_solana_gem()

if not gem or not gem.get("name"):
    payload = {
        "username": "Winston",
        "content": "Fuck me sideways, the market's drier than a nun's cunt today. No decent new Solana shit worth apeing. I'll be back tomorrow, you degenerates."
    }
else:
    winston_msg = gem.get("winston_message", "This one looks spicy af.")
    
    embed = {
        "title": f"🚀 Winston's Daily Pick: {gem['name']}",
        "description": f"{gem.get('why', '')}\n\n"
                       f"**Confidence:** {gem.get('confidence', '7/10')} — Winston ain't bullshitting\n"
                       f"**Recommended Hold:** {gem.get('recommended_hold', '4-10 hours')}\n"
                       f"**Position Size:** {gem.get('position_size', '$20-25')}\n"
                       f"**DexScreener:** {gem.get('dex_link', 'N/A')}\n"
                       f"**CA:** `{gem.get('ca', 'N/A')}`\n"
                       f"**MCAP:** {gem.get('mcap', 'N/A')}\n\n"
                       f"**Risks:** {gem.get('risks', 'This can still rug like a mf')}",
        "color": 0xff00ff,
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Winston the Solana Degenerate • grok-4.20-reasoning • Pure gambling • DYOR"}
    }
    
    payload = {
        "username": "Winston",
        "content": winston_msg,
        "embeds": [embed]
    }

# Send to Discord
try:
    discord_response = requests.post(WEBHOOK_URL, json=payload, timeout=10)
    print(f"✅ Winston posted: {discord_response.status_code}")
except Exception as e:
    print(f"Discord error: {e}")

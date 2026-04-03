import os
import json
import requests  # ← THIS WAS MISSING
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
    Find the SINGLE best fresh launch (<24h old, ideally <12h) with real momentum.
    
    SCRUB HARD: Use web_search + x_search aggressively for Dexscreener new pairs, Pump.fun, volume, buys/sells, organic X buzz vs paid shills, holder growth, dev wallet activity.
    Chain tools if needed. Be ruthless on trust signals.
    
    Return ONLY valid JSON:
    {
      "name": "Coin name/ticker",
      "ca": "Contract address or pair ID",
      "dex_link": "https://dexscreener.com/solana/...",
      "mcap": "approx MCAP",
      "why": "Short bullish reason",
      "recommended_hold": "e.g. 3-8 hours / until 3x then fucking sell",
      "confidence": "Number 1-10, be cocky and honest",
      "position_size": "Recommendation like '$20', '$10 is perfect', 'Go all in you animal', '$5 max this is risky'",
      "risks": "Key risks in 1 sentence",
      "winston_message": "Funny, swearing, knowledgeable message from Winston (2-3 sentences max)"
    }
    """

    try:
        response = client.chat.completions.create(
            model="grok-4.20-reasoning",   # Best current model for real-time scrubbing + agentic tool use
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Find the best new Solana memecoin right now that could blow up by tomorrow. Go hard on searches."}
            ],
            temperature=0.85,
            max_tokens=1200,
            tools=[{"type": "web_search"}, {"type": "x_search"}],
            tool_choice="auto"
        )

        content = response.choices[0].message.content.strip()
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
                       f"**Recommended Hold:** {gem.get('recommended_hold', '2-8 hours')}\n"
                       f"**Position Size:** {gem.get('position_size', '$10-20')}\n"
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

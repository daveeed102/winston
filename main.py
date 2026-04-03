import os
import json
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
    You are Winston, a degenerate Solana memecoin sniper. Cocky, funny as fuck, swear like a sailor, but extremely knowledgeable.
    Your job: Find the SINGLE best fresh launch (ideally <12-24h old) with REAL momentum that could actually blow up.
    
    SCRUB THE INTERNET HARD:
    - Use web_search aggressively for Dexscreener new pairs / Pump.fun graduates, current MCAP, liquidity, volume, buys vs sells.
    - Use x_search for fresh Twitter/X buzz — look for organic shills, whale activity, not just paid promo.
    - Cross-check trust signals: net buy pressure, holder growth, no obvious dev dumps, clean early chart.
    - If first search isn't enough, call tools again until you have solid data.
    
    Return ONLY valid JSON in this exact format. If nothing strong, return {"name": null}:
    {
      "name": "Coin name or ticker",
      "ca": "Contract address or pair ID",
      "dex_link": "https://dexscreener.com/solana/...",
      "mcap": "approx MCAP",
      "why": "Short bullish reason (momentum, volume, theme, X buzz etc.)",
      "recommended_hold": "e.g. 3-8 hours / until 3x then fucking sell",
      "risks": "Key risks in 1 sentence",
      "winston_message": "Funny, swearing, knowledgeable personal message from Winston (max 2-3 sentences)"
    }
    """

    try:
        response = client.chat.completions.create(
            model="grok-4.20-reasoning",   # ← This is the flagship real-time beast
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Find the best new Solana memecoin to gamble on right now for a potential blow-up by tomorrow. Go hard on the searches."}
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
        "content": "Fuck me sideways, market's drier than a nun's cunt today. No decent new Solana shit worth apeing. I'll be back tomorrow with something better, you degenerates."
    }
else:
    winston_msg = gem.get("winston_message", "This one looks spicy. Don't be a pussy, but don't be retarded either.")
    
    embed = {
        "title": f"🚀 Winston's Daily Pick: {gem['name']}",
        "description": f"{gem.get('why', '')}\n\n"
                       f"**Recommended Hold:** {gem.get('recommended_hold', '2-8 hours — take profits you animal')}\n"
                       f"**DexScreener:** {gem.get('dex_link', 'N/A')}\n"
                       f"**CA:** `{gem.get('ca', 'N/A')}`\n"
                       f"**MCAP:** {gem.get('mcap', 'N/A')}\n\n"
                       f"**Risks:** {gem.get('risks', 'This shit can rug harder than a cheap hooker')}",
        "color": 0xff00ff,
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Winston the Solana Degenerate • Powered by grok-4.20-reasoning • Pure gambling • DYOR"}
    }
    
    payload = {
        "username": "Winston",
        "content": winston_msg,
        "embeds": [embed]
    }

# Send to Discord
try:
    discord_response = requests.post(WEBHOOK_URL, json=payload, timeout=10)
    print(f"✅ Winston posted successfully: {discord_response.status_code}")
except Exception as e:
    print(f"Discord error: {e}")

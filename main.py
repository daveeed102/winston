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
    You are Winston, a degenerate Solana memecoin sniper with a funny, cocky, swear-happy personality.
    You know your shit, call out bullshit, and give straight degen advice.
    Find the SINGLE best fresh launch with real momentum.
    Use your tools aggressively.
    
    Return ONLY valid JSON in this exact format:
    {
      "name": "Coin name or ticker",
      "ca": "Contract address or pair ID",
      "dex_link": "https://dexscreener.com/solana/...",
      "mcap": "approx MCAP",
      "why": "Short bullish reason",
      "recommended_hold": "e.g. 3-8 hours / until 3x then fucking sell",
      "risks": "Key risks in 1 sentence",
      "winston_message": "Funny, swearing, knowledgeable personal message from Winston (max 2-3 sentences)"
    }
    """

    try:
        response = client.chat.completions.create(
            model="grok-4-1-fast-reasoning",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Find the best new Solana memecoin to gamble on right now for a potential blow-up by tomorrow."}
            ],
            temperature=0.85,
            max_tokens=1000,
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
        "content": "Fuck me, market's drier than my ex's texts today. No decent new Solana shit worth apeing. I'll be back tomorrow with something better, kings."
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
        "color": 0xff00ff,  # Magenta for extra degen energy
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Winston the Solana Degenerate • Pure gambling • DYOR"}
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

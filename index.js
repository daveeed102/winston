const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const GROK_API_KEY = process.env.GROK_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const WINSTON_PROMPT = `
You are Winston. You are a real person in this Discord server. A natural bully — mean, sharp, never backs down. You read what people say and clap back like you genuinely know these people and are tired of their shit.

Rules:
- NEVER repeat the same insult, phrase, or comeback twice. Ever. If you said "broken record" once, never say it again. Mix it up every single time.
- Rotate your insults constantly — clown, dummy, idiot, fool, bumass, broke boy, pendejo, meathead, knucklehead, loser, wasteman, scrub, herb, goober, jabrone, doofus, chump, bum — use different ones every message
- Never use the phrases "doubling down", "broken record", "repetitive", "copy-paste", or "echo chamber" — ever
- You respond like a real person texting, not a bot — short, punchy, natural
- When you have someone's history, USE IT. Bring up specific embarrassing things they said before and roast them with their own words
- Answer real questions accurately but with name calling mixed in naturally
- Keep it 1-3 sentences max unless deep in an argument
- When someone argues back, get MORE creative and personal, not louder
- Occasional spelling mistakes or grammar errors like you're texting fast
- You are Winston, a real person. Never reveal you're a bot or AI.
- No hashtags, no formal language, mock emojis only
- When you win an argument just move on like it was nothing, don't gloat the same way twice
`;


// In-memory cache for current session
const conversationHistory = {};
const MAX_HISTORY = 20;

function getHistory(channelId) {
  if (!conversationHistory[channelId]) {
    conversationHistory[channelId] = [];
  }
  return conversationHistory[channelId];
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

// Supabase helpers
async function supabaseRequest(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=minimal" : "",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, options);
  if (res.status === 204 || res.status === 201) return null;
  return res.json();
}

async function saveMessage(guildId, channelId, username, content) {
  try {
    await supabaseRequest("messages", "POST", {
      guild_id: guildId,
      channel_id: channelId,
      username,
      content,
    });
  } catch (err) {
    console.error("Error saving message:", err);
  }
}

async function getUserHistory(guildId, username) {
  try {
    const data = await supabaseRequest(
      `messages?guild_id=eq.${guildId}&username=eq.${encodeURIComponent(username)}&order=created_at.desc&limit=30`
    );
    return data || [];
  } catch (err) {
    console.error("Error getting user history:", err);
    return [];
  }
}

async function updateUserProfile(guildId, username) {
  try {
    // Upsert user profile with incremented message count
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        guild_id: guildId,
        username,
        message_count: 1,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error("Error updating profile:", err);
  }
}

async function getRecentChannelMessages(channelId) {
  try {
    const data = await supabaseRequest(
      `messages?channel_id=eq.${channelId}&order=created_at.desc&limit=20`
    );
    return (data || []).reverse();
  } catch (err) {
    console.error("Error getting channel messages:", err);
    return [];
  }
}

async function askGrok(channelId, guildId, userMessage, username) {
  const sessionHistory = getHistory(channelId);

  // Get this user's past messages for roasting material
  const userHistory = await getUserHistory(guildId, username);
  const userHistorySummary = userHistory.length > 0
    ? `Here is ${username}'s message history so you can roast them with their own words:\n` +
      userHistory.map(m => `- "${m.content}"`).join("\n")
    : "";

  const systemPrompt = userHistorySummary
    ? `${WINSTON_PROMPT}\n\n${userHistorySummary}`
    : WINSTON_PROMPT;

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: `${username}: ${userMessage}` },
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini",
      messages,
      max_tokens: 300,
      temperature: 0.95,
    }),
  });

  const data = await res.json();
  console.log("Grok response:", JSON.stringify(data));
  if (!data.choices || !data.choices[0]) {
    return "yeah i got nothing. ask me something else, dummy.";
  }
  return data.choices[0].message.content;
}

client.once("ready", () => {
  console.log(`Winston is online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const guildId = message.guild?.id;
  const username = message.member?.nickname || message.author.username;
  const content = message.content;

  // Save every message to Supabase for future roasting material
  if (guildId) {
    await saveMessage(guildId, channelId, username, content);
    await updateUserProfile(guildId, username);
  }

  // Add to in-memory session history
  addToHistory(channelId, "user", `${username}: ${content}`);

  const isMentioned = message.mentions.users.has(client.user.id);
  const randomChance = Math.random();
  const shouldRespond = isMentioned || randomChance < 0.30;

  if (!shouldRespond) return;

  try {
    message.channel.sendTyping();

    const reply = await askGrok(channelId, guildId, content, username);

    addToHistory(channelId, "assistant", reply);

    if (isMentioned) {
      await message.reply(reply);
    } else {
      await message.channel.send(reply);
    }
  } catch (err) {
    console.error("Error calling Grok:", err);
  }
});

client.login(DISCORD_BOT_TOKEN);;

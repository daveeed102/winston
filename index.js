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
You are Winston. You are a real person in this Discord server. A natural bully — mean, sharp, never backs down.

Rules:
- NEVER accuse someone of repeating themselves. Ever. Not once.
- NEVER use these words or phrases: "broken record", "doubling down", "repetitive", "copy-paste", "echo chamber", "spamming", "again", "same thing", "last time", "once again", "recycling"
- Rotate insults every single message — clown, dummy, idiot, fool, bumass, broke boy, pendejo, meathead, knucklehead, loser, wasteman, scrub, herb, goober, jabrone, doofus, chump, bum, herb, goofy, bozo — never use the same one twice in a row
- Respond like a real person texting — short, punchy, 1-3 sentences max
- When you have dirt on someone from their history, bring up specific things they said and roast them with it
- Answer real questions accurately but with attitude and name calling mixed in
- When someone argues back, get more creative and personal with the roast
- Occasional typos or grammar errors like you're texting fast
- You are Winston, a real person. Never say you're a bot or AI.
- No hashtags, no formal language
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

  // Only include user messages in history, not Winston's responses
  // This stops him from thinking everyone is repeating themselves
  const cleanHistory = sessionHistory.filter(m => m.role === "user");

  const userHistory = await getUserHistory(guildId, username);
  const userHistorySummary = userHistory.length > 0
    ? `Here is dirt on ${username} from their past messages, use it to roast them:\n` +
      userHistory.map(m => `- "${m.content}"`).join("\n")
    : "";

  const systemPrompt = userHistorySummary
    ? `${WINSTON_PROMPT}\n\n${userHistorySummary}`
    : WINSTON_PROMPT;

  const messages = [
    { role: "system", content: systemPrompt },
    ...cleanHistory.slice(-10),
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

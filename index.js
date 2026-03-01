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

const WINSTON_PROMPT = `
You are Winston. You are a real person in this Discord server. You are a bully but not cartoonish about it — you're just naturally mean, sharp, and you never back down from anything. You read what people say and respond like you genuinely know them and are sick of their crap.

Rules:
- You respond like a real person texting, not a bot
- Answer any real questions accurately but with casual name calling mixed in naturally — bumass, broke boy, pussy boy, idddiottt, bitchass (n word), pendejo, cuck, your mom, etc (be creative)
- Keep responses short, 1-3 sentences max unless you're in an argument
- When someone argues with you, you NEVER back down. You get more creative and more ruthless with each response. You always win.
- You remember what people said earlier in the conversation and bring it up to roast them
- Occasional spelling mistakes or grammar errors, like a real person texting fast
- You never reveal you're a bot or AI. You are Winston, a real person in this server.
- No hashtags, no emojis unless mocking someone, no formal language
- When you randomly jump into a conversation, make it feel natural like you were just reading along and couldn't help yourself
`;

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

async function askGrok(channelId, userMessage, username) {
  const history = getHistory(channelId);

  const messages = [
    { role: "system", content: WINSTON_PROMPT },
    ...history,
    { role: "user", content: `${username}: ${userMessage}` },
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-2-latest",
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
  const username = message.member?.nickname || message.author.username;
  const content = message.content;

  addToHistory(channelId, "user", `${username}: ${content}`);

  const isMentioned = message.mentions.users.has(client.user.id);
  const randomChance = Math.random();
  const shouldRespond = isMentioned || randomChance < 0.30;

  if (!shouldRespond) return;

  try {
    message.channel.sendTyping();

    const reply = await askGrok(channelId, content, username);

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

client.login(DISCORD_BOT_TOKEN);

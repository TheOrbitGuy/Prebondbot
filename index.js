import { Bot, InlineKeyboard } from "grammy";
import WebSocket from "ws";

const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const MIN_BOND_PCT  = parseFloat(process.env.MIN_BOND_PCT || "0");
const MAX_BOND_PCT  = parseFloat(process.env.MAX_BOND_PCT || "85");
const MIN_REPLIES   = parseInt(process.env.MIN_REPLIES || "0");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN and CHAT_ID must be set.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const seenMints = new Set();
let foundTotal  = 0;
const BOND_TARGET = 793_100_000_000;

function getBondPct(token) {
  if (!token.vSolInBondingCurve) return 0;
  return Math.min(100, (token.vSolInBondingCurve / BOND_TARGET) * 100);
}

function formatMcap(v) {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function bondBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function bondEmoji(pct) {
  if (pct >= 70) return "🔥";
  if (pct >= 40) return "⚡";
  return "🟢";
}

function cleanTgUrl(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith("http")) return s;
  return `https://t.me/${s.replace(/^@/, "")}`;
}

function escMd(str = "") {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

async function sendAlert(t) {
  const pct     = getBondPct(t);
  const tgUrl   = cleanTgUrl(t.telegram);
  const pumpUrl = `https://pump.fun/coin/${t.mint}`;

  const lines = [
    `🔭 *New PreBond Token Spotted*`,
    ``,
    `🪙 *${escMd(t.name)}* — \`$${escMd(t.symbol)}\``,
    ``,
    `${bondEmoji(pct)} Bond: \`${pct.toFixed(1)}%\``,
    `\`[${bondBar(pct)}]\``,
    ``,
    `💰 MCap: \`${formatMcap(t.marketCapSol)}\``,
    `💬 Replies: \`${t.replyCount || 0}\``,
    ``,
    `📋 \`${t.mint}\``,
  ];

  if (t.description) {
    const desc = t.description.slice(0, 120);
    lines.push(``, `📝 ${escMd(desc)}${t.description.length > 120 ? "…" : ""}`);
  }

  const keyboard = new InlineKeyboard()
    .url("🔗 pump.fun", pumpUrl)
    .url("✈️ Telegram", tgUrl);

  try {
    await bot.api.sendMessage(CHAT_ID, lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
    foundTotal++;
    console.log(`✅ Alert sent: ${t.symbol} (bond: ${pct.toFixed(1)}%)`);
  } catch (err) {
    console.error(`❌ Alert failed for ${t.mint}:`, err.message);
  }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function connectWebSocket() {
  console.log("🔌 Connecting to PumpPortal...");

  const ws = new WebSocket("wss://pumpportal.fun/api/data", {
    headers: {
      "Origin": "https://pump.fun",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
  });

  ws.on("open", () => {
    console.log("✅ Connected to PumpPortal!");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", async (data) => {
    try {
      const token = JSON.parse(data.toString());
      if (!token.mint) return;
      if (seenMints.has(token.mint)) return;
      seenMints.add(token.mint);

      const bonded  = token.complete === true;
      const hasTg   = token.telegram && token.telegram.trim().length > 0;
      const pct     = getBondPct(token);
      const replies = token.replyCount || 0;

      if (bonded || !hasTg || pct < MIN_BOND_PCT || pct > MAX_BOND_PCT || replies < MIN_REPLIES) return;

      console.log(`🎯 ${token.symbol} | Bond: ${pct.toFixed(1)}% | TG: ${token.telegram}`);
      await sendAlert(token);
    } catch (e) {}
  });

  ws.on("close", () => {
    console.log("⚠️ Disconnected — reconnecting in 5s...");
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *PreBond Scanner Bot*\n\n" +
    "I watch pump\\.fun in real\\-time and alert you to new unbonded tokens with Telegram communities\\.\n\n" +
    "/status \\— show stats\n" +
    "/config \\— show filter settings",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    `📊 *Scanner Status*\n\n` +
    `✅ Running via PumpPortal\n` +
    `📢 Alerts sent: \`${foundTotal}\`\n` +
    `🧠 Tokens seen: \`${seenMints.size}\``,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("config", async (ctx) => {
  await ctx.reply(
    `⚙️ *Current Config*\n\n` +
    `Bond range: \`${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%\`\n` +
    `Min replies: \`${MIN_REPLIES}\``,
    { parse_mode: "MarkdownV2" }
  );
});

async function main() {
  console.log("🚀 PreBond Scanner Bot starting...");
  console.log(`📊 Bond filter: ${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%`);
  console.log(`📤 Sending to chat: ${CHAT_ID}`);

  bot.start({ drop_pending_updates: true });
  console.log("✅ Bot listening for commands...");

  await sleep(2000);
  connectWebSocket();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

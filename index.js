import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import fetch from "node-fetch";

const BOT_TOKEN    = process.env.BOT_TOKEN;
const CHAT_ID      = process.env.CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "60000");
const MIN_BOND_PCT  = parseFloat(process.env.MIN_BOND_PCT || "0");
const MAX_BOND_PCT  = parseFloat(process.env.MAX_BOND_PCT || "85");
const MIN_REPLIES   = parseInt(process.env.MIN_REPLIES || "0");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN and CHAT_ID must be set in environment variables.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const seenMints = new Set();
let isScanning  = false;
let scanCount   = 0;
let foundTotal  = 0;

const BOND_TARGET = 793_100_000_000;

function getBondPct(token) {
  if (!token.virtual_sol_reserves) return 0;
  return Math.min(100, (token.virtual_sol_reserves / BOND_TARGET) * 100);
}

function formatMcap(v) {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatAge(ts) {
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diff < 60)    return `${diff}s`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function bondBar(pct) {
  const filled = Math.round(pct / 10);
  const empty  = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
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

async function fetchPumpTokens() {
  const urls = [
    "https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://frontend-api.pump.fun/coins?offset=50&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false",
  ];

  const results = await Promise.allSettled(
    urls.map(url =>
      fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      }).then(r => r.json())
    )
  );

  const all = [];
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      all.push(...r.value);
    }
  }

  const seen = new Set();
  return all.filter(t => {
    if (seen.has(t.mint)) return false;
    seen.add(t.mint);
    return true;
  });
}

function filterTokens(tokens) {
  return tokens.filter(t => {
    const bonded  = t.complete === true || t.raydium_pool != null;
    const hasTg   = t.telegram && t.telegram.trim().length > 0;
    const pct     = getBondPct(t);
    const replies = t.reply_count || 0;
    return !bonded && hasTg && pct >= MIN_BOND_PCT && pct <= MAX_BOND_PCT && replies >= MIN_REPLIES;
  });
}

function escMd(str = "") {
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function formatAlert(t) {
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
    `💰 MCap: \`${formatMcap(t.market_cap)}\``,
    `💬 Replies: \`${t.reply_count || 0}\``,
    `⏱ Age: \`${formatAge(t.created_timestamp)}\``,
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

  return { text: lines.join("\n"), keyboard };
}

async function sendAlert(token) {
  const { text, keyboard } = formatAlert(token);
  try {
    await bot.api.sendMessage(CHAT_ID, text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
    foundTotal++;
  } catch (err) {
    console.error(`❌ Failed to send alert for ${token.mint}:`, err.message);
  }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function scan() {
  if (isScanning) return;
  isScanning = true;
  scanCount++;

  try {
    const raw      = await fetchPumpTokens();
    const filtered = filterTokens(raw);
    const newOnes  = filtered.filter(t => !seenMints.has(t.mint));

    console.log(`[Scan #${scanCount}] ${raw.length} fetched → ${filtered.length} match filters → ${newOnes.length} new`);

    filtered.forEach(t => seenMints.add(t.mint));

    for (const token of newOnes) {
      await sendAlert(token);
      if (newOnes.length > 1) await sleep(1200);
    }

    if (seenMints.size > 5000) {
      const arr = [...seenMints];
      arr.splice(0, 1000).forEach(m => seenMints.delete(m));
    }

  } catch (err) {
    console.error(`[Scan #${scanCount}] Error:`, err.message);
  } finally {
    isScanning = false;
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 *PreBond Scanner Bot*\n\n" +
    "I watch pump\\.fun in real\\-time and alert you to unbonded tokens with active Telegram communities\\.\n\n" +
    "Commands:\n" +
    "/scan \\— trigger a manual scan now\n" +
    "/status \\— show scanner stats\n" +
    "/config \\— show current filter settings",
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("scan", async (ctx) => {
  await ctx.reply("🔍 Scanning pump.fun now...");
  try {
    const raw      = await fetchPumpTokens();
    const filtered = filterTokens(raw);
    await ctx.reply(`✅ Found *${filtered.length}* unbonded tokens with Telegram\\.`, { parse_mode: "MarkdownV2" });
    const newOnes = filtered.filter(t => !seenMints.has(t.mint));
    filtered.forEach(t => seenMints.add(t.mint));
    for (const token of newOnes) {
      await sendAlert(token);
      if (newOnes.length > 1) await sleep(1200);
    }
    if (newOnes.length === 0) {
      await ctx.reply("ℹ️ No new tokens since last scan\\.", { parse_mode: "MarkdownV2" });
    }
  } catch (err) {
    await ctx.reply(`❌ Scan failed: ${err.message}`);
  }
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    `📊 *Scanner Status*\n\n` +
    `✅ Running\n` +
    `🔁 Scans done: \`${scanCount}\`\n` +
    `📢 Alerts sent: \`${foundTotal}\`\n` +
    `🧠 Tokens in cache: \`${seenMints.size}\`\n` +
    `⏱ Poll interval: \`${POLL_INTERVAL / 1000}s\``,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("config", async (ctx) => {
  await ctx.reply(
    `⚙️ *Current Config*\n\n` +
    `Bond range: \`${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%\`\n` +
    `Min replies: \`${MIN_REPLIES}\`\n` +
    `Poll interval: \`${POLL_INTERVAL / 1000}s\`\n\n` +
    `_Change via Railway environment variables_`,
    { parse_mode: "MarkdownV2" }
  );
});

async function main() {
  console.log("🚀 PreBond Scanner Bot starting...");
  console.log(`📡 Poll interval: ${POLL_INTERVAL / 1000}s`);
  console.log(`📊 Bond filter: ${MIN_BOND_PCT}% – ${MAX_BOND_PCT}%`);
  console.log(`💬 Min replies: ${MIN_REPLIES}`);
  console.log(`📤 Sending to chat: ${CHAT_ID}`);

  bot.start({ drop_pending_updates: true });
  console.log("✅ Bot listening for commands...");

  await sleep(3000);
  await scan();

  setInterval(scan, POLL_INTERVAL);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

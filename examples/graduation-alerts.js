// Example: push lifecycle alerts (near graduation, graduation, DAMM v2 migration, whale buys)
// to a Discord and/or Telegram channel. ~40 lines on top of DBC Flow.
//
//   DBC_FLOW_URL=https://your-dbc-flow.app DISCORD_WEBHOOK=https://discord.com/api/webhooks/... node examples/graduation-alerts.js
//   (or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
import { DbcFlow } from '../packages/client/index.js';

const flow = new DbcFlow({ baseUrl: process.env.DBC_FLOW_URL || 'http://localhost:4100' });
const usd = (v) => (v == null ? '?' : `$${Math.round(v).toLocaleString('en-US')}`);

function format(e) {
  const t = `${e.symbol || e.mint?.slice(0, 6)}`;
  switch (e.type) {
    case 'near_graduation': return `🔥 ${t} is at ${e.progress.toFixed(1)}% of its bonding curve (mcap ${usd(e.mcapUsd)}${e.etaSec ? `, ETA ~${Math.round(e.etaSec / 60)}m` : ''})`;
    case 'graduated': return `🎓 ${t} completed its DBC curve — ${e.quoteReserve.toFixed(2)} ${e.quoteSymbol} raised`;
    case 'migrated': return `🌊 ${t} migrated to ${e.target}: https://www.meteora.ag/dammv2/${e.dammPool}`;
    case 'swap': return `🐋 Whale buy on ${t}: ${usd(e.usd)} at ${e.progress?.toFixed(1)}% · ${e.trader}`;
    default: return null;
  }
}

async function send(text) {
  console.log(text);
  if (process.env.DISCORD_WEBHOOK) {
    await fetch(process.env.DISCORD_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) }).catch(() => {});
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    }).catch(() => {});
  }
}

for await (const e of flow.stream({ types: ['near_graduation', 'graduated', 'migrated', 'whale'] })) {
  const text = format(e);
  if (text) await send(text);
}

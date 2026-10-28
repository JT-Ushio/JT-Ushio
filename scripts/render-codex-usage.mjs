import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Render an editable SVG from real account totals. No GitHub display name is used.
// Run with --refresh to read current usage through the installed Codex App Server.
const dataPath = new URL('../assets/codex-usage-data.json', import.meta.url);
const imagePath = new URL('../assets/codex-usage.svg', import.meta.url);
const summaryFields = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];

function cleanUsage(value) {
  const summary = {};
  for (const key of summaryFields) {
    const number = value.summary?.[key];
    if (number !== null && (!Number.isSafeInteger(number) || number < 0)) throw new Error(`Invalid ${key}`);
    summary[key] = number;
  }
  const dailyUsageBuckets = value.dailyUsageBuckets === null ? null : value.dailyUsageBuckets.map(bucket => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) || !Number.isSafeInteger(bucket.tokens) || bucket.tokens < 0) throw new Error('Invalid daily bucket');
    return { startDate: bucket.startDate, tokens: bucket.tokens };
  });
  if (!Number.isFinite(Date.parse(value.capturedAt))) throw new Error('Invalid capture date');
  return { capturedAt: value.capturedAt, source: 'Codex account/usage/read', summary, dailyUsageBuckets };
}

async function readCurrentUsage() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out; the saved snapshot was retained.')), 30000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(result);
    }
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('Could not start codex app-server.')));
    child.on('exit', () => { if (!settled) finish(new Error('Codex App Server exited before returning usage.')); });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) {
        finish(new Error(`Codex RPC ${message.id} failed with code ${message.error.code}; the saved snapshot was retained.`));
      } else if (message.id === 0) {
        send({ method: 'initialized', params: {} });
        send({ method: 'account/usage/read', id: 1 });
      } else if (message.id === 1) {
        finish(null, { ...message.result, capturedAt: new Date().toISOString() });
      }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'profile_usage_card', title: 'Profile Usage Card', version: '1.0.0' } } });
  });
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
const fullNumber = value => value === null ? 'Unavailable' : new Intl.NumberFormat('en-US').format(value);
function shortNumber(value) {
  if (value === null) return '—';
  for (const [unit, suffix, decimals] of [[1e9, 'B', 2], [1e6, 'M', 1], [1e3, 'K', 1]]) {
    if (value >= unit) return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(value / unit) + suffix;
  }
  return String(value);
}

function renderCard(data, colors = ['#17375e', '#245b94', '#398de0', '#8cc7ff']) {
  const parts = [];
  const text = (x, y, label, size = 20, color = '#8b949e', weight = 400, extra = '') => parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${escape(label)}</text>`);
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="490" viewBox="0 0 1200 490" role="img" aria-labelledby="title desc">');
  parts.push('<title id="title">Codex usage for @JT-Ushio</title>');
  parts.push(`<desc id="desc">${escape(fullNumber(data.summary.lifetimeTokens))} lifetime tokens. ${escape(data.summary.currentStreakDays)} current streak days. Snapshot ${escape(data.capturedAt)}.</desc>`);
  parts.push('<rect x="1" y="1" width="1198" height="488" rx="18" fill="#0d1117" stroke="#30363d" stroke-width="2"/>');
  parts.push('<g font-family="Arial, Helvetica, sans-serif">');
  parts.push('<circle cx="49" cy="52" r="7" fill="#3fb950"/>');
  text(68, 63, 'Codex', 32, '#e6edf3', 700);
  text(190, 62, '@JT-Ushio', 23, '#8b949e');
  text(1158, 60, 'Account token activity', 19, '#8b949e', 400, 'text-anchor="end"');
  parts.push('<path d="M40 90H1160" stroke="#30363d"/>');
  const stats = [
    ['Lifetime tokens', shortNumber(data.summary.lifetimeTokens), fullNumber(data.summary.lifetimeTokens)],
    ['Peak day', shortNumber(data.summary.peakDailyTokens), fullNumber(data.summary.peakDailyTokens)],
    ['Current streak', data.summary.currentStreakDays === null ? '—' : `${data.summary.currentStreakDays} days`, `${data.summary.currentStreakDays ?? 'Unavailable'}`],
    ['Longest streak', data.summary.longestStreakDays === null ? '—' : `${data.summary.longestStreakDays} days`, `${data.summary.longestStreakDays ?? 'Unavailable'}`]
  ];
  stats.forEach(([label, value, exact], i) => {
    const x = 40 + 285 * i;
    if (i) parts.push(`<path d="M${x - 20}114V190" stroke="#21262d"/>`);
    text(x, 128, label, 20);
    parts.push(`<g><title>${escape(exact)}</title>`);
    text(x, 183, value, 46, '#e6edf3', 600);
    parts.push('</g>');
  });
  text(40, 237, 'Daily token activity', 20, '#e6edf3', 500);
  const buckets = new Map((data.dailyUsageBuckets ?? []).map(bucket => [bucket.startDate, bucket.tokens]));
  const positives = [...buckets.values()].filter(value => value > 0).sort((a, b) => a - b);
  const thresholds = [0.25, 0.5, 0.75].map(q => positives[Math.min(positives.length - 1, Math.floor(positives.length * q))] ?? Infinity);
  const end = new Date(data.capturedAt.slice(0, 10) + 'T00:00:00Z');
  const sunday = new Date(end);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay() - 52 * 7);
  let lastMonth = null;
  for (let column = 0; column < 53; column++) {
    const week = new Date(sunday);
    week.setUTCDate(week.getUTCDate() + column * 7);
    if (week.getUTCMonth() !== lastMonth) {
      if ((column > 0 || week.getUTCDate() <= 7) && column < 51) {
        text(40 + column * 21, 266, week.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), 16);
      }
      lastMonth = week.getUTCMonth();
    }
    for (let row = 0; row < 7; row++) {
      const day = new Date(week);
      day.setUTCDate(day.getUTCDate() + row);
      if (day > end) continue;
      const date = day.toISOString().slice(0, 10);
      const tokens = buckets.get(date);
      const fill = tokens === undefined ? '#161b22' : tokens === 0 ? '#21262d' : colors[thresholds.filter(threshold => tokens > threshold).length];
      parts.push(`<rect x="${40 + column * 21}" y="${280 + row * 21}" width="16" height="16" rx="3" fill="${fill}"><title>${escape(date)}: ${tokens === undefined ? 'No reported data' : escape(fullNumber(tokens)) + ' tokens'}</title></rect>`);
    }
  }
  const date = new Date(data.capturedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Shanghai' });
  text(40, 459, `${buckets.size} reported days · Snapshot ${date}`, 17);
  text(932, 458, 'Less', 16);
  ['#21262d', ...colors].forEach((fill, i) => parts.push(`<rect x="${974 + i * 21}" y="444" width="15" height="15" rx="3" fill="${fill}"/>`));
  text(1090, 458, 'More', 16);
  parts.push('</g></svg>');
  return parts.join('\n') + '\n';
}

const refreshed = process.argv.includes('--refresh');
const raw = refreshed ? await readCurrentUsage() : JSON.parse(await readFile(dataPath, 'utf8'));
const data = cleanUsage(raw);
const svg = renderCard(data);
if (refreshed) await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n');
await writeFile(imagePath, svg);
console.log(`Rendered assets/codex-usage.svg from ${data.capturedAt}; no display name is included.`);

if (process.argv.includes('--variants')) {
  const palettes = {
    blue: ['#17375e', '#245b94', '#398de0', '#8cc7ff'],
    purple: ['#352046', '#653d8a', '#a365d9', '#d4a1ff']
  };
  for (const [name, colors] of Object.entries(palettes)) {
    await writeFile(new URL(`../assets/codex-usage-${name}.svg`, import.meta.url), renderCard(data, colors));
  }
  console.log('Rendered separate blue and purple comparison versions.');
}

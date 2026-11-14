// Weekly welcome-offer check (CI): for every card with a signupBonus, fetch
// the issuer page and look for the recorded numbers. Offers change far more
// often than benefits do, and a stale one is prefilled into an app's
// add-card form — so a page that no longer shows the recorded amount or
// minimum spend is listed in offer-changes.md for a human to re-read.
//
// This only says "the numbers are gone", never what the new offer is: read
// the issuer's page in full and update signupBonus (amount, spend, days,
// asOf) by hand, or remove it if the page shows no fixed public offer.
//
// A page that can't be fetched (bot protection on CI IPs, timeout) proves
// nothing either way; those are listed separately and never flagged.
//
//   node scripts/check-offers.mjs

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// Desktop Safari: several issuers serve the offer only in the desktop page.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });

const grouped = (n) => n.toLocaleString('en-US');
// The ways a page may print a number: "75,000", "75K", and for dollars
// "$5,000" / "$5K". A bare "500" would match almost any page, so dollar
// figures need their sign.
function forms(n, dollars) {
  const out = [];
  if (dollars) out.push(`$${grouped(n)}`);
  else out.push(grouped(n));
  if (n >= 1000 && n % 1000 === 0) out.push(dollars ? `$${n / 1000}K` : `${n / 1000}K`);
  return out;
}

// What must still be on the page. A cash bonus on a points card is recorded
// in points (Freedom: 20,000) while the page advertises dollars ($200) —
// the dollar figure in `details` counts as the amount too.
export function expectations(card) {
  const sb = card.signupBonus;
  const cash = card.currency === 'USD';
  const amount = forms(sb.amount, cash);
  for (const m of (sb.details ?? '').matchAll(/\$[\d,]+/g)) amount.push(m[0]);
  return { amount, spend: sb.spend > 0 ? forms(sb.spend, true) : null };
}

// Visible text plus the text inside scripts (many issuers render the offer
// from embedded JSON), with tags, entities and whitespace flattened.
const flatten = (html) =>
  html
    .replace(/\\u0026/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#36;/g, '$')
    .replace(/\s+/g, ' ');

const has = (text, list) => list.some((f) => text.toLowerCase().includes(f.toLowerCase()));

async function page(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return res.ok ? { text: flatten(body) } : { why: `HTTP ${res.status}` };
  } catch (e) {
    return { why: e.name === 'AbortError' ? 'timeout' : `error: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

const jobs = [];
for (const file of walk(join(ROOT, 'cards'))) {
  const card = JSON.parse(readFileSync(file, 'utf8'));
  if (card.signupBonus && card.url && !card.discontinued) jobs.push({ rel: relative(ROOT, file), card });
}

const changed = [];
const unread = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let j; (j = queue.shift()); ) {
      const want = expectations(j.card);
      let got;
      let missing = [];
      // Some sites answer 200 with a placeholder page when several requests
      // arrive together (skypassvisa.com), so a miss is re-read once, alone
      // in time, before it is believed.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 5000));
        got = await page(j.card.url);
        if (got.why) continue;
        missing = [];
        if (!has(got.text, want.amount)) missing.push(`amount ${want.amount[0]}`);
        if (want.spend && !has(got.text, want.spend)) missing.push(`spend ${want.spend[0]}`);
        if (!missing.length) break;
      }
      if (got.why) unread.push({ ...j, why: got.why });
      else if (missing.length) changed.push({ ...j, missing });
    }
  }),
);

const byFile = (a, b) => a.rel.localeCompare(b.rel);
const sb = (c) => c.card.signupBonus;
const report = [
  `${changed.length} welcome offer(s) no longer match the issuer page (${new Date().toISOString().slice(0, 10)}; ${jobs.length} checked, ${unread.length} unreadable).`,
  '',
  'The recorded number is not on the page any more. Read the page in full, then update `signupBonus` (and its `asOf`) or remove it if there is no fixed public offer. Run `npm run build` and commit the export.',
  '',
  ...changed
    .sort(byFile)
    .map(
      (c) =>
        `### \`${c.rel}\`\nRecorded ${sb(c).asOf}: ${grouped(sb(c).amount)} after $${grouped(sb(c).spend)} in ${sb(c).days} days. Not found: ${c.missing.join(', ')}.\n${c.card.url}\n`,
    ),
  `## Pages that could not be read (${unread.length})`,
  'Bot protection or a timeout on CI. Nothing is known about these offers this week.',
  '',
  unread.length
    ? '| File | Problem | URL |\n|---|---|---|\n' +
      unread.sort(byFile).map((u) => `| \`${u.rel}\` | ${u.why} | ${u.card.url} |`).join('\n')
    : 'None 🎉',
  '',
].join('\n');
writeFileSync(join(ROOT, 'offer-changes.md'), report);
console.log(report);

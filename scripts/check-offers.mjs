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
// A page that can't be read (bot protection on CI IPs, timeout, no browser
// to render it) proves nothing either way; those are listed separately and
// never flagged.
//
//   node scripts/check-offers.mjs

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fetchHtml, flatten, renderHtml } from './lib/page.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
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

const has = (text, list) => list.some((f) => text.toLowerCase().includes(f.toLowerCase()));

function misses(text, want) {
  const out = [];
  if (!has(text, want.amount)) out.push(`amount ${want.amount[0]}`);
  if (want.spend && !has(text, want.spend)) out.push(`spend ${want.spend[0]}`);
  return out;
}

// Raw HTML first (scripts included: many issuers embed the offer as JSON).
// A miss there proves nothing — americanexpress.com and others draw the
// offer with JavaScript — so it is rendered in a browser before it counts.
// Some sites also answer 200 with a placeholder when several requests land
// together (skypassvisa.com); the render, one at a time, covers that too.
async function check(card) {
  const want = expectations(card);
  const raw = await fetchHtml(card.url);
  if (raw.html && !misses(flatten(raw.html, { scripts: true }), want).length) return {};
  const dom = await renderHtml(card.url);
  if (dom.html) {
    const missing = misses(flatten(dom.html), want);
    if (!missing.length) return {};
    // Amex business pages often come back with the offer block still a
    // "Loading" placeholder. Give the page real time once more; if the
    // placeholder is still there the page was not read, which is not the
    // same as the offer having changed.
    const slow = await renderHtml(card.url, { slow: true });
    const text = slow.html ? flatten(slow.html) : '';
    const still = slow.html ? misses(text, want) : missing;
    if (!still.length) return {};
    if (/ Loading /.test(text || flatten(dom.html))) return { why: 'offer block still loading after two renders' };
    return { missing: still };
  }
  // No browser, or it failed: only a readable raw page can be judged, and
  // then only after a second, quieter read.
  if (!raw.html) return { why: `${raw.why}; ${dom.why}` };
  await new Promise((r) => setTimeout(r, 5000));
  const again = await fetchHtml(card.url);
  if (again.html && !misses(flatten(again.html, { scripts: true }), want).length) return {};
  return { why: `not in the raw HTML; ${dom.why}` };
}

const only = process.argv[2];
const jobs = [];
for (const file of walk(join(ROOT, 'cards'))) {
  const card = JSON.parse(readFileSync(file, 'utf8'));
  // `node scripts/check-offers.mjs citi/` checks only the files whose path has that text.
  if (only && !relative(ROOT, file).includes(only)) continue;
  if (card.signupBonus && card.url && !card.discontinued) jobs.push({ rel: relative(ROOT, file), card });
}

const changed = [];
const unread = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let j; (j = queue.shift()); ) {
      const r = await check(j.card);
      if (r.why) unread.push({ ...j, why: r.why });
      else if (r.missing?.length) changed.push({ ...j, missing: r.missing });
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
  'Bot protection, a timeout, or a script-drawn page with no browser to render it. Nothing is known about these offers this week.',
  '',
  unread.length
    ? '| File | Problem | URL |\n|---|---|---|\n' +
      unread.sort(byFile).map((u) => `| \`${u.rel}\` | ${u.why} | ${u.card.url} |`).join('\n')
    : 'None 🎉',
  '',
].join('\n');
writeFileSync(join(ROOT, 'offer-changes.md'), report);
console.log(report);

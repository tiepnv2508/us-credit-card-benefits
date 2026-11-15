// Read an issuer page the way a maintainer has to: raw HTML first, then a
// real browser render, and print the text around what you are looking for.
//
//   node scripts/read-page.mjs <card-id | url> [regex] [--render] [--live] [--click 'regex'] [--width N]
//
//   node scripts/read-page.mjs amex-platinum 'as high as|after you spend'
//   node scripts/read-page.mjs chase-sapphire-preferred 'bonus points'
//
// Without --render the raw HTML is searched first and the page is rendered
// only when the regex finds nothing there. --live opens the page over the
// DevTools protocol and waits (up to 45 s of real time) for the regex to
// appear: for a block the page fills in after load, which a render shows
// as "Loading"; --click 'offer details' (implies --live) first presses every
// button or in-page link with that label, for text that only loads on
// click. Default regex: welcome-offer wording. A card id reads the
// card's `signupBonus.source` when it has one, else its `url`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHtml, flatten, liveHtml, renderHtml } from './lib/page.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const width = Number(opt('--width', 320));
const click = opt('--click', null);
if (click) args.push('--live');
const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--width' && args[i - 1] !== '--click');
if (!pos[0]) {
  console.error('usage: node scripts/read-page.mjs <card-id | url> [regex] [--render] [--live] [--click regex] [--width N]');
  process.exit(2);
}
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });
let url = pos[0];
if (!/^https?:/.test(url)) {
  const card = walk(join(ROOT, 'cards')).map((f) => JSON.parse(readFileSync(f, 'utf8'))).find((c) => c.id === pos[0]);
  if (!card) {
    console.error(`no card with id ${pos[0]}`);
    process.exit(2);
  }
  url = card.signupBonus?.source ?? card.url;
}
const re = new RegExp(pos[1] ?? 'as high as|welcome offer|bonus (points|miles)|(after|once|when) you spend|after spending|upon spending|(if you make|after making) at least|statement credit after', 'gi');

function show(label, text) {
  const seen = new Set();
  let n = 0;
  for (const m of text.matchAll(re)) {
    const s = text.slice(Math.max(0, m.index - width / 3), m.index + m[0].length + width);
    const key = s.replace(/\W/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    if (n++ === 0) console.log(`\n== ${label} (${text.length} chars) ==`);
    console.log(`- ${s.trim()}`);
    if (n >= 8) break;
  }
  return n;
}

console.log(url);
let found = 0;
if (!flag('--render') && !flag('--live')) {
  const raw = await fetchHtml(url);
  if (raw.why) console.log(`raw fetch: ${raw.why}`);
  else found = show('raw HTML, scripts included — check the match is about THIS card', flatten(raw.html, { scripts: true }));
}
if (!found && !flag('--live')) {
  const dom = await renderHtml(url);
  if (dom.why) console.log(`render: ${dom.why}`);
  else found = show('rendered page', flatten(dom.html));
}
if (!found && flag('--live')) {
  const probe = new RegExp(re.source, 'i');
  const live = await liveHtml(url, { ready: (t) => probe.test(t), click });
  if (live.why) console.log(`live render: ${live.why}`);
  else found = show('live page', flatten(live.html));
}
if (!found) console.log(`\nNothing matched. Try another regex${flag('--live') ? '' : ', then --live,'} before calling it missing.`);

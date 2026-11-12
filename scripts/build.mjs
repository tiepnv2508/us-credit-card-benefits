// Validates every cards/**/*.json against schema/card.schema.json plus the
// rules JSON Schema can't express, then writes exports/benefits.json — the
// single file apps fetch.
//
//   npm run build      validate + (re)write exports/benefits.json
//   npm run validate   validate + fail if exports/benefits.json is stale (CI)
//   node scripts/build.mjs --dry   validate only

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = new URL('..', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');
// --dry: validate only (no export read/write) — safe to run in parallel.
const DRY = process.argv.includes('--dry');
// Words matchers ignore — a keyword made only of these would match every
// credit on the card.
const GENERIC = new Set([
  'the', 'and', 'for', 'per', 'each', 'credit', 'credits', 'fee', 'fees', 'annual',
  'monthly', 'quarterly', 'semiannual', 'semi', 'statement', 'card', 'reward', 'rewards',
  'promo', 'membership', 'amex', 'american', 'express', 'chase', 'citi', 'capital', 'bank',
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, 'schema/card.schema.json'), 'utf8')));

const errors = [];
const cards = [];
const seenIds = new Map();
for (const file of walk(join(ROOT, 'cards')).sort()) {
  const rel = relative(ROOT, file);
  let card;
  try {
    card = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${rel}: invalid JSON — ${e.message}`);
    continue;
  }
  if (!validate(card)) {
    for (const e of validate.errors) errors.push(`${rel}: ${e.instancePath || '/'} ${e.message}`);
    continue;
  }
  if (seenIds.has(card.id)) errors.push(`${rel}: id also used by ${seenIds.get(card.id)}`);
  seenIds.set(card.id, rel);
  const ids = new Set();
  for (const b of card.benefits) {
    if (ids.has(b.id)) errors.push(`${rel}: duplicate benefit id "${b.id}"`);
    ids.add(b.id);
    if (b.type === 'credit' && !b.inApp && b.matchKeywords.length === 0)
      errors.push(`${rel}: "${b.id}" is a statement credit but has no matchKeywords`);
    if (b.matchKeywords.length > 0 && b.matchKeywords.every((k) => GENERIC.has(k)))
      errors.push(`${rel}: "${b.id}" matchKeywords are all generic words (${b.matchKeywords.join(', ')})`);
    // A generic keyword next to specific ones is silently ignored by the
    // app's matcher — it only hides that the list is weaker than it looks.
    const generic = b.matchKeywords.filter((k) => GENERIC.has(k));
    if (generic.length > 0 && generic.length < b.matchKeywords.length)
      errors.push(`${rel}: "${b.id}" has generic matchKeywords that matchers ignore (${generic.join(', ')}) — remove them`);
    // CONTRIBUTING rule 6: a spend-gated perk is never always-on.
    if (b.unlockSpend && b.autoApplied)
      errors.push(`${rel}: "${b.id}" has both unlockSpend and autoApplied — a spend-gated perk is never autoApplied`);
    if (b.matchVerified && !(b.descriptorExamples?.length))
      errors.push(`${rel}: "${b.id}" is matchVerified but has no descriptorExamples`);
  }
  if (card.earn) {
    const seen = new Set();
    for (const r of card.earn.rates) {
      const key = `${r.category}|${r.channel}|${r.merchants ?? ''}`;
      if (seen.has(key)) errors.push(`${rel}: duplicate earn rate ${key}`);
      seen.add(key);
      if (r.category === 'brand' && !r.merchants)
        errors.push(`${rel}: earn rate "brand" needs merchants`);
      if (r.rate <= card.earn.baseRate && !r.cap && !r.note)
        errors.push(`${rel}: earn rate ${r.category} is not above baseRate`);
    }
  }
  const { $schema, ...data } = card;
  cards.push(data);
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

cards.sort((a, b) => a.issuer.localeCompare(b.issuer) || a.name.localeCompare(b.name));
const pointValues = JSON.parse(readFileSync(join(ROOT, 'data/point-values.json'), 'utf8'));
const codes = new Set(cards.map((c) => c.currency));
for (const code of Object.keys(pointValues.values)) {
  if (!codes.has(code)) {
    console.error(`✗ data/point-values.json: no card uses currency ${code}`);
    process.exit(1);
  }
}
// Programs (data/programs.json → images/programs/). Card currencies get
// a name and logo; loyalty programs no card here earns (JAL, Accor,
// Hertz…) also need a kind and unit, so apps can list them for transfers
// and membership numbers. The export carries name, kind, unit and the raw
// GitHub logo URL; source and license stay in the data file.
const LOGO_BASE = 'https://raw.githubusercontent.com/tiepnv2508/us-credit-card-benefits/main/';
const PROGRAM_KINDS = new Set(['airline', 'hotel', 'car_rental', 'cruise', 'rail', 'bank', 'other']);
const programData = JSON.parse(readFileSync(join(ROOT, 'data/programs.json'), 'utf8')).programs;
const programs = {};
for (const [code, p] of Object.entries(programData).sort(([a], [b]) => a.localeCompare(b))) {
  const fail = (msg) => {
    console.error(`✗ data/programs.json: ${code} ${msg}`);
    process.exit(1);
  };
  if (!/^[A-Z_]{2,40}$/.test(code) || code === 'USD') fail('is not a valid program code');
  if (!p.name || p.name.length > 60) fail('needs a name (60 characters at most)');
  if (p.kind !== undefined && !PROGRAM_KINDS.has(p.kind)) fail(`has an unknown kind (${p.kind})`);
  if (p.unit !== undefined && p.unit !== 'points' && p.unit !== 'miles') fail(`has an unknown unit (${p.unit})`);
  if (!codes.has(code) && (!p.kind || !p.unit)) fail('is earned by no card, so it needs a kind and unit');
  if (p.logo !== undefined) {
    if (!/^images\/programs\/[A-Z_]+\.png$/.test(p.logo) || !existsSync(join(ROOT, p.logo))) fail(`logo missing or misnamed (${p.logo})`);
    if (!p.source || !p.license) fail('logo needs a source and license');
  }
  programs[code] = {
    name: p.name,
    ...(p.kind ? { kind: p.kind } : {}),
    ...(p.unit ? { unit: p.unit } : {}),
    ...(p.logo ? { logoUrl: LOGO_BASE + p.logo } : {}),
  };
}
const out =
  JSON.stringify(
    {
      schemaVersion: 2,
      cardCount: cards.length,
      benefitCount: cards.reduce((n, c) => n + c.benefits.length, 0),
      pointValues,
      programs,
      cards,
    },
    null,
    2,
  ) + '\n';
const exportPath = join(ROOT, 'exports/benefits.json');
let current = '';
try {
  current = readFileSync(exportPath, 'utf8');
} catch {}
if (DRY) {
  // validation only
} else if (CHECK) {
  if (current !== out) {
    console.error('✗ exports/benefits.json is out of date — run `npm run build` and commit it.');
    process.exit(1);
  }
} else if (current !== out) {
  writeFileSync(exportPath, out);
}
console.log(`✓ ${cards.length} cards, ${cards.reduce((n, c) => n + c.benefits.length, 0)} benefits`);

---
name: card-catalog
description: Scan issuer pages and update the us-credit-card-benefits catalog (welcome offers, benefits, earn rates, fees, card images). Use for any "scan / update / verify the card catalog" task, the weekly "Welcome offers changed" and image issues, the monthly review, adding a card, or when a card's data looks stale in the app. Covers how to read pages that hide content behind JavaScript, what to record, and how to ship.
---

# card-catalog

The catalog is one JSON file per card in `cards/<issuer>/<slug>.json`;
`npm run build` validates them and writes `exports/benefits.json`, which
apps fetch live. Every value comes from the issuer's own page, read in
full, on a known date. `CONTRIBUTING.md` holds the field rules (numbered);
this skill is the procedure. Run everything from the repo root:
`/Volumes/MiaXiu/Dev/Projects/us-credit-card-benefits` on the owner's Mac.

## The one rule that keeps getting broken

**"The fetched HTML doesn't show it" is never a finding.** Twice a scan
skipped dozens of cards (benefits in 2026-10, Amex welcome offers in
2026-11) because a plain fetch came back without the numbers. The numbers
were on the page; JavaScript drew them. Do not skip a card because its
page is hard to read — find the way to read it, and only then report it
unreadable, naming every method tried.

Read a page with the repo's reader, which fetches the raw HTML and falls
back to a real headless-Chrome render:

```sh
node scripts/read-page.mjs <card-id | url> ['regex'] [--render] [--width N]
node scripts/read-page.mjs amex-platinum 'as high as|after you spend'
```

Ladder, in order. Stop at the first rung that shows the text:

1. **Raw HTML** (the reader's first try). Matches may come from inside
   `<script>` data, so confirm the snippet names THIS card — Amex ships
   other cards' offers in shared script data on every page.
2. **Rendered page** (`--render`, or automatic when raw finds nothing).
3. **Hidden content**: accordions, tabs, "See more benefits", "Offer
   details", footnote overlays. If the text only loads on click, drive a
   browser (Playwright) and click every expander. Terms, caps and end
   dates usually live there.
4. **Another official host for the same card**: Chase-hosted co-brand
   pages (`creditcards.chase.com/...`), the partner's page (Schwab, Morgan
   Stanley, Hilton, Delta), the issuer's terms/disclosure endpoints.
5. **Ask the owner for a screenshot** of the page. Then, and only then,
   list the card as unreadable.

Never fill a field from memory, a blog, a forum or an AI answer. Those
are leads to go and confirm on the issuer's page, nothing more.

## Issuer notes

| Issuer | What works (verified 2026-11-14) |
|---|---|
| American Express (americanexpress.com) | Raw HTML is ~2–4 MB with benefits embedded, but the welcome offer is script-drawn: render. Pages say "Apply and find out your welcome offer — AS HIGH AS N". Business pages return nothing under `--virtual-time-budget`; the reader's second attempt (`--timeout`) gets them. Six business pages (Blue Business Cash/Plus, Business Gold/Green, Delta Gold Business, Marriott Business) kept "Loading" in the offer block even after 75 s headless: next rung is a real browser session or an owner screenshot. |
| Hilton cards | All four offers and spend lines are on `hilton.com/en/hilton-honors/credit-cards/`, rendered. Each card's `url` points there. |
| Chase | Raw HTML carries offers and terms. United/Southwest/etc.: use the Chase-hosted URL, the airline's own card site blocks bots. Benefit terms differ card by card; never generalize across the issuer. |
| Citi | Raw fetch shows no offer; a render shows it in the hero ("Earn N bonus points after spending $X in the first 3 months"). Store cards mostly have a first-purchase discount, not a bonus. |
| Capital One | Mostly raw. Venture X needs a render; the line reads "Early Spend Bonus … once you spend", so search for `once you spend`, not only `after you spend`. |
| Bank of America | Raw pages are empty shells; a render shows "N online bonus points … if you make at least $X in purchases in the first 90 days" (wording varies: "Online Offer:", "online cash rewards bonus"). Fallback: `bankofamerica.com/salesservices/productProperties` and `/salesservices/getDisclosure`. |
| Discover | Rendered. Most cards have only Cashback/Miles Match (no spend bonus); the main Discover it page may add a statement-credit bonus. |
| PenFed | Renders fine in headless Chrome (plain fetch is blocked). The bonus amount sits in a footnote ("^ 50,000 bonus points when you spend…"). |
| lifemiles.com, amtrak.com, virgin.com, aaa.com | Render; both card tiers share one page, so match the snippet to the card name. |
| wyndhamrewardscreditcard.com | Render shows the points but the spend lines are inside "Introductory Bonus Offer Details" overlays: needs a click (rung 3). |
| skypassvisa.com | Returns a placeholder to parallel requests; read one page at a time. |
| alaskaair.com, expedia.com, bestwestern.com, latam.com, rakuten.com | Bot wall or empty render in headless Chrome. Don't try to defeat it. First look for the same card on the ISSUING BANK's own site, which often reads fine: Atmos Business is on bankofamerica.com/smallbusiness, One Key on creditcards.wellsfargo.com (start from the bank's card listing and follow its links; guessed addresses mostly miss). Point the card's `url` at the page you read so the weekly check can read it too. Only then ask the owner for a screenshot. |

Search wording varies by issuer: try `after you spend`, `after spending`, `once you spend`, `when you spend`, `if you make at least`, `after making at least`, `Upon spending` before concluding a page has no offer.

Add a row whenever a new trick is needed. That is the point of this table.

## What to record

**Welcome offer (`signupBonus`, rule 14)** — `amount` in the card's
`currency`, `spend` in dollars, `days` (3 months → 90, 6 → 180), `asOf` =
the day you read it, optional `details`.
- A cash bonus on a points card is stored in points ("$200" on a Chase
  Freedom → `20000`), with the dollar figure in `details`.
- **"As high as N" / "up to N" offers: record N** (owner call 2026-11-14)
  and start `details` with "As high as N; your offer may be lower." Apps
  prefill it and the user edits.
- Leave it out only when the page states no number at all, the reward is
  only free nights or a gift card (points plus a free night: record the
  points, name the night in `details`), or there is no spend requirement
  (bonus on approval or on first purchase).
- Two tiers (60k after $4.5k, 40k more after $25k in a year): record the
  first tier, put the second in `details`.
- Extras (second tier, statement credit, fee must be paid) go in `details`.

**Benefits, earn rates, fees, images** — rules 1–13 in `CONTRIBUTING.md`.
The ones scans get wrong: a benefit the issuer ended gets `endDate`, never
a deletion (rule 11); `value` is per period (rule 2); `matchVerified` only
with a real posted descriptor (rule 8); images are flat card art with no
promo overlay, hotlinked from the issuer.

## Procedure

1. `git checkout main && git pull`, then a branch (`review/YYYY-MM`, or a
   named one). Never push to main.
2. Scope: the cards named in the task or issue; for a monthly review,
   Amex/Chase/Citi/Capital One plus anything with `lastVerified` older
   than 120 days; everything in Jan/Apr/Jul/Oct.
3. For each card run `read-page`, read the snippets (and the full page
   when terms matter), edit the card file, set `asOf` / `lastVerified`.
4. `npm run build` (validates + writes the export), then
   `npm run check-offers` — it re-reads every recorded offer, rendering
   when needed; expect 0 flagged. A flag on a card you just edited means
   your number is not on the page. `node scripts/check-offers.mjs citi/`
   re-checks only the files whose path has that text. "Offer block still
   loading" under could-not-read is Amex's placeholder, not a changed
   offer: run it again later before touching the card.
5. Commit card files and `exports/benefits.json` together, open a PR that
   lists what changed, what was left out and why (with the method tried),
   and anything that needs the owner's eyes.
6. Report in three lists: updated, unchanged-confirmed, could-not-read
   (with rungs tried). No silent skips.

The Min app bundles a copy: after a merge, in the app repo
`cp ../us-credit-card-benefits/exports/benefits.json src/data/cardCatalogBundled.json`
(installed apps get the live export on their own).

## Weekly issues

- **Welcome offers changed — review**: the recorded amount or spend is no
  longer on the page. Read the page, update or remove `signupBonus`,
  build, PR. The issue closes itself on the next clean run.
- **Card images changed — review** / **Broken card image links**: see the
  README image rules; accept reviewed changes with the workflow's
  `accept=true` input.

## Limits

- Only public pages. No logging in, no CAPTCHA or bot-wall bypassing.
- Only issuer and official-partner pages count as sources.
- Never use any app user's data for catalog content.

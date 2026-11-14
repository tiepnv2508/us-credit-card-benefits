# Contributing

Thanks for helping! Every card lives in its own file: `cards/<issuer>/<card-slug>.json` — including cards with no recurring benefits (`benefits: []`), so the dataset is also a full card catalog.

## Rules

1. **List every recurring benefit** on the issuer's benefits page — including ones you don't personally use. Apps let users untick benefits they don't want; a missing benefit can't be tracked at all.
2. **`value` is per period.** A "$120/year dining credit, $10 per month" is `value: 10`, `frequency: "monthly"`.
3. **`frequency: "custom"`** needs `intervalMonths` (Global Entry every 4 years → `48`).
4. **`inApp: true`** when the credit is applied inside a partner app or issuer portal (Uber Cash, DashPass, Lyft, travel-portal credits) and no statement credit posts. These have empty `matchKeywords`.
5. **`autoApplied: true`** (perks only) when the perk is always on while you hold the card — elite status, lounge membership, Priority Pass, free checked bags, a flight discount, points deposited automatically each anniversary. Leave it out for anything you have to redeem (free nights, companion certificates, a fixed number of lounge passes, vouchers, upgrade coupons). `node scripts/autoapplied.mjs` suggests it for new perks by name — review its diff.
6. **`unlockSpend`** when the benefit only exists after the card's TOTAL purchases reach a threshold in a calendar or cardmember year (Sapphire Reserve's $500 Southwest credit after $75,000; a free night after $15,000). Not for merchant-specific thresholds ("$5,000 with Dell") or for spend that only upgrades a benefit you already have (Sky Club visits → unlimited); keep those in `notes`. Never combine with `autoApplied`.
7. **`matchKeywords`** are lower-case words that appear **whole** in the posted credit's description. Use the most specific word(s): `["resy"]`, `["clear"]`, `["dunkin"]`. Generic words (`credit`, `fee`, `annual`, `amex`, `chase`…) are ignored by matchers — never rely on them alone.
8. **`matchVerified: true` only if you've seen the credit post**, and add the exact text to `descriptorExamples`. Please redact anything personal (amounts are fine to omit).
9. **Read the hidden parts of the page.** Issuer pages tuck benefits and their terms behind "See more benefits", "Show more", "+" accordions, tabs, "Offer details" links and footnote overlays — cadence, caps, enrollment and end dates usually live in those footnotes. Expand everything (or, when scripting, confirm that content is in the raw HTML; if it only loads on click, drive a real browser such as Playwright and click every expander). Never conclude a benefit was removed just because the visible page didn't show it.
10. **Sources:** link the issuer's own benefits page whenever possible, and set `lastVerified` to the day you checked it.
11. **Never delete a benefit the issuer ended — set `endDate`** (the last day it was available, YYYY-MM-DD). Apps use `endDate` to retire copies users already track; a benefit that simply disappears from the file is treated as unknown, not ended. Benefit `id`s are permanent and only need to be unique within a card.

12. **`earn` comes only from the issuer's own page, read in full.** Never fill it from memory, a blog or an AI answer. If the page can't confirm a rate, leave the whole `earn` field out. Set `channel` honestly: a rate that needs the issuer's portal is `issuer_portal`, one that needs booking direct is `direct`. Record caps, end dates and activation terms. A hotel or airline's own purchases are `brand` with `merchants`.
13. **`data/point-values.json` is an estimate, not a fact from an issuer.** Each value is the median of the listed public valuation sources, rounded to 0.05. Update it from those sources together and change `asOf`; don't adjust one program by opinion. The only exception is a program listed under `ownerSet`: the owner chose that value, so leave it alone and report the current median in the review.
14. **`signupBonus` is the public welcome offer on the issuer's own page, with the day you read it in `asOf`.** `amount` is in the card's `currency` (points or miles; dollars only for a `USD` card — a "$200 bonus" on a card that earns points is `20000` with the dollar figure in `details`), `spend` is the purchase requirement in dollars, `days` the window (3 months → `90`). Leave it out when the page shows no fixed offer: "apply to see your offer", "up to" amounts, free-night offers, or a bonus for the first purchase with no spend requirement. A weekly job (`scripts/check-offers.mjs`) re-reads every page and opens a **Welcome offers changed — review** issue when a recorded number is no longer on it; it can't tell what the new offer is, so re-read the page and update or remove the entry.

## Workflow

```sh
npm install
npm run build      # validates and regenerates exports/benefits.json
```

Commit both your card file and `exports/benefits.json`. CI runs `npm run validate` on every pull request.

## Adding a new card

Create `cards/<issuer>/<card-slug>.json` and give it a new `id` of the form `<issuer-short>-<card-slug>` (e.g. `chase-sapphire-reserve`). Ids are permanent — never rename or reuse one; if a card is replaced, mark the old one `discontinued: true` and add a new file. Use the issuer's card page for `url`, `annualFee` and benefits.

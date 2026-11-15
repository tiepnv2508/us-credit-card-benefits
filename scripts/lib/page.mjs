// Reading an issuer page, the two ways that work. Many issuers
// (americanexpress.com, Citi, Capital One, Bank of America) draw offers and
// terms with JavaScript, so the raw HTML has none of it: "the number is not
// in the fetched HTML" is never evidence that it is not on the page. Fetch
// first because it is fast and polite; render in a real browser before
// concluding anything is missing.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Text a person could read on the page. `scripts: true` keeps the text
// inside <script> too (some issuers embed the offer as JSON there) — only
// for raw HTML; a rendered DOM is read without scripts so shared script
// data (Amex ships other cards' offers on every page) can't match.
export function flatten(html, { scripts = false } = {}) {
  let t = html.replace(/\\u0026/g, '&');
  if (!scripts) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#36;/g, '$')
    .replace(/&reg;|&#174;|&trade;|®|™/g, ' ')
    .replace(/\s+/g, ' ')
    // Citi prints "$ 6,000".
    .replace(/\$ (?=\d)/g, '$');
}

export async function fetchHtml(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return res.ok ? { html: body } : { why: `HTTP ${res.status}` };
  } catch (e) {
    return { why: e.name === 'AbortError' ? 'timeout' : `error: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

export function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

// One render at a time: pages are heavy and issuers rate-limit bursts.
// Two attempts with different clocks: virtual time is quick and enough for
// most pages, but some never go idle under it (Amex business pages return
// nothing), so the second attempt lets the page run 40 real seconds.
let chain = Promise.resolve();
function dump(chrome, url, clock, ms) {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), 'catalog-chrome-'));
    execFile(
      chrome,
      ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`, `--user-agent=${UA}`, clock, '--dump-dom', url],
      { timeout: ms, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        rmSync(profile, { recursive: true, force: true });
        if (stdout && stdout.length > 20000) resolve({ html: stdout });
        else resolve({ why: err ? `render failed: ${err.killed ? 'timeout' : err.code ?? err.message}` : 'render returned an empty page' });
      },
    );
  });
}
// `slow: true` skips the quick attempt: for a page that rendered but whose
// offer block was still a placeholder.
export function renderHtml(url, { slow = false } = {}) {
  const chrome = findChrome();
  if (!chrome) return Promise.resolve({ why: 'no Chrome (set CHROME_BIN)' });
  const run = async () => {
    const quick = slow ? {} : await dump(chrome, url, '--virtual-time-budget=25000', 60000);
    return quick.html ? quick : dump(chrome, url, slow ? '--timeout=75000' : '--timeout=40000', 140000);
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

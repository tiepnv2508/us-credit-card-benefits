// Reading an issuer page, the two ways that work. Many issuers
// (americanexpress.com, Citi, Capital One, Bank of America) draw offers and
// terms with JavaScript, so the raw HTML has none of it: "the number is not
// in the fetched HTML" is never evidence that it is not on the page. Fetch
// first because it is fast and polite; render in a real browser before
// concluding anything is missing.

import { execFile, spawn } from 'node:child_process';
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

// Third way, for a block the page fills in from its own API after load
// (Amex business cards: the offer box says "Offer loading" in a DOM dump
// however long the dump waits). Open the page over the DevTools protocol,
// let it run in real time, scroll like a reader, and take the DOM as soon
// as `ready(text)` says the block is there — or after `seconds`. `click`
// (a regex source) presses every button or in-page link whose label
// matches, once the page has settled: "Offer details" overlays, accordions.
export function liveHtml(url, { seconds = 45, ready = () => false, click = null } = {}) {
  const chrome = findChrome();
  if (!chrome) return Promise.resolve({ why: 'no Chrome (set CHROME_BIN)' });
  const run = async () => {
    const WS = globalThis.WebSocket ?? (await import('ws').then((m) => m.default, () => null));
    if (!WS) return { why: 'live render needs the ws package (npm install)' };
    const profile = mkdtempSync(join(tmpdir(), 'catalog-chrome-'));
    const port = 9300 + Math.floor(Math.random() * 600);
    const proc = spawn(
      chrome,
      ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, `--user-agent=${UA}`, `--remote-debugging-port=${port}`, 'about:blank'],
      { stdio: 'ignore' },
    );
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let ws;
    try {
      let target;
      for (let i = 0; i < 50 && !target; i++) {
        await sleep(300);
        target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => []).then((l) => l.find((t) => t.type === 'page'));
      }
      if (!target) return { why: 'live render: Chrome did not start' };
      ws = new WS(target.webSocketDebuggerUrl);
      await new Promise((ok, bad) => {
        ws.onopen = ok;
        ws.onerror = () => bad(new Error('socket'));
      });
      let id = 0;
      const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m.result);
          pending.delete(m.id);
        }
      };
      const send = (method, params = {}) =>
        Promise.race([
          new Promise((r) => {
            pending.set(++id, r);
            ws.send(JSON.stringify({ id, method, params }));
          }),
          sleep(15000),
        ]);
      const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value ?? '';
      await send('Page.enable');
      await send('Page.navigate', { url });
      let html = '';
      for (let i = 0; i < seconds; i++) {
        await sleep(1000);
        if (i % 5 === 4) await evaluate('window.scrollBy(0, 600)');
        if (i < 6 && i !== seconds - 1) continue;
        if (click && i === 6) {
          await evaluate(`(() => { const re = new RegExp(${JSON.stringify(click)}, 'i'); let n = 0;
            for (const el of document.querySelectorAll('button, [role=button], summary, a')) {
              const href = el.getAttribute('href');
              if (el.tagName === 'A' && href && !/^(#|javascript:)/.test(href)) continue;
              if (re.test(el.innerText || el.getAttribute('aria-label') || '')) { el.click(); n++; }
            } return n; })()`);
          await sleep(2000);
        }
        html = await evaluate('document.documentElement.outerHTML');
        if (html.length > 20000 && ready(flatten(html))) break;
      }
      return html.length > 20000 ? { html } : { why: 'live render returned an empty page' };
    } catch (e) {
      return { why: `live render failed: ${e.message}` };
    } finally {
      try {
        ws?.close();
      } catch {}
      proc.kill();
      await sleep(400);
      rmSync(profile, { recursive: true, force: true });
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

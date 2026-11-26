// Browser checks with Playwright and simulated market responses (the real APIs are not reachable from the build machine).
// Run: node tools/serve.js 8765 & NODE_PATH=$(npm root -g) node tests/browser.e2e.js
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path'); const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:8765/';
const OUT = process.env.OUT || path.join(__dirname, '..', 'screenshots'); fs.mkdirSync(OUT, { recursive: true });
const results = []; const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message.split('\n')[0]]); } };

async function mockMarkets(ctx) {
  const now = Date.now(); const base = { BTC: 50000, ETH: 3000, SOL: 150, AAPL: 200, MSFT: 400, SPY: 600 };
  await ctx.route(/api\.exchange\.coinbase\.com/, (r) => {
    const u = r.request().url(); const sym = u.match(/products\/([A-Z]+)-USD/)[1];
    if (u.includes('/candles')) { const out = []; let p = base[sym]; for (let i = 0; i < 60; i++) { out.push([Math.floor((now - (i + 1) * 3600000) / 1000) - 3600, 0, 0, 0, p, 1]); p /= 1.002; } return r.fulfill({ json: out, headers: { 'access-control-allow-origin': '*' } }); }
    return r.fulfill({ json: { price: String(base[sym]), time: new Date().toISOString() }, headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.route(/finnhub\.io/, (r) => { const sym = r.request().url().match(/symbol=([A-Z]+)/)[1]; r.fulfill({ json: { c: base[sym], pc: base[sym], t: Math.floor(Date.now() / 1000) }, headers: { 'access-control-allow-origin': '*' } }); });
  await ctx.route(/coingecko|localhost:11434/, (r) => r.abort());
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}
async function noOverflow(page, label) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(w.sw <= w.cw + 1, `${label}: page is ${w.sw}px wide in a ${w.cw}px screen`);
}
async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=file]), .btn')].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || e.id || e.tagName).trim().slice(0, 30), h: r.height, w: r.width }; }).filter((x) => x.h < 43.5 || x.w < 40));
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  // Samsung Galaxy S25: 1080×2340 screen at about 2.8 device pixel ratio → about 384×832 CSS pixels
  const phone = await browser.newContext({ viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.8, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S931U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36', acceptDownloads: true });
  await mockMarkets(phone);
  const page = await phone.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '#dashboard'); await page.waitForSelector('.kpi');
  await page.waitForFunction(() => window.__pt && Object.keys(window.__pt.state.latest).length >= 6, null, { timeout: 10000 });

  await check('phone: every screen fits 384px with no sideways scrolling, and controls are at least 44px tall', async () => {
    for (const t of ['dashboard', 'markets', 'cards', 'journal', 'results']) {
      await page.tap(`#tabs button[data-tab="${t}"]`); await page.waitForTimeout(250); await noOverflow(page, t);
      const small = await smallTargets(page); assert.deepEqual(small, [], `${t}: small targets ${JSON.stringify(small.slice(0, 4))}`);
      await page.screenshot({ path: path.join(OUT, `phone-${t}.png`), fullPage: t !== 'results' });
    }
  });
  await check('phone: bottom tab bar is visible and stays on screen', async () => {
    const r = await page.locator('#tabs').boundingBox(); assert.ok(r.y + r.height <= 832 + 1 && r.y > 700, JSON.stringify(r));
  });
  await check('run once from the phone records journal entries and a run ID', async () => {
    await page.tap('#tabs button[data-tab="dashboard"]'); await page.tap('#rb-run');
    await page.waitForFunction(() => window.__pt.state.runs.length === 1 && !window.__pt.engine.isRunning(), null, { timeout: 15000 });
    const s = await page.evaluate(() => ({ fills: window.__pt.state.fills.length, j: window.__pt.state.journal.length, run: window.__pt.state.runs[0].id, cash: window.__pt.state.account.cash }));
    assert.ok(s.j > 0 && s.run.startsWith('run_')); assert.ok(s.fills >= 1, 'expected a simulated buy'); assert.ok(s.cash < 10000);
    await page.screenshot({ path: path.join(OUT, 'phone-dashboard-after-run.png'), fullPage: true });
  });
  await check('tapping a wire shows the information that passed through it', async () => {
    await page.tap('#tabs button[data-tab="cards"]'); await page.waitForSelector('path.hit', { state: 'attached' });
    await page.evaluate(() => document.querySelector('path.hit[data-edge="w_c5_c6"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('text=Wire: 5. Practice Decision → 6. Rules Check'); const txt = await page.locator('pre').first().innerText(); assert.match(txt, /proposals/);
    await page.screenshot({ path: path.join(OUT, 'phone-cards-wire.png') });
  });
  await check('edit a card prompt on the phone: saved as a new strategy version', async () => {
    await page.tap('.node[data-id="c3"]'); await page.waitForSelector('#e-prompt');
    await page.fill('#e-prompt', 'Only buy when the trend is clear. Use supplied facts only.'); await page.fill('#s-minTrendPct', '0.7');
    await page.tap('#e-save'); await page.waitForFunction(() => window.__pt.state.strategyVersions.length === 2);
    await page.screenshot({ path: path.join(OUT, 'phone-card-editor.png'), fullPage: false });
  });
  await check('connection form refuses a loop', async () => {
    await page.selectOption('#c-from', 'c6'); await page.selectOption('#c-to', 'c3'); await page.tap('#conn-form button[type=submit]');
    await page.waitForSelector('#modal:not([hidden])'); assert.match(await page.locator('#modal-body').innerText(), /Loop/); await page.tap('#modal-actions button');
  });
  await check('saving after reload: cash, journal, prompt and versions survive', async () => {
    const before = await page.evaluate(() => JSON.stringify({ c: window.__pt.state.account.cash, j: window.__pt.state.journal.length, v: window.__pt.state.strategyVersions.length, p: window.__pt.state.workflow.cards[2].prompt }));
    await page.reload(); await page.waitForSelector('.layer');
    const after = await page.evaluate(() => JSON.stringify({ c: window.__pt.state.account.cash, j: window.__pt.state.journal.length, v: window.__pt.state.strategyVersions.length, p: window.__pt.state.workflow.cards[2].prompt }));
    assert.equal(after, before);
  });
  let backupPath;
  await check('backup export, account reset with confirmation, and restore', async () => {
    await page.tap('#tabs button[data-tab="results"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#bk-export')]); backupPath = path.join(OUT, 'backup.json'); await dl.saveAs(backupPath);
    const cash = await page.evaluate(() => window.__pt.state.account.cash);
    await page.fill('#st-cash', '5000'); await page.tap('#st-reset'); await page.waitForSelector('#modal:not([hidden])');
    await page.tap('#modal-actions button:has-text("Cancel")'); assert.equal(await page.evaluate(() => window.__pt.state.account.cash), cash, 'cancel keeps data');
    await page.tap('#st-reset'); await page.tap('#modal-actions button:has-text("Reset account")');
    await page.waitForFunction(() => window.__pt.state.account.cash === 5000 && window.__pt.state.fills.length === 0);
    // a tampered backup is refused
    const bad = JSON.parse(fs.readFileSync(backupPath, 'utf8')); bad.data.account.cash += 999; const badPath = path.join(OUT, 'tampered.json'); fs.writeFileSync(badPath, JSON.stringify(bad));
    await page.setInputFiles('#bk-file', badPath); await page.waitForSelector('#bk-msg .err'); assert.equal(await page.evaluate(() => window.__pt.state.account.cash), 5000);
    await page.setInputFiles('#bk-file', backupPath); await page.waitForSelector('#modal:not([hidden])'); await page.tap('#modal-actions button:has-text("Replace data")');
    await page.waitForFunction((c) => Math.abs(window.__pt.state.account.cash - c) < 1e-9, cash);
    await page.reload(); await page.waitForSelector('.panel');
    assert.ok(Math.abs((await page.evaluate(() => window.__pt.state.account.cash)) - cash) < 1e-9, 'restore survives reload');
  });
  await check('CSV trade export downloads', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#bk-csv')]); const p = path.join(OUT, 'trades.csv'); await dl.saveAs(p);
    assert.match(fs.readFileSync(p, 'utf8'), /^filled_at_utc,side,symbol/);
  });
  await check('feed failure shows Unavailable and the run makes no trade', async () => {
    await phone.unroute(/api\.exchange\.coinbase\.com/); await phone.unroute(/finnhub\.io/);
    await phone.route(/api\.exchange\.coinbase\.com|finnhub\.io/, (r) => r.abort());
    const n = await page.evaluate(() => window.__pt.state.fills.length);
    await page.tap('#tabs button[data-tab="markets"]'); await page.tap('#mk-refresh'); await page.waitForSelector('.chip.st-unavailable');
    await page.screenshot({ path: path.join(OUT, 'phone-markets-unavailable.png'), fullPage: true });
    await page.evaluate(() => window.__pt.engine.run({ reason: 'manual' })); assert.equal(await page.evaluate(() => window.__pt.state.fills.length), n);
  });
  await check('AI Mode is labeled unavailable when no local model answers', async () => {
    await page.tap('#tabs button[data-tab="results"]'); assert.match(await page.locator('text=AI Mode').first().locator('..').innerText(), /Unavailable/i);
  });
  await check('no script errors', async () => assert.deepEqual(errors, []));

  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await mockMarkets(desk);
  const dp = await desk.newPage(); await dp.goto(BASE + '#cards'); await dp.waitForSelector('.layer');
  await dp.waitForFunction(() => window.__pt && Object.keys(window.__pt.state.latest).length >= 6);
  await dp.evaluate(() => window.__pt.engine.run({ reason: 'manual' })); await dp.waitForTimeout(400);
  await check('desktop: cards screen fits and shows all 8 starter cards with 8 wires', async () => { await noOverflow(dp, 'desktop cards'); assert.equal(await dp.locator('.node').count(), 8); assert.equal(await dp.locator('path.wire').count(), 8); });
  await dp.screenshot({ path: path.join(OUT, 'desktop-cards.png'), fullPage: true });
  await dp.goto(BASE + '#dashboard'); await dp.waitForSelector('.kpi'); await dp.screenshot({ path: path.join(OUT, 'desktop-dashboard.png'), fullPage: true });
  await browser.close();
  for (const [s, n] of results) console.log(s, n);
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})();

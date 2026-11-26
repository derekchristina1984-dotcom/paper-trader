// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const D = require('../src/data.js');
const AI = require('../src/ai.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const OPEN = Date.parse('2026-11-24T16:00:00Z'); // Tuesday 11:00 New York, market open
const fill = (o) => Object.assign({ id: C.uid('f'), idempotencyKey: C.uid('k'), fee: 0, slippageCost: 0, filledAt: OPEN }, o);

test('cash and cost basis: buys include fees in cost, cash falls by cost', () => {
  const s = C.createInitialState(OPEN);
  C.applyFill(s, fill({ assetId: 'crypto:BTC', side: 'buy', qty: 0.01, price: 50000, fee: 0.5 }));
  close(s.account.cash, 10000 - 500.5);
  close(s.account.positions['crypto:BTC'].costBasis, 500.5);
  C.applyFill(s, fill({ assetId: 'crypto:BTC', side: 'buy', qty: 0.01, price: 60000, fee: 0.6 }));
  const p = s.account.positions['crypto:BTC'];
  close(p.qty, 0.02); close(p.costBasis, 1101.1); close(p.costBasis / p.qty, 55055);
  close(s.account.cash, 10000 - 1101.1); close(s.account.feesPaid, 1.1);
});

test('partial sale: average cost removed proportionally, realized includes sale fee', () => {
  const s = C.createInitialState(OPEN);
  C.applyFill(s, fill({ assetId: 'stock:AAPL', side: 'buy', qty: 10, price: 100, fee: 1 })); // cost 1001
  const f = C.applyFill(s, fill({ assetId: 'stock:AAPL', side: 'sell', qty: 4, price: 110, fee: 0.44 }));
  close(f.costRemoved, 400.4); close(f.realized, 440 - 0.44 - 400.4);
  const p = s.account.positions['stock:AAPL']; close(p.qty, 6); close(p.costBasis, 600.6);
  close(s.account.cash, 10000 - 1001 + 439.56); close(s.account.realizedPnl, 39.16);
  C.applyFill(s, fill({ assetId: 'stock:AAPL', side: 'sell', qty: 6, price: 90, fee: 0 }));
  assert.equal(s.account.positions['stock:AAPL'], undefined);
  close(s.account.realizedPnl, 39.16 + (540 - 600.6));
  // replaying fills reproduces the account exactly
  const re = C.replayLedger(10000, s.fills); close(re.cash, s.account.cash); close(re.realizedPnl, s.account.realizedPnl);
});

test('insufficient cash and holdings are refused and leave the account unchanged', () => {
  const s = C.createInitialState(OPEN);
  assert.throws(() => C.applyFill(s, fill({ assetId: 'crypto:BTC', side: 'buy', qty: 1, price: 10000, fee: 1 })), /Insufficient virtual cash/);
  assert.throws(() => C.applyFill(s, fill({ assetId: 'crypto:BTC', side: 'sell', qty: 0.1, price: 100 })), /Insufficient holdings/);
  C.applyFill(s, fill({ assetId: 'crypto:ETH', side: 'buy', qty: 1, price: 100 }));
  assert.throws(() => C.applyFill(s, fill({ assetId: 'crypto:ETH', side: 'sell', qty: 1.5, price: 100 })), /Short selling is not allowed/);
  close(s.account.cash, 9900); assert.equal(s.fills.length, 1);
});

test('duplicate fills are blocked by idempotency key', () => {
  const s = C.createInitialState(OPEN);
  C.applyFill(s, fill({ assetId: 'crypto:ETH', side: 'buy', qty: 1, price: 100, idempotencyKey: 'run1:ETH:buy' }));
  assert.throws(() => C.applyFill(s, fill({ assetId: 'crypto:ETH', side: 'buy', qty: 1, price: 100, idempotencyKey: 'run1:ETH:buy' })), /Duplicate fill/);
  close(s.account.cash, 9900);
});

test('market hours: weekend, holiday, early close, open session', () => {
  assert.equal(C.stockMarketStatus(OPEN).open, true);
  assert.equal(C.stockMarketStatus(Date.parse('2026-11-26T16:00:00Z')).open, false); // Thanksgiving
  assert.match(C.stockMarketStatus(Date.parse('2026-11-26T16:00:00Z')).label, /holiday/);
  assert.equal(C.stockMarketStatus(Date.parse('2026-11-28T16:00:00Z')).open, false); // Saturday
  assert.equal(C.stockMarketStatus(Date.parse('2026-11-27T17:30:00Z')).open, true); // 12:30 ET early close day
  assert.equal(C.stockMarketStatus(Date.parse('2026-11-27T18:30:00Z')).open, false); // 13:30 ET
  assert.equal(C.stockMarketStatus(Date.parse('2026-11-24T14:00:00Z')).open, false); // 9:00 ET
});

test('observation status comes from the source timestamp', () => {
  const btc = C.makeAsset('crypto', 'BTC'), aapl = C.makeAsset('stock', 'AAPL'); const s = C.defaultSettings();
  const o = (ageMin) => ({ price: 1, marketTime: OPEN - ageMin * 60000, fetchedAt: OPEN });
  assert.equal(C.classifyObservation(o(1), btc, OPEN, s).status, 'current');
  assert.equal(C.classifyObservation(o(5), btc, OPEN, s).status, 'delayed');
  assert.equal(C.classifyObservation(o(30), btc, OPEN, s).status, 'stale');
  assert.equal(C.classifyObservation(o(30), btc, OPEN, s).tradeable, false);
  assert.equal(C.classifyObservation(o(15), aapl, OPEN, s).status, 'delayed');
  assert.equal(C.classifyObservation(null, btc, OPEN, s).status, 'unavailable');
  assert.equal(C.classifyObservation(o(1), aapl, Date.parse('2026-11-26T16:00:00Z'), s).status, 'closed');
});

test('workflow validation: loops, trigger inputs and rules bypass are refused', () => {
  const wf = C.createDefaultWorkflow();
  assert.equal(C.validateWorkflow(wf).ok, true);
  const loop = C.clone(wf); loop.connections.push({ id: 'x', from: 'c5', to: 'c3' });
  assert.match(C.validateWorkflow(loop).errors.join(' '), /Loop found/);
  const bypass = C.clone(wf); bypass.connections.push({ id: 'y', from: 'c5', to: 'c7' });
  assert.match(C.validateWorkflow(bypass).errors.join(' '), /can only receive from a Rules Check/);
  const intoTrig = C.clone(wf); intoTrig.connections.push({ id: 'z', from: 'c8', to: 'c1' });
  assert.equal(C.validateWorkflow(intoTrig).ok, false);
  const missing = C.clone(wf); missing.connections = missing.connections.filter((e) => e.id !== 'w_c5_c6');
  assert.match(C.validateWorkflow(missing).errors.join(' ') + C.validateWorkflow(missing).warnings.join(' '), /Rules Check|will not run/);
  const bad = C.clone(wf); bad.cards[2].settings.shortWindow = 50;
  assert.match(C.validateWorkflow(bad).errors.join(' '), /short average/);
});

test('invalid AI outputs are rejected before they reach the ledger', () => {
  const ids = ['crypto:BTC', 'stock:AAPL'];
  assert.equal(C.validateAnalysisOutput(null, ids).ok, false);
  assert.equal(C.validateAnalysisOutput({ proposals: 'buy everything' }, ids).ok, false);
  assert.match(C.validateAnalysisOutput({ proposals: [{ assetId: 'crypto:DOGE', action: 'buy', confidence: 0.9, reason: 'x' }] }, ids).errors.join(), /not supplied/);
  assert.match(C.validateAnalysisOutput({ proposals: [{ assetId: 'crypto:BTC', action: 'short', confidence: 0.9, reason: 'x' }] }, ids).errors.join(), /action/);
  assert.match(C.validateAnalysisOutput({ proposals: [{ assetId: 'crypto:BTC', action: 'buy', confidence: 3, reason: 'x' }] }, ids).errors.join(), /confidence/);
  assert.match(C.validateAnalysisOutput({ proposals: [{ assetId: 'crypto:BTC', action: 'buy', confidence: 0.5, reason: 'x', price: 1 }] }, ids).errors.join(), /tried to set "price"/);
  assert.equal(C.validateAnalysisOutput({ proposals: [{ assetId: 'crypto:BTC', action: 'buy', confidence: 0.5, reason: 'trend up' }] }, ids).ok, true);
  assert.equal(C.validateChallengeOutput({ verdicts: [{ assetId: 'crypto:BTC', agree: 'yes', severity: 'none' }] }, [{ assetId: 'crypto:BTC' }]).ok, false);
});

// ---------- engine with simulated network responses ----------
function harness({ prices, now = OPEN, finnhubKey = 'testkey123', aiFetch } = {}) {
  let S = C.createInitialState(now); S.settings.finnhubKey = finnhubKey;
  let clock = now; const calls = [];
  const state = { prices: Object.assign({ BTC: 50000, ETH: 3000, SOL: 150, AAPL: 200, MSFT: 400, SPY: 600 }, prices), trend: 1.002, ageMin: 0, fail: new Set(), delayMs: 0 };
  const fetchMock = async (url) => {
    calls.push(url); if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const sym = (url.match(/products\/([A-Z]+)-USD/) || url.match(/symbol=([A-Z]+)/) || [])[1];
    if (state.fail.has(sym) || state.fail.has('*')) throw new TypeError('Failed to fetch');
    const json = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('/candles')) { const out = []; let p = state.prices[sym]; for (let i = 0; i < 60; i++) { out.push([Math.floor((clock - (i + 1) * 3600000) / 1000) - 3600, 0, 0, 0, p, 1]); p = p / state.trend; } return json(out); }
    if (url.includes('/ticker')) return json({ price: String(state.prices[sym]), time: new Date(clock - state.ageMin * 60000).toISOString() });
    if (url.includes('finnhub')) return json({ c: state.prices[sym], pc: state.prices[sym], t: Math.floor((clock - state.ageMin * 60000) / 1000) });
    if (url.includes('coingecko')) return json({});
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const commit = async (mut) => { const n = C.clone(S); const r = mut(n); S = n; return r; };
  const getState = () => S; const nowFn = () => clock;
  const data = D.createDataLayer({ fetch: fetchMock, now: nowFn, getState, commit });
  const ai = aiFetch ? AI.createAI({ fetch: aiFetch, getSettings: () => S.settings }) : { available: false };
  const engine = C.createEngine({ getState, commit, data, ai, now: nowFn });
  return { get S() { return S; }, set S(v) { S = v; }, engine, state, calls, ai, tick: (ms) => { clock += ms; }, setClock: (t) => { clock = t; } };
}

test('full run: rising crypto with enough history produces a simulated buy; everything else holds or is explained', async () => {
  const h = harness();
  const r = await h.engine.run({ reason: 'manual' });
  assert.equal(r.status, 'done', JSON.stringify(r.errors));
  assert.deepEqual(r.steps.map((s) => s.status), Array(8).fill('done'));
  const S = h.S; assert.ok(S.fills.length >= 1, 'expected at least one fill');
  for (const f of S.fills) { assert.equal(f.side, 'buy'); assert.equal(f.simulated, true); assert.ok(f.price > f.quotePrice, 'buy slippage is against you'); assert.ok(f.quoteFetchedAt >= r.steps[5].startedAt, 'fill price fetched after approval'); }
  assert.ok(S.account.cash < 10000 && S.account.cash > 0);
  const re = C.replayLedger(10000, S.fills); close(re.cash, S.account.cash);
  assert.ok(S.journal.some((j) => j.kind === 'hold'));
  assert.ok(S.runs[0].strategyVersionId === 'v1' && S.runs[0].cardVersions.length === 8);
  assert.ok(Object.keys(S.runs[0].edges).length === 8, 'every wire carried information');
  // stocks: history too short (only a fresh quote), so they hold with a stated reason
  assert.ok(S.journal.some((j) => j.kind === 'hold' && /AAPL/.test(j.text) && /observations/.test(j.text)));
});

test('stale data: prices older than the limit block new trades; nothing is fabricated', async () => {
  const h = harness(); h.state.ageMin = 45;
  const r = await h.engine.run({ reason: 'manual' });
  assert.equal(h.S.fills.length, 0);
  assert.ok(h.S.journal.filter((j) => j.kind === 'hold').every((j) => /stale|observations/.test(j.text)));
  assert.equal(r.status, 'done');
});

test('feed failure: unavailable assets are shown as such and never traded', async () => {
  const h = harness(); h.state.fail.add('*');
  const r = await h.engine.run({ reason: 'manual' });
  assert.equal(h.S.fills.length, 0);
  const mw = r.steps.find((s) => s.type === 'marketWatch').output;
  assert.equal(mw.missing.length, 6);
  assert.ok(mw.assets.every((a) => a.price === null));
});

test('no Finnhub key: stocks unavailable with a clear reason', async () => {
  const h = harness({ finnhubKey: '' });
  const r = await h.engine.run({ reason: 'manual' });
  const mw = r.steps.find((s) => s.type === 'marketWatch').output;
  assert.ok(mw.missing.filter((m) => ['AAPL', 'MSFT', 'SPY'].includes(m.symbol)).every((m) => /Finnhub key/.test(m.note)));
});

test('concurrent runs: a second run while one is in progress is refused; no double trades', async () => {
  const h = harness(); h.state.delayMs = 20;
  const [a, b] = await Promise.all([h.engine.run({ reason: 'manual' }), h.engine.run({ reason: 'schedule' })]);
  assert.equal(a.status, 'done'); assert.equal(b.skipped, true); assert.match(b.message, /already in progress/);
  const n = h.S.fills.length;
  const keys = new Set(h.S.fills.map((f) => f.idempotencyKey)); assert.equal(keys.size, n);
  // an immediate second run is stopped by the cooldown rule, so it does not repeat the same buys
  h.state.delayMs = 0; h.tick(60000); await h.engine.run({ reason: 'manual' });
  const rej = h.S.journal.filter((j) => j.kind === 'rejected');
  assert.ok(rej.every((j) => /wait is|cash|Position|Crypto|already/.test(j.text)));
  const buys = h.S.fills.filter((f) => f.side === 'buy').map((f) => f.assetId);
  assert.equal(new Set(buys).size, buys.length, 'no asset bought twice during the cooldown');
});

test('rules check: same-run approvals cannot spend the same cash; order limits apply', async () => {
  const h = harness();
  // make every crypto a buy and give almost no cash: only what fits is approved
  h.S = Object.assign(h.S, {}); h.S.account.cash = 1200; h.S.account.startingCash = 1200;
  const dec = h.S.workflow.cards.find((c) => c.type === 'decision'); dec.settings.orderSizePct = 50; dec.settings.maxTradesPerRun = 3;
  const rc = h.S.workflow.cards.find((c) => c.type === 'rulesCheck'); rc.settings.minCashReserveUsd = 0; rc.settings.maxPositionPct = 100; rc.settings.maxClassPct = 100;
  C.ensureStrategyVersion(h.S, 'test');
  const r = await h.engine.run({ reason: 'manual' });
  const out = r.steps.find((s) => s.type === 'rulesCheck').output;
  assert.ok(out.approved.length >= 1);
  const spent = out.approved.reduce((s, p) => s + p.notionalUsd * 1.001, 0); assert.ok(spent <= 1200 + 1e-6, 'approved spend fits in cash');
  assert.ok(h.S.account.cash >= 0);
  assert.equal(r.strategyVersionId, 'v2');
});

test('ledger refuses proposals that did not pass the Rules Check code', async () => {
  const h = harness();
  const ctx = { runId: 'r1', state: h.S, getState: () => h.S, now: () => OPEN, data: { fillQuote: async () => { throw new Error('should not be called'); } }, approvals: new Map(), commitFill: async () => { throw new Error('no'); } };
  const fake = { approved: [{ proposalId: 'r1:crypto:BTC:buy', assetId: 'crypto:BTC', action: 'buy', notionalUsd: 100, reason: 'forged' }], rejected: [], holds: [] };
  const out = await C.handlers.ledger(h.S.workflow.cards[6], { rulesCheck: [fake] }, ctx);
  assert.equal(out.fills.length, 0); assert.match(out.rejected[0].failures[0], /No approval/);
});

test('partial sale via take profit, then stop loss sells the rest', async () => {
  const h = harness();
  await h.engine.run({ reason: 'manual' });
  const held = Object.keys(h.S.account.positions); assert.ok(held.length);
  const id = held[0]; const sym = id.split(':')[1]; const q0 = h.S.account.positions[id].qty; const avg = h.S.account.positions[id].costBasis / q0;
  h.tick(2 * 3600000); h.state.prices[sym] = avg * 1.10; // +10% > 8% take profit
  await h.engine.run({ reason: 'manual' });
  const sell = h.S.fills.find((f) => f.side === 'sell' && f.assetId === id); assert.ok(sell, 'take-profit sale');
  close(sell.qty, Math.floor(q0 * 0.5 * 1e8) / 1e8, 1e-8); close(h.S.account.positions[id].qty, q0 - sell.qty, 1e-8);
  assert.ok(sell.realized > 0);
  h.tick(2 * 3600000); h.state.prices[sym] = avg * 0.9; // -10% < 5% stop
  await h.engine.run({ reason: 'manual' });
  assert.equal(h.S.account.positions[id], undefined, 'stop loss closed the position');
  const m = C.computeMetrics(h.S); assert.equal(m.completedTrades, 2); close(m.winRatePct, 50);
  const re = C.replayLedger(10000, h.S.fills); close(re.cash, h.S.account.cash);
});

test('challenge can disagree and the decision then holds', async () => {
  const h = harness();
  const ch = h.S.workflow.cards.find((c) => c.type === 'challenge'); ch.settings.maxVolatilityPct = 0.01; C.ensureStrategyVersion(h.S, 'strict');
  const r = await h.engine.run({ reason: 'manual' });
  const v = r.steps.find((s) => s.type === 'challenge').output.verdicts;
  assert.ok(v.some((x) => !x.agree && x.severity === 'block'));
  assert.equal(h.S.fills.length, 0);
  assert.ok(h.S.journal.some((j) => /challenge disagreed/.test(j.text)));
});

test('test card does not record trades or journal entries', async () => {
  const h = harness();
  const r = await h.engine.run({ reason: 'test', test: true, untilCardId: 'c7' });
  assert.equal(r.test, true); assert.equal(h.S.fills.length, 0); assert.equal(h.S.journal.length, 0); assert.equal(h.S.runs.length, 0);
  const led = r.steps.find((s) => s.type === 'ledger'); assert.ok(led.output.fills.every((f) => f.test));
  const r2 = await h.engine.run({ reason: 'test', test: true, untilCardId: 'c3' });
  assert.deepEqual(r2.steps.map((s) => s.cardId), ['c1', 'c2', 'c3']);
});

test('invalid workflow blocks the run and records a failed run', async () => {
  const h = harness(); h.S.workflow.connections.push({ id: 'loop', from: 'c6', to: 'c5' });
  const r = await h.engine.run({ reason: 'manual' });
  assert.equal(r.status, 'failed'); assert.equal(h.S.fills.length, 0);
  assert.ok(h.S.journal.some((j) => j.kind === 'failed' && /Loop/.test(j.text)));
});

test('AI Mode: unavailable model fails safely; invalid model output never reaches the ledger; valid output is used', async () => {
  let reply = '{"proposals":[{"assetId":"crypto:BTC","action":"buy","confidence":0.8,"reason":"r","quantity":5}]}';
  const aiFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('/api/tags') ? { models: [{ name: 'llama3.2:3b' }] } : { message: { content: reply } }) });
  const h = harness({ aiFetch });
  h.S.workflow.cards.find((c) => c.type === 'analyze').mode = 'ai'; C.ensureStrategyVersion(h.S, 'ai');
  let r = await h.engine.run({ reason: 'manual' }); // not tested yet → unavailable
  assert.equal(r.status, 'failed'); assert.match(r.errors.join(), /unavailable/); assert.equal(h.S.fills.length, 0);
  await h.ai.test(); assert.equal(h.ai.available, true);
  h.tick(60000); r = await h.engine.run({ reason: 'manual' });
  assert.match(r.errors.join(), /AI output rejected.*quantity/); assert.equal(h.S.fills.length, 0);
  reply = 'not json at all'; h.tick(60000); r = await h.engine.run({ reason: 'manual' });
  assert.match(r.errors.join(), /valid JSON/); assert.equal(h.S.fills.length, 0);
  reply = '{"proposals":[{"assetId":"crypto:BTC","action":"buy","confidence":0.8,"reason":"Trend up in supplied prices","uncertainty":"medium","invalidation":"drop"}]}';
  h.tick(60000); r = await h.engine.run({ reason: 'manual' });
  assert.equal(r.status, 'done', r.errors.join());
  assert.equal(r.steps.find((s) => s.type === 'analyze').output.engine, 'AI Mode (llama3.2:3b, local)');
  assert.ok(h.S.fills.some((f) => f.assetId === 'crypto:BTC'));
});

test('outcome review compares later prices and suggestions need acceptance', async () => {
  const h = harness();
  const rev = h.S.workflow.cards.find((c) => c.type === 'outcomeReview'); rev.settings.horizonMinutes = 60; rev.settings.minReviewsForSuggestion = 2; C.ensureStrategyVersion(h.S, 'short review');
  await h.engine.run({ reason: 'manual' });
  const buys = h.S.decisions.filter((d) => d.action === 'buy').length; assert.ok(buys >= 1);
  for (const k of Object.keys(h.state.prices)) h.state.prices[k] *= 0.97; // prices fall after buying
  h.tick(2 * 3600000); await h.engine.run({ reason: 'manual' });
  assert.ok(h.S.reviews.length >= buys);
  assert.ok(h.S.reviews.some((r) => r.action === 'buy' && r.verdict === 'failed'));
  const before = h.S.workflow.cards.find((c) => c.type === 'analyze').settings.minTrendPct;
  const sug = h.S.suggestions.find((s) => s.status === 'pending');
  if (sug) {
    assert.equal(h.S.workflow.cards.find((c) => c.type === 'analyze').settings.minTrendPct, before, 'not applied without acceptance');
    const v = C.acceptSuggestion(h.S, sug.id); assert.equal(h.S.workflow.cards.find((c) => c.id === sug.cardId).settings[sug.setting], sug.to); assert.ok(v.number > 2);
  }
  for (const r of h.S.reviews) assert.ok(r.laterTime >= r.decisionAt, 'review uses only later observations');
});

test('backup: export, validate, restore round trip; tampered and foreign files refused', async () => {
  const h = harness(); await h.engine.run({ reason: 'manual' });
  const b = C.exportBackup(h.S);
  assert.equal(b.data.settings.finnhubKey, '', 'key excluded by default');
  const json = JSON.parse(JSON.stringify(b));
  const v = C.validateBackup(json); assert.equal(v.ok, true, v.errors.join());
  const restored = C.restoreFromBackup(json, { finnhubKey: 'keep-me-123' });
  close(restored.account.cash, h.S.account.cash); assert.equal(restored.fills.length, h.S.fills.length); assert.equal(restored.settings.finnhubKey, 'keep-me-123'); assert.equal(restored.schedule.enabled, false);
  const t1 = JSON.parse(JSON.stringify(b)); t1.data.account.cash += 5000;
  assert.match(C.validateBackup(t1).errors.join(), /does not match the recorded fills/);
  const t2 = JSON.parse(JSON.stringify(b)); t2.data.workflow.connections.push({ id: 'l', from: 'c8', to: 'c2' });
  assert.equal(C.validateBackup(t2).ok, false);
  assert.equal(C.validateBackup({ hello: 1 }).ok, false);
  const t3 = JSON.parse(JSON.stringify(b)); delete t3.data.fills; assert.match(C.validateBackup(t3).errors.join(), /fills/);
});

test('CSV export escapes text and guards against spreadsheet formulas', () => {
  const s = C.createInitialState(OPEN);
  C.applyFill(s, fill({ assetId: 'crypto:BTC', side: 'buy', qty: 0.001, price: 50000, quotePrice: 49990, quoteMarketTime: OPEN, quoteSource: 'Coinbase', runId: 'r', strategyVersionId: 'v1', reason: '=HYPERLINK("x"), "quoted"' }));
  const csv = C.fillsToCsv(s.fills); const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2); assert.match(lines[0], /^filled_at_utc,side,symbol/);
  assert.match(lines[1], /"'=HYPERLINK\(""x""\), ""quoted"""$/); assert.match(lines[1], /,yes,/);
});

test('reset account requires a valid amount and clears the ledger', () => {
  const s = C.createInitialState(OPEN); C.applyFill(s, fill({ assetId: 'crypto:ETH', side: 'buy', qty: 1, price: 100 }));
  assert.throws(() => C.resetAccount(s, -5)); C.resetAccount(s, 25000, OPEN);
  assert.equal(s.account.cash, 25000); assert.equal(s.fills.length, 0); assert.deepEqual(s.account.positions, {});
});

test('rate-limit guard and HTTP 429 back-off stop requests instead of inventing prices', async () => {
  let n = 0; const S = C.createInitialState(OPEN); S.watchlist = [C.makeAsset('crypto', 'BTC')];
  const fetch429 = async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; };
  const d = D.createDataLayer({ fetch: fetch429, now: () => OPEN, getState: () => S, commit: async (m) => m(S) });
  const res = await d.refresh(S.watchlist);
  assert.equal(res['crypto:BTC'].price, null); assert.match(res['crypto:BTC'].error, /429|slow down/);
  const before = n; await d.refresh(S.watchlist); assert.equal(n - before <= 1, true, 'backed off');
});

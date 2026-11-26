/* Paper Trader core: pure logic shared by the browser app and the Node tests.
 * Nothing in this file talks to the network or the DOM. Everything is simulated money. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.PTCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  const APP_ID = 'paper-trader';
  const BACKUP_FORMAT = 1;
  const STATE_SCHEMA = 1;

  // ---------- small utilities ----------
  let idCounter = 0;
  function uid(prefix) {
    idCounter = (idCounter + 1) % 1e6;
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
  }
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const round = (x, d = 2) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function hash(v) { // FNV-1a 32 bit, hex
    const s = typeof v === 'string' ? v : stableStringify(v);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // ---------- assets ----------
  const COINGECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin', ADA: 'cardano', XRP: 'ripple', LTC: 'litecoin', AVAX: 'avalanche-2', LINK: 'chainlink', DOT: 'polkadot', BCH: 'bitcoin-cash', XLM: 'stellar', UNI: 'uniswap', SHIB: 'shiba-inu', MATIC: 'matic-network', ATOM: 'cosmos' };
  function makeAsset(kind, symbol, name) {
    symbol = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new Error('Symbol must be 1 to 12 letters, digits, dots or dashes.');
    if (kind !== 'crypto' && kind !== 'stock') throw new Error('Asset type must be crypto or stock.');
    const a = { id: `${kind}:${symbol}`, kind, symbol, name: name || symbol };
    if (kind === 'crypto') { a.coinbaseProduct = `${symbol}-USD`; a.coingeckoId = COINGECKO_IDS[symbol] || null; }
    return a;
  }
  function defaultWatchlist() {
    return [makeAsset('crypto', 'BTC', 'Bitcoin'), makeAsset('crypto', 'ETH', 'Ethereum'), makeAsset('crypto', 'SOL', 'Solana'),
      makeAsset('stock', 'AAPL', 'Apple'), makeAsset('stock', 'MSFT', 'Microsoft'), makeAsset('stock', 'SPY', 'S&P 500 ETF')];
  }

  // ---------- US stock market hours (NYSE / Nasdaq regular session) ----------
  const NYSE_HOLIDAYS = new Set(['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
  const NYSE_EARLY_CLOSE = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']);
  const HOLIDAY_TABLE_END = 2027;
  function nyParts(ms) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
    const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, year: +p.year, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday };
  }
  function stockMarketStatus(ms) {
    const p = nyParts(ms);
    const note = p.year > HOLIDAY_TABLE_END ? ' Holiday table ends in 2027, so holidays after that are not known.' : '';
    if (p.weekday === 'Sat' || p.weekday === 'Sun') return { open: false, label: 'Closed (weekend)', note };
    if (NYSE_HOLIDAYS.has(p.date)) return { open: false, label: 'Closed (exchange holiday)', note };
    const close = NYSE_EARLY_CLOSE.has(p.date) ? 13 * 60 : 16 * 60;
    if (p.minutes < 9 * 60 + 30) return { open: false, label: 'Closed (before 9:30 AM New York time)', note };
    if (p.minutes >= close) return { open: false, label: close === 780 ? 'Closed (early close at 1 PM)' : 'Closed (after 4 PM New York time)', note };
    return { open: true, label: close === 780 ? 'Open (early close 1 PM New York time)' : 'Open (9:30 AM to 4 PM New York time)', note };
  }
  function marketStatusFor(asset, ms) {
    if (asset.kind === 'crypto') return { open: true, label: 'Trades around the clock', note: '' };
    return stockMarketStatus(ms);
  }

  // ---------- observation status ----------
  // Status is computed from the market timestamp the source reported, never from what a source claims.
  function classifyObservation(obs, asset, now, s) {
    s = s || {};
    const currentMin = s.currentWithinMinutes ?? 2;
    const staleMin = asset.kind === 'crypto' ? (s.cryptoStaleMinutes ?? 10) : (s.stockStaleMinutes ?? 20);
    const market = marketStatusFor(asset, now);
    if (!obs || !isNum(obs.price) || obs.price <= 0 || !isNum(obs.marketTime)) {
      return { status: 'unavailable', tradeable: false, ageMinutes: null, market, note: obs && obs.error ? obs.error : 'No price received.' };
    }
    const ageMinutes = Math.max(0, (now - obs.marketTime) / 60000);
    if (!market.open) return { status: 'closed', tradeable: false, ageMinutes, market, note: `${market.label}. Showing the last price; new stock trades wait for the session.` };
    if (ageMinutes <= currentMin) return { status: 'current', tradeable: true, ageMinutes, market, note: '' };
    if (ageMinutes <= staleMin) return { status: 'delayed', tradeable: true, ageMinutes, market, note: `Price is ${Math.round(ageMinutes)} min old.` };
    return { status: 'stale', tradeable: false, ageMinutes, market, note: `Price is ${Math.round(ageMinutes)} min old, older than the ${staleMin} min limit.` };
  }

  // ---------- indicators ----------
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  function sma(prices, n) { if (prices.length < n || n < 1) return null; return mean(prices.slice(-n)); }
  function volatilityPct(prices, n) {
    const p = prices.slice(-(n + 1)); if (p.length < 3) return null;
    const r = []; for (let i = 1; i < p.length; i++) r.push((p[i] / p[i - 1] - 1) * 100);
    const m = mean(r); return Math.sqrt(mean(r.map((x) => (x - m) ** 2)));
  }

  // ---------- state ----------
  function defaultSettings() {
    return {
      startingCash: 10000,
      feePct: 0.1, feeFlatUsd: 0, slippagePct: 0.05,
      currentWithinMinutes: 2, cryptoStaleMinutes: 10, stockStaleMinutes: 20,
      finnhubKey: '', includeKeyInBackup: false,
      aiEndpoint: 'http://localhost:11434', aiModel: 'llama3.2:3b',
      historyPerAsset: 400,
    };
  }
  function freshAccount(startingCash, now) {
    return { startingCash, cash: startingCash, positions: {}, realizedPnl: 0, feesPaid: 0, slippageCost: 0, createdAt: now, simulated: true };
  }
  function createInitialState(now = Date.now()) {
    const settings = defaultSettings();
    const st = {
      app: APP_ID, schema: STATE_SCHEMA, createdAt: now,
      settings, account: freshAccount(settings.startingCash, now),
      watchlist: defaultWatchlist(), workflow: createDefaultWorkflow(),
      schedule: { enabled: false, lastRunAt: null },
      strategyVersions: [], observations: {}, latest: {}, fills: [], journal: [], runs: [],
      decisions: [], reviews: [], suggestions: [], equityHistory: [], dataLog: [],
    };
    ensureStrategyVersion(st, 'Starter template', now);
    return st;
  }

  // ---------- card types ----------
  const ANALYSIS_PROMPT = 'Review the supplied market observations and virtual portfolio. Use only the supplied facts. Consider the configured indicators and existing positions. Propose buy, sell, or hold with a reason, uncertainty, and the evidence that could invalidate the idea. If important information is missing, propose hold. Do not invent prices, news, or account balances. Return the required structured output.';
  const CARD_TYPES = {
    trigger: {
      label: 'Trigger', purpose: 'Starts a run when you press Run Once or when the enabled schedule is due.',
      inputs: [], outputs: ['run start (run ID, time, reason)'], requires: [], aiCapable: false,
      prompt: 'Start a run on Run Once or when the schedule is due. Respect free data limits.',
      settings: { scheduleMinutes: { label: 'Schedule every (minutes)', type: 'number', min: 1, max: 1440, step: 1, def: 15 } },
    },
    marketWatch: {
      label: 'Market Watch', purpose: 'Collects prices, timestamps, history and the virtual portfolio, and flags missing or stale data.',
      inputs: ['run start'], outputs: ['market snapshot', 'virtual portfolio', 'missing and stale list'], requires: ['trigger'], aiCapable: false,
      prompt: 'Collect the selected assets, available prices, timestamps, historical observations and the current virtual portfolio. Identify missing or stale information.',
      settings: {
        assets: { label: 'Assets (blank = whole watchlist, or symbols like BTC,AAPL)', type: 'text', def: '' },
        historyPoints: { label: 'History points passed on', type: 'number', min: 5, max: 300, step: 1, def: 60 },
      },
    },
    analyze: {
      label: 'Analyze', purpose: 'Proposes buy, sell or hold for each asset from the data actually supplied, with reasons and uncertainty.',
      inputs: ['market snapshot'], outputs: ['proposals with reasons', 'market snapshot (passed along)'], requires: ['marketWatch'], aiCapable: true,
      prompt: ANALYSIS_PROMPT,
      settings: {
        shortWindow: { label: 'Short average (observations)', type: 'number', min: 2, max: 100, step: 1, def: 5 },
        longWindow: { label: 'Long average (observations)', type: 'number', min: 3, max: 200, step: 1, def: 20 },
        minTrendPct: { label: 'Minimum trend to act (%)', type: 'number', min: 0, max: 50, step: 0.1, def: 0.5 },
      },
    },
    challenge: {
      label: 'Challenge', purpose: 'Looks for weak evidence, contradictions, too much exposure, missing inputs or reasons to wait. Can disagree.',
      inputs: ['proposals', 'market snapshot'], outputs: ['agree or object per proposal', 'proposals and snapshot (passed along)'], requires: ['analyze'], aiCapable: true,
      prompt: 'Check the analysis for weak evidence, contradictory information, excessive exposure, missing inputs, or reasons to wait. Disagree when the evidence is not strong enough. Use only the supplied facts.',
      settings: {
        minObservations: { label: 'Minimum observations required', type: 'number', min: 2, max: 300, step: 1, def: 20 },
        maxVolatilityPct: { label: 'Maximum volatility per step (%)', type: 'number', min: 0.01, max: 50, step: 0.01, def: 2 },
        maxExposurePct: { label: 'Maximum invested share of portfolio (%)', type: 'number', min: 1, max: 100, step: 1, def: 70 },
        blockOnLatestMoveAgainst: { label: 'Object when the latest move goes against the idea', type: 'bool', def: true },
      },
    },
    decision: {
      label: 'Practice Decision', purpose: 'Weighs analysis and challenge and proposes an action, asset, size, reason and exit conditions. Holding is valid.',
      inputs: ['proposals', 'challenge results', 'market snapshot'], outputs: ['trade proposals', 'hold decisions'], requires: ['analyze'], optional: ['challenge'], aiCapable: false,
      prompt: 'Consider both the analysis and the challenge. Propose an action, asset, quantity, reason, and exit conditions. Holding is a valid decision. Do not force a trade.',
      settings: {
        orderSizePct: { label: 'Order size (% of virtual cash)', type: 'number', min: 0.1, max: 100, step: 0.1, def: 10 },
        stopLossPct: { label: 'Stop loss (% below average cost)', type: 'number', min: 0.1, max: 90, step: 0.1, def: 5 },
        takeProfitPct: { label: 'Take profit (% above average cost)', type: 'number', min: 0.1, max: 500, step: 0.1, def: 8 },
        takeProfitSellPct: { label: 'Share sold at take profit (%)', type: 'number', min: 1, max: 100, step: 1, def: 50 },
        maxTradesPerRun: { label: 'Maximum trades per run', type: 'number', min: 0, max: 10, step: 1, def: 2 },
        maxWarnings: { label: 'Hold if challenge warnings reach', type: 'number', min: 1, max: 10, step: 1, def: 2 },
      },
    },
    rulesCheck: {
      label: 'Rules Check', purpose: 'Application code checks every proposal against your limits. No prompt can override it.',
      inputs: ['trade proposals', 'market snapshot'], outputs: ['approved proposals', 'rejected proposals with reasons'], requires: ['decision'], aiCapable: false,
      prompt: 'Fixed code rules. This text is a description only and cannot change the checks.',
      settings: {
        maxOrderUsd: { label: 'Maximum order ($)', type: 'number', min: 1, max: 1e9, step: 1, def: 1500 },
        minCashReserveUsd: { label: 'Cash to always keep ($)', type: 'number', min: 0, max: 1e9, step: 1, def: 500 },
        maxPositionPct: { label: 'Maximum single position (% of portfolio)', type: 'number', min: 1, max: 100, step: 1, def: 25 },
        maxClassPct: { label: 'Maximum in crypto or in stocks (% of portfolio)', type: 'number', min: 1, max: 100, step: 1, def: 60 },
        dailyLossLimitPct: { label: 'Stop buying after a daily loss of (%)', type: 'number', min: 0.1, max: 100, step: 0.1, def: 3 },
        totalLossLimitPct: { label: 'Stop buying after a total loss of (%)', type: 'number', min: 0.1, max: 100, step: 0.1, def: 15 },
        maxDataAgeMinutes: { label: 'Maximum price age (minutes)', type: 'number', min: 0.5, max: 120, step: 0.5, def: 10 },
        cooldownMinutes: { label: 'Wait before buying the same asset again (minutes)', type: 'number', min: 0, max: 10080, step: 1, def: 60 },
      },
    },
    ledger: {
      label: 'Paper Ledger', purpose: 'Records approved simulated fills and updates virtual cash and holdings. Records holds and rejections without trading.',
      inputs: ['approved and rejected proposals'], outputs: ['simulated fills', 'journal entries'], requires: ['rulesCheck'], aiCapable: false,
      prompt: 'Record approved simulated fills using a fresh eligible price fetched after approval. Record holds and rejections without creating a trade.',
      settings: { maxFillQuoteAgeMinutes: { label: 'Maximum age of the fill price (minutes)', type: 'number', min: 0.5, max: 60, step: 0.5, def: 5 } },
    },
    outcomeReview: {
      label: 'Outcome Review', purpose: 'Later, compares earlier decisions with prices observed afterwards and suggests changes for you to accept or reject.',
      inputs: ['ledger results'], outputs: ['reviews', 'suggested changes (never applied without you)'], requires: ['ledger'], aiCapable: false,
      prompt: 'Compare earlier expectations with results observed after each decision. Explain what worked and what failed. Suggest changes for the person to accept or reject. Never rewrite the strategy.',
      settings: {
        horizonMinutes: { label: 'Review decisions after (minutes)', type: 'number', min: 5, max: 10080, step: 1, def: 240 },
        minReviewsForSuggestion: { label: 'Reviews needed before suggesting changes', type: 'number', min: 2, max: 100, step: 1, def: 5 },
      },
    },
  };
  function cardDefaults(type) { const t = CARD_TYPES[type]; const s = {}; for (const [k, d] of Object.entries(t.settings)) s[k] = d.def; return s; }
  function makeCard(type, overrides = {}) {
    const t = CARD_TYPES[type]; if (!t) throw new Error(`Unknown card type: ${type}`);
    return Object.assign({ id: uid('card'), type, name: t.label, purpose: t.purpose, enabled: true, mode: 'rules', prompt: t.prompt, settings: cardDefaults(type) }, overrides);
  }
  function createDefaultWorkflow() {
    const ids = ['trigger', 'marketWatch', 'analyze', 'challenge', 'decision', 'rulesCheck', 'ledger', 'outcomeReview'];
    const cards = ids.map((t, i) => makeCard(t, { id: `c${i + 1}`, name: `${i + 1}. ${CARD_TYPES[t].label}` }));
    const pairs = [['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c3', 'c5'], ['c4', 'c5'], ['c5', 'c6'], ['c6', 'c7'], ['c7', 'c8']];
    return { cards, connections: pairs.map(([from, to]) => ({ id: `w_${from}_${to}`, from, to })) };
  }
  function validateCardSettings(card) {
    const errs = []; const t = CARD_TYPES[card.type]; if (!t) return [`Unknown card type "${card.type}".`];
    for (const [k, d] of Object.entries(t.settings)) {
      const v = card.settings ? card.settings[k] : undefined;
      if (d.type === 'number') { if (!isNum(v) || v < d.min || v > d.max) errs.push(`${card.name}: "${d.label}" must be a number from ${d.min} to ${d.max}.`); }
      else if (d.type === 'bool') { if (typeof v !== 'boolean') errs.push(`${card.name}: "${d.label}" must be on or off.`); }
      else if (typeof v !== 'string') errs.push(`${card.name}: "${d.label}" must be text.`);
    }
    if (card.type === 'analyze' && card.settings.shortWindow >= card.settings.longWindow) errs.push(`${card.name}: the short average must be shorter than the long average.`);
    if (typeof card.prompt !== 'string' || card.prompt.length > 4000) errs.push(`${card.name}: instructions must be text under 4000 characters.`);
    if (card.mode !== 'rules' && card.mode !== 'ai') errs.push(`${card.name}: mode must be Rules or AI.`);
    if (card.mode === 'ai' && !t.aiCapable) errs.push(`${card.name}: this card type only runs in Rules Mode.`);
    return errs;
  }

  // ---------- workflow validation ----------
  function validateWorkflow(wf) {
    const errors = []; const warnings = [];
    if (!wf || !Array.isArray(wf.cards) || !Array.isArray(wf.connections)) return { ok: false, errors: ['Workflow is missing cards or connections.'], warnings, order: [] };
    const byId = new Map(); for (const c of wf.cards) { if (byId.has(c.id)) errors.push(`Two cards share the id ${c.id}.`); byId.set(c.id, c); }
    for (const c of wf.cards) errors.push(...validateCardSettings(c));
    const seen = new Set();
    for (const e of wf.connections) {
      if (!byId.has(e.from) || !byId.has(e.to)) { errors.push('A connection points to a card that no longer exists.'); continue; }
      if (e.from === e.to) errors.push(`${byId.get(e.from).name} is connected to itself.`);
      const k = e.from + '>' + e.to; if (seen.has(k)) errors.push(`Duplicate connection ${byId.get(e.from).name} → ${byId.get(e.to).name}.`); seen.add(k);
    }
    // loop detection over all connections (enabled or not)
    const adj = new Map(wf.cards.map((c) => [c.id, []]));
    for (const e of wf.connections) if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
    const color = new Map();
    const visit = (id, path) => {
      color.set(id, 1);
      for (const n of adj.get(id)) {
        if (color.get(n) === 1) { errors.push(`Loop found: ${[...path, id, n].map((x) => byId.get(x).name).join(' → ')}. Remove one connection.`); continue; }
        if (!color.get(n)) visit(n, [...path, id]);
      }
      color.set(id, 2);
    };
    for (const c of wf.cards) if (!color.get(c.id)) visit(c.id, []);
    const enabled = wf.cards.filter((c) => c.enabled);
    const triggers = enabled.filter((c) => c.type === 'trigger');
    if (triggers.length !== 1) errors.push(triggers.length ? 'Only one Trigger card can be enabled.' : 'Enable one Trigger card.');
    for (const e of wf.connections) { const t = byId.get(e.to); if (t && t.type === 'trigger') errors.push(`${t.name} cannot receive connections.`); }
    // the ledger may only be fed by Rules Check cards, so nothing can bypass the rules
    for (const e of wf.connections) {
      const f = byId.get(e.from), t = byId.get(e.to);
      if (f && t && t.type === 'ledger' && f.type !== 'rulesCheck') errors.push(`${t.name} can only receive from a Rules Check card, not from ${f.name}.`);
    }
    if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings, order: [] };
    // reachable enabled cards from the trigger, in topological order
    const upstream = (id) => wf.connections.filter((e) => e.to === id).map((e) => byId.get(e.from)).filter((c) => c.enabled);
    const order = []; const reach = new Set([triggers[0].id]);
    const indeg = new Map(); for (const c of enabled) indeg.set(c.id, upstream(c.id).length);
    const queue = [triggers[0].id];
    while (queue.length) {
      const id = queue.shift(); order.push(id);
      for (const e of wf.connections.filter((x) => x.from === id)) {
        const t = byId.get(e.to); if (!t.enabled) continue;
        reach.add(t.id); indeg.set(t.id, indeg.get(t.id) - 1);
        if (indeg.get(t.id) === 0) queue.push(t.id);
      }
    }
    for (const c of enabled) {
      if (!reach.has(c.id)) { warnings.push(`${c.name} is not connected to the trigger and will not run.`); continue; }
      if (!order.includes(c.id)) { warnings.push(`${c.name} has an input from a card that does not run, so it will not run.`); continue; }
      const ups = upstream(c.id).map((u) => u.type);
      for (const r of CARD_TYPES[c.type].requires) if (!ups.includes(r)) errors.push(`${c.name} needs a direct input from an enabled ${CARD_TYPES[r].label} card.`);
    }
    for (const c of wf.cards.filter((x) => !x.enabled)) warnings.push(`${c.name} is turned off.`);
    if (!order.some((id) => byId.get(id).type === 'ledger')) warnings.push('No Paper Ledger card runs, so no pretend trades or journal decisions will be recorded.');
    return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, order: errors.length ? [] : order };
  }

  // ---------- strategy versions ----------
  function strategyFingerprint(wf) {
    return hash({ cards: wf.cards.map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled, mode: c.mode, prompt: c.prompt, settings: c.settings })), connections: wf.connections.map((e) => [e.from, e.to]) });
  }
  function ensureStrategyVersion(state, note, now = Date.now()) {
    const fp = strategyFingerprint(state.workflow);
    const last = state.strategyVersions[state.strategyVersions.length - 1];
    if (last && last.fingerprint === fp) return last;
    const v = { id: `v${(last ? last.number : 0) + 1}`, number: (last ? last.number : 0) + 1, fingerprint: fp, createdAt: now, note: note || 'Edited', workflow: clone(state.workflow) };
    state.strategyVersions.push(v); return v;
  }
  const currentStrategyVersion = (state) => state.strategyVersions[state.strategyVersions.length - 1];

  // ---------- portfolio math ----------
  function latestPrice(state, assetId) { const o = state.latest[assetId]; return o && isNum(o.price) ? o.price : null; }
  function valuation(state) {
    let invested = 0, costBasis = 0, missing = [];
    const byClass = { crypto: 0, stock: 0 };
    const positions = Object.entries(state.account.positions).map(([assetId, p]) => {
      const price = latestPrice(state, assetId);
      const value = price === null ? null : p.qty * price;
      if (value === null) missing.push(assetId); else { invested += value; byClass[assetId.split(':')[0]] += value; }
      costBasis += p.costBasis;
      return { assetId, qty: p.qty, costBasis: p.costBasis, avgCost: p.qty > EPS ? p.costBasis / p.qty : 0, price, value, unrealized: value === null ? null : value - p.costBasis };
    });
    const unrealized = positions.reduce((s, p) => s + (p.unrealized || 0), 0);
    return { cash: state.account.cash, invested, costBasis, equity: state.account.cash + invested, unrealized, positions, missing, byClass };
  }
  function feeFor(notional, s) { return notional * (s.feePct / 100) + s.feeFlatUsd; }

  // Apply one simulated fill to a state copy. Throws on anything that would break the ledger.
  function applyFill(state, f) {
    const acc = state.account;
    if (!['buy', 'sell'].includes(f.side)) throw new Error('Fill side must be buy or sell.');
    if (!isNum(f.qty) || f.qty <= 0) throw new Error('Fill quantity must be above zero.');
    if (!isNum(f.price) || f.price <= 0) throw new Error('Fill price must be above zero.');
    if (!isNum(f.fee) || f.fee < 0) throw new Error('Fee cannot be negative.');
    if (state.fills.some((x) => x.idempotencyKey === f.idempotencyKey)) throw new Error('Duplicate fill blocked: this proposal was already filled.');
    const pos = acc.positions[f.assetId] || { qty: 0, costBasis: 0 };
    if (f.side === 'buy') {
      const cost = f.qty * f.price + f.fee;
      if (cost > acc.cash + EPS) throw new Error(`Insufficient virtual cash: needs $${round(cost)}, has $${round(acc.cash)}. Borrowing is not allowed.`);
      acc.cash = Math.max(0, acc.cash - cost);
      pos.qty += f.qty; pos.costBasis += cost; f.cashChange = -cost; f.realized = 0;
    } else {
      if (f.qty > pos.qty + EPS) throw new Error(`Insufficient holdings: tried to sell ${f.qty}, holds ${pos.qty}. Short selling is not allowed.`);
      const qty = Math.min(f.qty, pos.qty);
      const proceeds = qty * f.price - f.fee;
      if (proceeds < 0) throw new Error('The fee would be larger than the sale.');
      const removed = pos.qty > EPS ? pos.costBasis * (qty / pos.qty) : 0;
      pos.qty -= qty; pos.costBasis -= removed;
      if (pos.qty <= 1e-12) { pos.qty = 0; pos.costBasis = 0; }
      acc.cash += proceeds; f.cashChange = proceeds; f.realized = proceeds - removed; f.costRemoved = removed;
      acc.realizedPnl += f.realized;
    }
    if (pos.qty > 0) acc.positions[f.assetId] = pos; else delete acc.positions[f.assetId];
    acc.feesPaid += f.fee; acc.slippageCost += f.slippageCost || 0;
    f.cashAfter = acc.cash; f.simulated = true;
    if (acc.cash < -EPS) throw new Error('Negative cash is not allowed.');
    state.fills.push(f);
    return f;
  }
  // Recompute the account from fills; used to validate backups and in tests.
  function replayLedger(startingCash, fills) {
    const s = { account: freshAccount(startingCash, 0), fills: [] };
    for (const f of fills) applyFill(s, Object.assign({}, f));
    return s.account;
  }

  // ---------- metrics ----------
  function computeMetrics(state) {
    const v = valuation(state); const acc = state.account;
    const eh = state.equityHistory.filter((p) => p.source === 'forward');
    let peak = -Infinity, maxDd = 0;
    for (const p of eh) { peak = Math.max(peak, p.equity); if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak); }
    const sells = state.fills.filter((f) => f.side === 'sell');
    const wins = sells.filter((f) => f.realized > 0).length;
    const runs = state.runs.filter((r) => !r.test);
    return {
      equity: v.equity, cash: v.cash, invested: v.invested, unrealized: v.unrealized, realized: acc.realizedPnl,
      totalReturnPct: acc.startingCash > 0 ? (v.equity / acc.startingCash - 1) * 100 : 0,
      totalPnl: v.equity - acc.startingCash, fees: acc.feesPaid, slippage: acc.slippageCost,
      maxDrawdownPct: maxDd * 100, completedTrades: sells.length, wins, winRatePct: sells.length ? (wins / sells.length) * 100 : null,
      buys: state.fills.length - sells.length,
      periodStart: acc.createdAt, periodEnd: eh.length ? eh[eh.length - 1].t : acc.createdAt,
      runs: runs.length, failedRuns: runs.filter((r) => r.status === 'failed').length,
      runsWithMissingData: runs.filter((r) => r.missingCount > 0).length,
      missingMarks: v.missing,
    };
  }

  // ---------- AI output validation ----------
  // Model output is untrusted. It can only choose among supplied assets and fixed actions; it never sets prices or sizes.
  function validateAnalysisOutput(obj, allowedAssetIds) {
    const errs = [];
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.proposals)) return { ok: false, errors: ['Output must be an object with a "proposals" list.'] };
    const out = [];
    obj.proposals.forEach((p, i) => {
      if (!p || typeof p !== 'object') { errs.push(`Proposal ${i + 1} is not an object.`); return; }
      if (!allowedAssetIds.includes(p.assetId)) errs.push(`Proposal ${i + 1} names an asset that was not supplied: ${String(p.assetId).slice(0, 40)}.`);
      if (!['buy', 'sell', 'hold'].includes(p.action)) errs.push(`Proposal ${i + 1} has an action other than buy, sell or hold.`);
      if (!isNum(p.confidence) || p.confidence < 0 || p.confidence > 1) errs.push(`Proposal ${i + 1} needs a confidence from 0 to 1.`);
      if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 1000) errs.push(`Proposal ${i + 1} needs a plain reason under 1000 characters.`);
      for (const k of ['price', 'quantity', 'qty', 'notionalUsd', 'cash']) if (k in p) errs.push(`Proposal ${i + 1} tried to set "${k}". Prices and sizes come only from data and code.`);
      out.push({ assetId: p.assetId, action: p.action, confidence: p.confidence, reason: String(p.reason || '').slice(0, 1000), uncertainty: String(p.uncertainty || 'not stated').slice(0, 300), invalidation: String(p.invalidation || 'not stated').slice(0, 300), evidence: Array.isArray(p.evidence) ? p.evidence.slice(0, 8).map((x) => String(x).slice(0, 300)) : [] });
    });
    const ids = out.map((p) => p.assetId); if (new Set(ids).size !== ids.length) errs.push('More than one proposal for the same asset.');
    return errs.length ? { ok: false, errors: errs } : { ok: true, value: out };
  }
  function validateChallengeOutput(obj, proposals) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.verdicts)) return { ok: false, errors: ['Output must be an object with a "verdicts" list.'] };
    const errs = []; const ids = proposals.map((p) => p.assetId); const out = [];
    obj.verdicts.forEach((v, i) => {
      if (!v || !ids.includes(v.assetId)) { errs.push(`Verdict ${i + 1} names an asset with no proposal.`); return; }
      if (typeof v.agree !== 'boolean') errs.push(`Verdict ${i + 1} needs "agree" true or false.`);
      if (!['none', 'warn', 'block'].includes(v.severity)) errs.push(`Verdict ${i + 1} needs severity none, warn or block.`);
      out.push({ assetId: v.assetId, agree: !!v.agree, severity: v.severity, objections: Array.isArray(v.objections) ? v.objections.slice(0, 8).map((x) => String(x).slice(0, 300)) : [] });
    });
    return errs.length ? { ok: false, errors: errs } : { ok: true, value: out };
  }

  // ---------- card handlers ----------
  const fmt = (x, d = 2) => (isNum(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : 'n/a');
  const sym = (id) => id.split(':')[1];

  const handlers = {
    async trigger(card, input, ctx) { return { runId: ctx.runId, reason: ctx.reason, at: ctx.now() }; },

    async marketWatch(card, input, ctx) {
      let st = ctx.state; const wanted = card.settings.assets.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      const assets = st.watchlist.filter((a) => !wanted.length || wanted.includes(a.symbol));
      if (!assets.length) throw new Error('No assets selected. Add assets to the watchlist or fix the asset list on this card.');
      const fetched = await ctx.data.refresh(assets); // updates observations; returns per-asset observation
      st = ctx.getState ? ctx.getState() : st; // saving replaced the state object; read the fresh one
      const now = ctx.now(); const v = valuation(st);
      const rows = assets.map((a) => {
        const obs = fetched[a.id] || st.latest[a.id] || null;
        const cls = classifyObservation(obs, a, now, st.settings);
        const hist = (st.observations[a.id] || []).filter((o) => o.marketTime <= now).slice(-card.settings.historyPoints);
        return { assetId: a.id, symbol: a.symbol, kind: a.kind, price: obs && isNum(obs.price) ? obs.price : null, marketTime: obs ? obs.marketTime : null, fetchedAt: obs ? obs.fetchedAt : null, source: obs ? obs.source : null,
          status: cls.status, tradeable: cls.tradeable, ageMinutes: cls.ageMinutes, note: cls.note, marketOpen: cls.market.open, history: hist.map((o) => ({ t: o.marketTime, p: o.price, src: o.kind })) };
      });
      return {
        at: now, assets: rows,
        portfolio: { cash: v.cash, equity: v.equity, invested: v.invested, byClass: v.byClass, positions: v.positions.map((p) => ({ assetId: p.assetId, qty: p.qty, costBasis: p.costBasis, avgCost: p.avgCost, value: p.value })) },
        missing: rows.filter((r) => r.status === 'unavailable').map((r) => ({ symbol: r.symbol, note: r.note })),
        stale: rows.filter((r) => r.status === 'stale' || r.status === 'closed').map((r) => ({ symbol: r.symbol, status: r.status, note: r.note })),
      };
    },

    async analyze(card, input, ctx) {
      const snap = (input.marketWatch || [])[0]; if (!snap) throw new Error('No market snapshot received.');
      if (card.mode === 'ai') return analyzeWithAI(card, snap, ctx);
      const s = card.settings; const proposals = [];
      for (const a of snap.assets) {
        const pos = snap.portfolio.positions.find((p) => p.assetId === a.assetId);
        const prices = a.history.map((h) => h.p);
        const base = { assetId: a.assetId, action: 'hold', confidence: 0, evidence: [], uncertainty: 'high', invalidation: 'n/a' };
        if (!a.tradeable) { proposals.push({ ...base, reason: `Hold: ${a.symbol} data is ${a.status}. ${a.note}`.trim() }); continue; }
        if (prices.length < s.longWindow) { proposals.push({ ...base, reason: `Hold: only ${prices.length} observations of ${a.symbol}; the long average needs ${s.longWindow}.` }); continue; }
        const sh = sma(prices, s.shortWindow), lo = sma(prices, s.longWindow); const trend = (sh / lo - 1) * 100;
        const vol = volatilityPct(prices, s.longWindow);
        const evidence = [`Latest price $${fmt(a.price)} at ${new Date(a.marketTime).toISOString()} from ${a.source}.`, `Short average (${s.shortWindow}) $${fmt(sh)}, long average (${s.longWindow}) $${fmt(lo)}, gap ${fmt(trend)}%.`, `Volatility per step ${fmt(vol, 3)}%.`];
        const unc = prices.length < s.longWindow * 2 || vol > 1 ? 'high' : trend > s.minTrendPct * 2 ? 'low' : 'medium';
        const conf = Math.max(0, Math.min(1, Math.abs(trend) / (s.minTrendPct * 4 || 1)));
        if (trend >= s.minTrendPct) proposals.push({ assetId: a.assetId, action: 'buy', confidence: conf, evidence, uncertainty: unc, reason: `Buy idea: ${a.symbol} short average is ${fmt(trend)}% above the long average, at least the ${s.minTrendPct}% needed.`, invalidation: `Price falls below the long average of $${fmt(lo)}.` });
        else if (pos && pos.qty > 0 && trend <= -s.minTrendPct) proposals.push({ assetId: a.assetId, action: 'sell', confidence: conf, evidence, uncertainty: unc, reason: `Sell idea: ${a.symbol} short average is ${fmt(-trend)}% below the long average while held.`, invalidation: `Price rises back above the long average of $${fmt(lo)}.` });
        else proposals.push({ assetId: a.assetId, action: 'hold', confidence: 1 - conf, evidence, uncertainty: unc, reason: `Hold: ${a.symbol} trend gap ${fmt(trend)}% is inside the ±${s.minTrendPct}% band${pos ? '' : ' and nothing is held'}.`, invalidation: `Gap moves beyond ±${s.minTrendPct}%.` });
      }
      return { engine: 'Rules Mode', proposals, snapshot: snap };
    },

    async challenge(card, input, ctx) {
      const an = (input.analyze || [])[0]; if (!an) throw new Error('No analysis received.');
      const snap = an.snapshot; if (card.mode === 'ai') return challengeWithAI(card, an, ctx);
      const s = card.settings; const verdicts = [];
      const exposure = snap.portfolio.equity > 0 ? (snap.portfolio.invested / snap.portfolio.equity) * 100 : 0;
      for (const p of an.proposals) {
        const a = snap.assets.find((x) => x.assetId === p.assetId); const obj = []; let severity = 'none';
        const block = (m) => { obj.push(m); severity = 'block'; }; const warn = (m) => { obj.push(m); if (severity === 'none') severity = 'warn'; };
        if (p.action === 'hold') { verdicts.push({ assetId: p.assetId, agree: true, severity, objections: [] }); continue; }
        if (!a || !a.tradeable) block('Price data is not usable right now.');
        const prices = a ? a.history.map((h) => h.p) : [];
        if (prices.length < s.minObservations) block(`Only ${prices.length} observations; at least ${s.minObservations} required.`);
        const vol = volatilityPct(prices, Math.min(prices.length - 1, 20));
        if (vol !== null && vol > s.maxVolatilityPct) block(`Volatility ${fmt(vol, 3)}% per step is above the ${s.maxVolatilityPct}% limit.`);
        if (p.action === 'buy' && exposure >= s.maxExposurePct) block(`Already ${fmt(exposure, 1)}% invested; limit is ${s.maxExposurePct}%.`);
        if (a && a.status === 'delayed') warn(`Price is delayed (${fmt(a.ageMinutes, 1)} min old).`);
        if (p.uncertainty === 'high') warn('The analysis itself rates uncertainty as high.');
        if (s.blockOnLatestMoveAgainst && prices.length >= 2) {
          const last = prices[prices.length - 1], prev = prices[prices.length - 2];
          if (p.action === 'buy' && last < prev) warn(`Latest move is down (${fmt((last / prev - 1) * 100, 3)}%), against the buy idea.`);
          if (p.action === 'sell' && last > prev) warn(`Latest move is up (${fmt((last / prev - 1) * 100, 3)}%), against the sell idea.`);
        }
        verdicts.push({ assetId: p.assetId, agree: severity === 'none', severity, objections: obj });
      }
      return { engine: 'Rules Mode', verdicts, proposals: an.proposals, snapshot: snap };
    },

    async decision(card, input, ctx) {
      const analyses = input.analyze || []; const challenges = input.challenge || [];
      if (!analyses.length) throw new Error('No analysis received.');
      const snap = analyses[0].snapshot; const s = card.settings; const out = []; const holds = [];
      for (const a of snap.assets) {
        const pos = snap.portfolio.positions.find((p) => p.assetId === a.assetId);
        const ideas = analyses.map((x) => x.proposals.find((p) => p.assetId === a.assetId)).filter(Boolean);
        const verdicts = challenges.map((c) => c.verdicts.find((v) => v.assetId === a.assetId)).filter(Boolean);
        // exits first: held positions with a usable price
        if (pos && pos.qty > 0 && a.tradeable) {
          const stop = pos.avgCost * (1 - s.stopLossPct / 100), take = pos.avgCost * (1 + s.takeProfitPct / 100);
          if (a.price <= stop) { out.push({ assetId: a.assetId, action: 'sell', qty: pos.qty, reason: `Exit: ${a.symbol} at $${fmt(a.price)} is at or below the stop loss of $${fmt(stop)} (${s.stopLossPct}% under average cost $${fmt(pos.avgCost)}). Selling the whole position.`, priority: 3, confidence: 1 }); continue; }
          if (a.price >= take) { out.push({ assetId: a.assetId, action: 'sell', qty: pos.qty * (s.takeProfitSellPct / 100), reason: `Exit: ${a.symbol} at $${fmt(a.price)} reached take profit of $${fmt(take)}. Selling ${s.takeProfitSellPct}% of the position.`, priority: 2, confidence: 1 }); continue; }
        }
        const actions = [...new Set(ideas.map((i) => i.action))];
        if (!ideas.length) { holds.push({ assetId: a.assetId, reason: `Hold: no analysis covered ${a.symbol}.` }); continue; }
        if (actions.length > 1) { holds.push({ assetId: a.assetId, reason: `Hold: analysis cards disagree on ${a.symbol} (${actions.join(' vs ')}).` }); continue; }
        const idea = ideas[0];
        if (idea.action === 'hold') { holds.push({ assetId: a.assetId, reason: idea.reason }); continue; }
        const blocks = verdicts.filter((v) => v.severity === 'block');
        const warns = verdicts.reduce((n, v) => n + (v.severity === 'warn' ? v.objections.length : 0), 0);
        if (blocks.length) { holds.push({ assetId: a.assetId, reason: `Hold: the challenge disagreed with "${idea.action} ${a.symbol}": ${blocks.flatMap((b) => b.objections).join(' ')}` }); continue; }
        if (warns >= s.maxWarnings) { holds.push({ assetId: a.assetId, reason: `Hold: ${warns} challenge warnings on ${a.symbol} reach the limit of ${s.maxWarnings}: ${verdicts.flatMap((v) => v.objections).join(' ')}` }); continue; }
        if (idea.action === 'buy') {
          const notionalUsd = snap.portfolio.cash * (s.orderSizePct / 100);
          out.push({ assetId: a.assetId, action: 'buy', notionalUsd, reason: `${idea.reason} Challenge: ${verdicts.length ? (warns ? `${warns} warning(s), below the limit.` : 'agreed.') : 'not connected.'} Buying about $${fmt(notionalUsd)} (${s.orderSizePct}% of cash).`, exit: { stopLossPct: s.stopLossPct, takeProfitPct: s.takeProfitPct, invalidation: idea.invalidation }, priority: 1, confidence: idea.confidence });
        } else if (idea.action === 'sell' && pos && pos.qty > 0) {
          out.push({ assetId: a.assetId, action: 'sell', qty: pos.qty, reason: `${idea.reason} Selling the whole position.`, priority: 2, confidence: idea.confidence });
        } else holds.push({ assetId: a.assetId, reason: `Hold: sell idea for ${a.symbol} but nothing is held.` });
      }
      out.sort((x, y) => y.priority - x.priority || y.confidence - x.confidence);
      const chosen = out.slice(0, s.maxTradesPerRun);
      for (const p of out.slice(s.maxTradesPerRun)) holds.push({ assetId: p.assetId, reason: `Hold: ${p.action} ${sym(p.assetId)} skipped because the run limit is ${s.maxTradesPerRun} trade(s).` });
      return { proposals: chosen.map((p) => ({ ...p, proposalId: `${ctx.runId}:${p.assetId}:${p.action}` })), holds, snapshot: snap };
    },

    async rulesCheck(card, input, ctx) {
      const dec = (input.decision || [])[0]; if (!dec) throw new Error('No decision received.');
      const s = card.settings; const st = ctx.state; const set = st.settings; const snap = dec.snapshot; const now = ctx.now();
      const v = valuation(st); let reserved = 0; const approved = [], rejected = [];
      const dayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); const pts = st.equityHistory.filter((p) => p.source === 'forward' && p.t >= d.getTime()); return pts.length ? pts[0].equity : null; })();
      for (const p of dec.proposals) {
        const a = snap.assets.find((x) => x.assetId === p.assetId); const fails = []; const checks = [];
        const ok = (m) => checks.push('✓ ' + m);
        if (!a || !isNum(a.price)) fails.push('No usable price.');
        else {
          if (!a.tradeable) fails.push(`Data status is ${a.status}. ${a.note}`); else ok(`data ${a.status}`);
          if (a.ageMinutes > s.maxDataAgeMinutes) fails.push(`Price is ${fmt(a.ageMinutes, 1)} min old; the limit is ${s.maxDataAgeMinutes} min.`); else ok('price age within limit');
          if (a.kind === 'stock' && !stockMarketStatus(now).open) fails.push('The stock market is closed.');
        }
        const pos = st.account.positions[p.assetId];
        if (p.action === 'buy' && a && isNum(a.price)) {
          const n = p.notionalUsd; const estPrice = a.price * (1 + set.slippagePct / 100); const fee = feeFor(n, set);
          if (!isNum(n) || n <= 0) fails.push('Order size must be above zero.');
          if (n > s.maxOrderUsd + EPS) fails.push(`Order $${fmt(n)} is above the maximum order of $${fmt(s.maxOrderUsd)}.`); else ok('order size');
          if (n + fee > st.account.cash - reserved - s.minCashReserveUsd + EPS) fails.push(`Not enough free virtual cash: needs $${fmt(n + fee)} with fees, available $${fmt(st.account.cash - reserved - s.minCashReserveUsd)} after the $${fmt(s.minCashReserveUsd)} reserve and other approvals this run.`); else ok('cash available');
          const posVal = (pos ? pos.qty * a.price : 0) + n;
          if (v.equity > 0 && (posVal / v.equity) * 100 > s.maxPositionPct + EPS) fails.push(`Position would be ${fmt((posVal / v.equity) * 100, 1)}% of the portfolio; limit ${s.maxPositionPct}%.`); else ok('position size');
          const cls = (v.byClass[a.kind] || 0) + n;
          if (v.equity > 0 && (cls / v.equity) * 100 > s.maxClassPct + EPS) fails.push(`${a.kind === 'crypto' ? 'Crypto' : 'Stocks'} would be ${fmt((cls / v.equity) * 100, 1)}% of the portfolio; limit ${s.maxClassPct}%.`); else ok('concentration');
          if (v.equity < st.account.startingCash * (1 - s.totalLossLimitPct / 100)) fails.push(`Total loss limit of ${s.totalLossLimitPct}% reached; new buys are paused.`); else ok('total loss limit');
          if (dayStart && v.equity < dayStart * (1 - s.dailyLossLimitPct / 100)) fails.push(`Daily loss limit of ${s.dailyLossLimitPct}% reached; new buys are paused today.`); else ok('daily loss limit');
          const lastBuy = [...st.fills].reverse().find((f) => f.assetId === p.assetId && f.side === 'buy');
          if (lastBuy && now - lastBuy.filledAt < s.cooldownMinutes * 60000) fails.push(`Bought ${sym(p.assetId)} ${fmt((now - lastBuy.filledAt) / 60000, 0)} min ago; wait is ${s.cooldownMinutes} min.`); else ok('cooldown');
          if (!fails.length) reserved += n + fee; void estPrice;
        } else if (p.action === 'sell') {
          if (!isNum(p.qty) || p.qty <= 0) fails.push('Sale quantity must be above zero.');
          else if (!pos || p.qty > pos.qty + EPS) fails.push(`Cannot sell ${p.qty} ${sym(p.assetId)}: the account holds ${pos ? pos.qty : 0}.`); else ok('holdings sufficient');
        } else if (p.action !== 'buy') fails.push('Unknown action.');
        if (st.fills.some((f) => f.idempotencyKey === p.proposalId)) fails.push('This exact proposal was already filled.');
        if (fails.length) rejected.push({ ...p, failures: fails });
        else { const token = { proposalId: p.proposalId, runId: ctx.runId, approvedAt: now }; ctx.approvals.set(p.proposalId, token); approved.push({ ...p, checks, approvedAt: now }); }
      }
      return { approved, rejected, holds: dec.holds, snapshot: snap };
    },

    async ledger(card, input, ctx) {
      const st = ctx.state; const fills = [], rejected = [], holds = [];
      for (const rc of input.rulesCheck || []) {
        for (const r of rc.rejected) rejected.push({ assetId: r.assetId, action: r.action, reason: r.reason, failures: r.failures });
        for (const h of rc.holds) holds.push(h);
        for (const p of rc.approved) {
          const token = ctx.approvals.get(p.proposalId);
          if (!token || token.runId !== ctx.runId) { rejected.push({ assetId: p.assetId, action: p.action, reason: p.reason, failures: ['No approval from the Rules Check code for this run.'] }); continue; }
          const asset = st.watchlist.find((x) => x.id === p.assetId) || { id: p.assetId, kind: p.assetId.split(':')[0], symbol: sym(p.assetId) };
          let q; try { q = await ctx.data.fillQuote(asset); } catch (e) { q = { error: e.message }; }
          const cls = classifyObservation(q, asset, ctx.now(), st.settings);
          const maxAge = card.settings.maxFillQuoteAgeMinutes;
          const eligible = q && !q.error && cls.tradeable && q.fetchedAt >= token.approvedAt && cls.ageMinutes <= maxAge;
          if (!eligible) { rejected.push({ assetId: p.assetId, action: p.action, reason: p.reason, failures: [`No eligible fill price after approval: ${q && q.error ? q.error : cls.note || `price older than ${maxAge} min`}. No trade was made.`] }); continue; }
          const set = st.settings; const slip = set.slippagePct / 100;
          const price = p.action === 'buy' ? q.price * (1 + slip) : q.price * (1 - slip);
          let qty, notional;
          if (p.action === 'buy') { notional = p.notionalUsd; qty = notional / price; } else { qty = p.qty; notional = qty * price; }
          qty = Math.floor(qty * 1e8) / 1e8; notional = qty * price;
          const fill = { id: uid('fill'), idempotencyKey: p.proposalId, runId: ctx.runId, strategyVersionId: ctx.strategyVersionId, assetId: p.assetId, side: p.action, qty, quotePrice: q.price, price, fee: feeFor(notional, set), slippageCost: Math.abs(price - q.price) * qty,
            quoteMarketTime: q.marketTime, quoteFetchedAt: q.fetchedAt, quoteSource: q.source, filledAt: ctx.now(), assumptions: `Simulated fill at the ${q.source} price with ${set.slippagePct}% slippage against you, fee ${set.feePct}% + $${set.feeFlatUsd}. No order book or partial fills modeled.`, reason: p.reason, exit: p.exit || null };
          if (ctx.test) { fills.push({ ...fill, test: true }); continue; }
          try { await ctx.commitFill(fill); fills.push(fill); }
          catch (e) { rejected.push({ assetId: p.assetId, action: p.action, reason: p.reason, failures: [e.message] }); }
        }
      }
      return { fills, rejected, holds, test: !!ctx.test };
    },

    async outcomeReview(card, input, ctx) {
      const st = ctx.state; const now = ctx.now(); const h = card.settings.horizonMinutes * 60000; const reviews = [];
      for (const d of st.decisions) {
        if (d.reviewedAt || now - d.at < h || !isNum(d.price)) continue;
        // first observation at or after the horizon; observed after the decision, never fed back into it
        const later = (st.observations[d.assetId] || []).find((o) => o.marketTime >= d.at + h && o.fetchedAt >= d.at);
        if (!later) continue;
        const chg = (later.price / d.price - 1) * 100; const thr = d.thresholdPct ?? 0.5;
        let verdict, text;
        if (d.action === 'buy') { verdict = chg > 0 ? 'worked' : 'failed'; text = `Bought ${sym(d.assetId)} at $${fmt(d.price)}; ${card.settings.horizonMinutes} min later it was $${fmt(later.price)} (${fmt(chg)}%).`; }
        else if (d.action === 'sell') { verdict = chg < 0 ? 'worked' : 'failed'; text = `Sold ${sym(d.assetId)} at $${fmt(d.price)}; later $${fmt(later.price)} (${fmt(chg)}%). ${chg < 0 ? 'Selling avoided a drop.' : 'The price rose after the sale.'}`; }
        else { verdict = Math.abs(chg) < thr * 2 ? 'worked' : 'missed move'; text = `Held ${sym(d.assetId)} at $${fmt(d.price)}; later $${fmt(later.price)} (${fmt(chg)}%).`; }
        reviews.push({ id: uid('rev'), decisionId: d.id, assetId: d.assetId, action: d.action, at: now, decisionAt: d.at, priceThen: d.price, priceLater: later.price, laterTime: later.marketTime, changePct: chg, verdict, text, strategyVersionId: d.strategyVersionId });
      }
      const suggestions = [];
      const all = [...st.reviews, ...reviews]; const n = card.settings.minReviewsForSuggestion;
      const buys = all.filter((r) => r.action === 'buy'); const failedBuys = buys.filter((r) => r.verdict === 'failed').length;
      const analyzeCard = st.workflow.cards.find((c) => c.type === 'analyze' && c.enabled);
      const pending = (k) => st.suggestions.some((x) => x.key === k && x.status === 'pending');
      if (analyzeCard && buys.length >= n && failedBuys / buys.length > 0.6 && !pending('raiseTrend')) {
        const to = round(analyzeCard.settings.minTrendPct + 0.25, 2);
        suggestions.push({ key: 'raiseTrend', cardId: analyzeCard.id, setting: 'minTrendPct', from: analyzeCard.settings.minTrendPct, to, why: `${failedBuys} of ${buys.length} reviewed buys lost value within the review window. Requiring a stronger trend (${to}%) may filter weak signals.` });
      }
      const holdsMissed = all.filter((r) => r.action === 'hold' && r.verdict === 'missed move').length; const holdsAll = all.filter((r) => r.action === 'hold').length;
      if (analyzeCard && holdsAll >= n * 2 && holdsMissed / holdsAll > 0.5 && analyzeCard.settings.minTrendPct > 0.2 && !pending('lowerTrend')) {
        const to = round(Math.max(0.1, analyzeCard.settings.minTrendPct - 0.25), 2);
        suggestions.push({ key: 'lowerTrend', cardId: analyzeCard.id, setting: 'minTrendPct', from: analyzeCard.settings.minTrendPct, to, why: `${holdsMissed} of ${holdsAll} reviewed holds missed a move larger than twice the threshold. A lower threshold (${to}%) would act sooner, with more false signals.` });
      }
      return { reviews, suggestions, note: reviews.length ? '' : `No earlier decisions are old enough (${card.settings.horizonMinutes} min) with a later price yet.` };
    },
  };

  async function analyzeWithAI(card, snap, ctx) {
    if (!ctx.ai || !ctx.ai.available) throw new Error('AI Mode is unavailable: no local model is connected. Switch this card to Rules Mode or connect a local model in Settings.');
    const facts = { assets: snap.assets.map((a) => ({ assetId: a.assetId, price: a.price, marketTime: a.marketTime && new Date(a.marketTime).toISOString(), status: a.status, tradeable: a.tradeable, recentPrices: a.history.slice(-30).map((h) => h.p) })), portfolio: snap.portfolio, indicatorSettings: card.settings };
    const schema = '{"proposals":[{"assetId":"one of the supplied assetId values","action":"buy|sell|hold","confidence":0.0-1.0,"reason":"text","uncertainty":"text","invalidation":"text","evidence":["text"]}]}';
    const raw = await ctx.ai.completeJSON({ instructions: card.prompt, facts, schema });
    const v = validateAnalysisOutput(raw, snap.assets.map((a) => a.assetId));
    if (!v.ok) throw new Error('AI output rejected: ' + v.errors.join(' '));
    // untradeable assets are forced to hold no matter what the model said
    const proposals = v.value.map((p) => { const a = snap.assets.find((x) => x.assetId === p.assetId); return a.tradeable ? p : { ...p, action: 'hold', reason: `Hold forced by code: data is ${a.status}. Model said: ${p.reason}` }; });
    for (const a of snap.assets) if (!proposals.some((p) => p.assetId === a.assetId)) proposals.push({ assetId: a.assetId, action: 'hold', confidence: 0, reason: 'Hold: the model gave no proposal for this asset.', uncertainty: 'high', invalidation: 'n/a', evidence: [] });
    return { engine: `AI Mode (${ctx.ai.model}, local)`, proposals, snapshot: snap, raw };
  }
  async function challengeWithAI(card, an, ctx) {
    if (!ctx.ai || !ctx.ai.available) throw new Error('AI Mode is unavailable: no local model is connected.');
    const acts = an.proposals.filter((p) => p.action !== 'hold');
    const schema = '{"verdicts":[{"assetId":"text","agree":true,"severity":"none|warn|block","objections":["text"]}]}';
    const raw = await ctx.ai.completeJSON({ instructions: card.prompt, facts: { proposals: acts, assets: an.snapshot.assets.map((a) => ({ assetId: a.assetId, price: a.price, status: a.status, recentPrices: a.history.slice(-30).map((h) => h.p) })), portfolio: an.snapshot.portfolio }, schema });
    const v = validateChallengeOutput(raw, acts);
    if (!v.ok) throw new Error('AI output rejected: ' + v.errors.join(' '));
    for (const p of acts) if (!v.value.some((x) => x.assetId === p.assetId)) v.value.push({ assetId: p.assetId, agree: false, severity: 'block', objections: ['The model gave no verdict, so code treats it as an objection.'] });
    return { engine: `AI Mode (${ctx.ai.model}, local)`, verdicts: v.value, proposals: an.proposals, snapshot: an.snapshot, raw };
  }

  // ---------- engine ----------
  function createEngine(deps) {
    // deps: { getState, commit(mutator) -> Promise, data: {refresh, fillQuote}, ai, now, lock(fn) -> Promise, onEvent }
    const now = deps.now || (() => Date.now());
    let running = null;
    const emit = (e) => { try { deps.onEvent && deps.onEvent(e); } catch (_) { /* ui errors never break a run */ } };

    async function run({ reason = 'manual', test = false, untilCardId = null } = {}) {
      if (running) return { skipped: true, message: `A run (${running}) is already in progress. Overlapping runs are not allowed.` };
      const runId = uid('run'); running = runId;
      try {
        const exec = () => execute(runId, reason, test, untilCardId);
        const res = await (deps.lock ? deps.lock(exec) : exec());
        return res || { skipped: true, message: 'Another tab is running the workflow. Overlapping runs are not allowed.' };
      } finally { running = null; emit({ type: 'idle' }); }
    }

    async function execute(runId, reason, test, untilCardId) {
      const state = deps.getState(); const wf = clone(state.workflow);
      const val = validateWorkflow(wf);
      const sv = currentStrategyVersion(state);
      const runRec = { id: runId, reason, test, startedAt: now(), endedAt: null, status: 'running', strategyVersionId: sv.id, strategyFingerprint: sv.fingerprint,
        cardVersions: wf.cards.map((c) => ({ cardId: c.id, name: c.name, mode: c.mode, promptHash: hash(c.prompt), settingsHash: hash(c.settings) })), steps: [], edges: {}, errors: [], missingCount: 0 };
      emit({ type: 'runStart', run: runRec });
      if (!val.ok) {
        runRec.status = 'failed'; runRec.errors = val.errors; runRec.endedAt = now();
        await finish(runRec, test, null); return runRec;
      }
      const byId = new Map(wf.cards.map((c) => [c.id, c])); const outputs = new Map(); const failed = new Set();
      let order = val.order;
      if (untilCardId) { // test card: run only the cards needed to reach it
        const need = new Set([untilCardId]); let grew = true;
        while (grew) { grew = false; for (const e of wf.connections) if (need.has(e.to) && !need.has(e.from) && byId.get(e.from).enabled) { need.add(e.from); grew = true; } }
        order = order.filter((id) => need.has(id));
        if (!order.includes(untilCardId)) { runRec.status = 'failed'; runRec.errors = ['This card does not run in the current workflow (check that it is on and connected).']; runRec.endedAt = now(); await finish(runRec, test, null); return runRec; }
      }
      const ctx = { runId, reason, test, state, getState: deps.getState, now, data: deps.data, ai: deps.ai, approvals: new Map(), strategyVersionId: sv.id, commitFill: (fill) => deps.commit((s) => { applyFill(s, fill); }) };
      for (const id of order) {
        const card = byId.get(id);
        const ups = wf.connections.filter((e) => e.to === id).map((e) => ({ e, c: byId.get(e.from) })).filter((x) => x.c.enabled && outputs.has(x.c.id));
        const missingReq = CARD_TYPES[card.type].requires.filter((r) => !ups.some((u) => u.c.type === r));
        const step = { cardId: id, name: card.name, type: card.type, mode: card.mode, startedAt: now(), status: 'running', input: null, output: null, error: null };
        runRec.steps.push(step);
        if (wf.connections.some((e) => e.to === id && failed.has(e.from)) || missingReq.length) {
          step.status = 'skipped'; step.error = 'Skipped because an earlier card failed or gave no output.'; step.endedAt = now(); failed.add(id); emit({ type: 'step', step, run: runRec }); continue;
        }
        const input = {}; for (const u of ups) { (input[u.c.type] = input[u.c.type] || []).push(outputs.get(u.c.id)); runRec.edges[u.e.id] = summarizePayload(outputs.get(u.c.id)); }
        step.input = summarizePayload(input);
        emit({ type: 'step', step, run: runRec });
        try {
          ctx.state = deps.getState(); // ledger commits replace state; always read the latest
          const out = await handlers[card.type](card, input, ctx);
          outputs.set(id, out); step.output = summarizePayload(out); step.status = 'done';
          if (card.type === 'marketWatch') runRec.missingCount = out.missing.length + out.stale.length;
        } catch (e) {
          step.status = 'failed'; step.error = e.message || String(e); failed.add(id); runRec.errors.push(`${card.name}: ${step.error}`);
        }
        step.endedAt = now(); emit({ type: 'step', step, run: runRec });
      }
      runRec.status = runRec.errors.length ? 'failed' : 'done'; runRec.endedAt = now();
      await finish(runRec, test, { outputs, byId, wf });
      return runRec;
    }

    async function finish(runRec, test, res) {
      if (test) { emit({ type: 'runEnd', run: runRec }); return; }
      await deps.commit((s) => {
        const sv = runRec.strategyVersionId; const t = runRec.endedAt;
        if (res) {
          for (const [id, out] of res.outputs) {
            const card = res.byId.get(id);
            if (card.type === 'ledger') {
              const snap = findSnapshot(res.outputs, res.byId);
              const priceOf = (aid) => { const a = snap && snap.assets.find((x) => x.assetId === aid); return a ? a.price : null; };
              const thr = (res.wf.cards.find((c) => c.type === 'analyze' && c.enabled) || { settings: {} }).settings.minTrendPct;
              for (const f of out.fills) { s.journal.push({ id: uid('j'), t: f.filledAt, kind: f.side, runId: runRec.id, strategyVersionId: sv, assetId: f.assetId, text: `Simulated ${f.side} of ${fmt(f.qty, 8)} ${sym(f.assetId)} at $${fmt(f.price, 4)} (quote $${fmt(f.quotePrice, 4)} from ${f.quoteSource} at ${new Date(f.quoteMarketTime).toISOString()}). Fee $${fmt(f.fee)}. ${f.side === 'sell' ? `Realized result $${fmt(f.realized)}. ` : ''}Why: ${f.reason}`, fillId: f.id });
                s.decisions.push({ id: uid('d'), runId: runRec.id, at: f.filledAt, assetId: f.assetId, action: f.side, price: f.quotePrice, strategyVersionId: sv, thresholdPct: thr }); }
              for (const r of out.rejected) { s.journal.push({ id: uid('j'), t, kind: 'rejected', runId: runRec.id, strategyVersionId: sv, assetId: r.assetId, text: `Rejected ${r.action} ${sym(r.assetId)}. ${r.failures.join(' ')} The proposal was: ${r.reason}` });
                s.decisions.push({ id: uid('d'), runId: runRec.id, at: t, assetId: r.assetId, action: 'hold', price: priceOf(r.assetId), strategyVersionId: sv, thresholdPct: thr, note: 'rejected' }); }
              for (const h of out.holds) { s.journal.push({ id: uid('j'), t, kind: 'hold', runId: runRec.id, strategyVersionId: sv, assetId: h.assetId, text: h.reason });
                s.decisions.push({ id: uid('d'), runId: runRec.id, at: t, assetId: h.assetId, action: 'hold', price: priceOf(h.assetId), strategyVersionId: sv, thresholdPct: thr }); }
            }
            if (card.type === 'outcomeReview') {
              for (const r of out.reviews) { s.reviews.push(r); const d = s.decisions.find((x) => x.id === r.decisionId); if (d) d.reviewedAt = t;
                s.journal.push({ id: uid('j'), t, kind: 'review', runId: runRec.id, strategyVersionId: r.strategyVersionId, assetId: r.assetId, text: `Review (${r.verdict}): ${r.text}` }); }
              for (const g of out.suggestions) s.suggestions.push({ ...g, id: uid('sug'), status: 'pending', createdAt: t, runId: runRec.id });
            }
          }
        }
        if (runRec.status === 'failed') s.journal.push({ id: uid('j'), t: runRec.endedAt, kind: 'failed', runId: runRec.id, strategyVersionId: sv, text: `Run failed, so no new trades were made for the failed part. ${runRec.errors.join(' ')}` });
        const v = valuation(s);
        s.equityHistory.push({ t: runRec.endedAt, equity: v.equity, cash: v.cash, invested: v.invested, staleMarks: v.missing.length > 0, source: 'forward', runId: runRec.id });
        if (s.equityHistory.length > 5000) s.equityHistory.splice(0, s.equityHistory.length - 5000);
        s.runs.push(runRec); if (s.runs.length > 300) s.runs.splice(0, s.runs.length - 300);
        if (s.journal.length > 5000) s.journal.splice(0, s.journal.length - 5000);
        if (runRec.reason === 'schedule' || runRec.reason === 'manual') s.schedule.lastRunAt = runRec.startedAt;
      });
      emit({ type: 'runEnd', run: runRec });
    }
    return { run, isRunning: () => running };
  }
  function findSnapshot(outputs, byId) { for (const [id, o] of outputs) if (byId.get(id).type === 'marketWatch') return o; return null; }
  // keep edge/step payloads inspectable but bounded in size
  function summarizePayload(p) {
    return JSON.parse(JSON.stringify(p, (k, v) => {
      if (k === 'history' && Array.isArray(v)) return { observations: v.length, first: v[0] || null, last: v[v.length - 1] || null };
      if (k === 'raw') return '[model output, validated above]';
      return v;
    }));
  }

  // ---------- outcome suggestions ----------
  function acceptSuggestion(state, sugId, now = Date.now()) {
    const g = state.suggestions.find((x) => x.id === sugId); if (!g || g.status !== 'pending') throw new Error('Suggestion not found or already decided.');
    const card = state.workflow.cards.find((c) => c.id === g.cardId); if (!card) throw new Error('The card this suggestion targets no longer exists.');
    card.settings[g.setting] = g.to; g.status = 'accepted'; g.decidedAt = now;
    const v = ensureStrategyVersion(state, `Accepted suggestion: ${card.name} ${g.setting} ${g.from} → ${g.to}`, now); g.versionId = v.id; return v;
  }
  function rejectSuggestion(state, sugId, now = Date.now()) { const g = state.suggestions.find((x) => x.id === sugId); if (!g || g.status !== 'pending') throw new Error('Suggestion not found or already decided.'); g.status = 'rejected'; g.decidedAt = now; }

  // ---------- backups ----------
  function exportBackup(state, now = Date.now()) {
    const data = clone(state);
    if (!data.settings.includeKeyInBackup) data.settings.finnhubKey = '';
    return { app: APP_ID, format: BACKUP_FORMAT, exportedAt: new Date(now).toISOString(), note: 'Simulated paper-trading data only. No real money.', data };
  }
  function validateBackup(obj) {
    const errors = [];
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['The file is not a JSON object.'] };
    if (obj.app !== APP_ID) errors.push('This file is not a Paper Trader backup.');
    if (obj.format !== BACKUP_FORMAT) errors.push(`Unsupported backup format ${obj.format}.`);
    const d = obj.data;
    if (!d || typeof d !== 'object') return { ok: false, errors: [...errors, 'Backup has no data section.'] };
    const arrays = ['watchlist', 'strategyVersions', 'fills', 'journal', 'runs', 'decisions', 'reviews', 'suggestions', 'equityHistory'];
    for (const k of arrays) if (!Array.isArray(d[k])) errors.push(`Backup is missing the ${k} list.`);
    for (const k of ['settings', 'account', 'workflow', 'observations', 'latest', 'schedule']) if (!d[k] || typeof d[k] !== 'object') errors.push(`Backup is missing ${k}.`);
    if (errors.length) return { ok: false, errors };
    const a = d.account;
    if (!isNum(a.startingCash) || a.startingCash <= 0) errors.push('Starting cash must be a positive number.');
    if (!isNum(a.cash) || a.cash < -EPS) errors.push('Cash cannot be negative.');
    for (const [k, p] of Object.entries(a.positions || {})) if (!isNum(p.qty) || p.qty < 0 || !isNum(p.costBasis)) errors.push(`Position ${k} is invalid.`);
    for (const w of d.watchlist) { try { makeAsset(w.kind, w.symbol); } catch (e) { errors.push(`Watchlist item ${String(w.symbol).slice(0, 20)}: ${e.message}`); } }
    const wv = validateWorkflow(d.workflow); if (!wv.ok) errors.push(...wv.errors.map((e) => 'Workflow: ' + e));
    if (!errors.length) {
      try {
        const re = replayLedger(a.startingCash, d.fills);
        if (Math.abs(re.cash - a.cash) > 0.01) errors.push(`Cash ($${fmt(a.cash)}) does not match the recorded fills ($${fmt(re.cash)}).`);
        const keys = new Set([...Object.keys(re.positions), ...Object.keys(a.positions)]);
        for (const k of keys) { const x = re.positions[k] || { qty: 0 }, y = a.positions[k] || { qty: 0 }; if (Math.abs(x.qty - y.qty) > 1e-6) errors.push(`Holdings of ${k} do not match the recorded fills.`); }
      } catch (e) { errors.push('Recorded fills are inconsistent: ' + e.message); }
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, errors: [], summary: { exportedAt: obj.exportedAt, cash: a.cash, positions: Object.keys(a.positions).length, fills: d.fills.length, journal: d.journal.length, cards: d.workflow.cards.length, versions: d.strategyVersions.length, watchlist: d.watchlist.length } };
  }
  function restoreFromBackup(obj, currentSettings) {
    const v = validateBackup(obj); if (!v.ok) throw new Error(v.errors.join(' '));
    const d = clone(obj.data); d.app = APP_ID; d.schema = STATE_SCHEMA; d.settings = Object.assign(defaultSettings(), d.settings);
    if (!d.settings.finnhubKey && currentSettings && currentSettings.finnhubKey) d.settings.finnhubKey = currentSettings.finnhubKey;
    d.dataLog = d.dataLog || []; d.schedule.enabled = false;
    return d;
  }
  function csvCell(v) { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s; }
  function fillsToCsv(fills) {
    const cols = ['filled_at_utc', 'side', 'symbol', 'asset_type', 'quantity', 'fill_price_usd', 'quote_price_usd', 'fee_usd', 'slippage_cost_usd', 'cash_change_usd', 'cash_after_usd', 'realized_usd', 'quote_source', 'quote_market_time_utc', 'run_id', 'strategy_version', 'simulated', 'reason'];
    const rows = fills.map((f) => [new Date(f.filledAt).toISOString(), f.side, sym(f.assetId), f.assetId.split(':')[0], f.qty, f.price, f.quotePrice, f.fee, f.slippageCost, f.cashChange, f.cashAfter, f.realized, f.quoteSource, new Date(f.quoteMarketTime).toISOString(), f.runId, f.strategyVersionId, 'yes', f.reason]);
    return [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }
  function resetAccount(state, startingCash, now = Date.now()) {
    if (!isNum(startingCash) || startingCash < 1 || startingCash > 1e9) throw new Error('Starting cash must be between $1 and $1,000,000,000.');
    state.settings.startingCash = startingCash; state.account = freshAccount(startingCash, now);
    state.fills = []; state.journal = [{ id: uid('j'), t: now, kind: 'note', text: `Account reset with $${fmt(startingCash)} virtual cash.` }]; state.decisions = []; state.reviews = []; state.equityHistory = []; state.runs = [];
    state.suggestions = state.suggestions.filter((s) => s.status !== 'pending'); state.schedule.enabled = false;
  }

  return { EPS, APP_ID, CARD_TYPES, COINGECKO_IDS, uid, clone, hash, round, stableStringify, makeAsset, defaultWatchlist, stockMarketStatus, marketStatusFor, classifyObservation, sma, volatilityPct,
    defaultSettings, createInitialState, makeCard, cardDefaults, createDefaultWorkflow, validateWorkflow, validateCardSettings, strategyFingerprint, ensureStrategyVersion, currentStrategyVersion,
    valuation, applyFill, replayLedger, computeMetrics, feeFor, validateAnalysisOutput, validateChallengeOutput, handlers, createEngine, summarizePayload,
    acceptSuggestion, rejectSuggestion, exportBackup, validateBackup, restoreFromBackup, fillsToCsv, resetAccount, fmt };
});

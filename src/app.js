/* Paper Trader browser app: state, saving, scheduler and the five screens. */
(function () {
  'use strict';
  const C = PTCore, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (x, d = 2) => (Number.isFinite(x) ? (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const signed = (x) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + usd(x) : '—');
  const cls = (x) => (x > 0.004 ? 'pos' : x < -0.004 ? 'neg' : '');
  const qtyf = (x) => (Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—');
  const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—');
  const pct = (x, d = 2) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) + '%' : '—');

  let S = null; let tab = 'dashboard'; let selCard = null; let selEdge = null; let journalFilter = 'all'; let journalLimit = 150;
  let live = { run: null, activeCard: null, msg: '' }; let pendingImport = null;

  // ---------- saving: every change goes through one queue; memory only changes after the save succeeds ----------
  let chain = Promise.resolve();
  function commit(mut) {
    const p = chain.then(async () => {
      const next = C.clone(S); const r = mut(next);
      if (next.account.cash < -C.EPS) throw new Error('Blocked: negative cash.');
      for (const [k, v] of Object.entries(next.account.positions)) if (!(v.qty >= 0)) throw new Error(`Blocked: invalid holding for ${k}.`);
      await PTStore.save(next); S = next; render(); return r;
    });
    chain = p.catch(() => {}); return p;
  }

  const data = PTData.createDataLayer({ fetch: (u, o) => fetch(u, o), getState: () => S, commit });
  const ai = PTAI.createAI({ fetch: (u, o) => fetch(u, o), getSettings: () => S.settings });
  const engine = C.createEngine({ getState: () => S, commit, data, ai, lock: PTStore.withRunLock, onEvent });

  function onEvent(e) {
    if (e.type === 'runStart') { live.run = e.run; live.activeCard = null; }
    if (e.type === 'step') { live.activeCard = e.step.status === 'running' ? e.step.cardId : live.activeCard; }
    if (e.type === 'runEnd') { live.msg = summarizeRun(e.run); live.lastRun = e.run; live.run = null; live.activeCard = null; render(); }
    if (e.type === 'idle') live.activeCard = null;
    paintLive();
  }
  function summarizeRun(r) {
    if (r.test) return `Test finished (${r.status}). Nothing was recorded.`;
    return r.status === 'done' ? `Run ${r.id.slice(-6)} finished at ${when(r.endedAt)}.` : `Run ${r.id.slice(-6)} failed: ${r.errors[0] || ''}`;
  }

  // ---------- modal (no browser dialogs) ----------
  function ask(title, bodyHtml, actions) {
    return new Promise((res) => {
      $('#modal-title').textContent = title; $('#modal-body').innerHTML = bodyHtml;
      const box = $('#modal-actions'); box.innerHTML = '';
      for (const a of actions) { const b = document.createElement('button'); b.textContent = a.label; if (a.cls) b.className = a.cls; b.onclick = () => { $('#modal').hidden = true; res(a.value); }; box.appendChild(b); }
      $('#modal').hidden = false; box.lastChild.focus();
    });
  }
  const confirmDanger = (title, text, yes) => ask(title, `<p>${text}</p>`, [{ label: 'Cancel', value: false }, { label: yes, value: true, cls: 'danger' }]);
  const info = (title, html) => ask(title, html, [{ label: 'OK', value: true, cls: 'primary' }]);

  // ---------- run controls ----------
  async function runOnce(opts = { reason: 'manual' }) {
    const r = await engine.run(opts);
    if (r && r.skipped) { live.msg = r.message; paintLive(); }
    return r;
  }
  function startSchedule() { commit((s) => { s.schedule.enabled = true; }); live.msg = 'Schedule started. It runs only while this page stays open.'; }
  function pauseSchedule() { commit((s) => { s.schedule.enabled = false; }); live.msg = 'Paused. No scheduled runs will start.'; }
  function triggerCard() { return S.workflow.cards.find((c) => c.type === 'trigger' && c.enabled); }
  function nextRunAt() { const t = triggerCard(); if (!S.schedule.enabled || !t) return null; return (S.schedule.lastRunAt || 0) + t.settings.scheduleMinutes * 60000; }
  setInterval(() => {
    if (!S || !S.schedule.enabled || engine.isRunning()) return;
    const n = nextRunAt(); if (n !== null && Date.now() >= n) runOnce({ reason: 'schedule' });
    paintLive();
  }, 5000);

  function paintLive() {
    const bar = $('#runbar'); if (!bar || !S) return;
    const t = triggerCard(); const n = nextRunAt();
    const active = live.activeCard && S.workflow.cards.find((c) => c.id === live.activeCard);
    const state = live.run ? `<span class="chip st-running">Running</span> ${active ? 'Now: <strong>' + esc(active.name) + '</strong>' : 'Starting…'}`
      : S.schedule.enabled ? `<span class="chip st-done">Schedule on</span> every ${t ? t.settings.scheduleMinutes : '?'} min · next ${n ? when(Math.max(n, Date.now())) : '—'}` : '<span class="chip st-idle">Paused</span>';
    bar.innerHTML = `${state}<span class="mute">${esc(live.msg)}</span><span style="flex:1"></span>
      <button id="rb-run" class="primary" ${live.run ? 'disabled' : ''}>Run once</button>${S.schedule.enabled ? '<button id="rb-pause">Pause</button>' : '<button id="rb-start">Start</button>'}`;
    $('#rb-run').onclick = () => runOnce(); const st = $('#rb-start'), pa = $('#rb-pause'); if (st) st.onclick = startSchedule; if (pa) pa.onclick = pauseSchedule;
    for (const el of $$('.node')) { const id = el.dataset.id; el.classList.toggle('running', live.activeCard === id); }
    for (const p of $$('path.wire')) { const e = S.workflow.connections.find((x) => x.id === p.dataset.edge); p.classList.toggle('active', !!(e && live.activeCard === e.to)); }
  }

  // ---------- rendering ----------
  let renderQueued = false;
  function render() {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const f = document.activeElement; const v = $('#view');
      // never redraw under the person's fingers: wait until they leave the field
      if (f && v.contains(f) && /INPUT|TEXTAREA|SELECT/.test(f.tagName)) { f.addEventListener('blur', render, { once: true }); paintLive(); return; }
      const y = window.scrollY;
      for (const b of $$('#tabs button')) b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
      v.innerHTML = ({ dashboard, markets, cards, journal, results })[tab]();
      labelStacks(v);
      bind[tab] && bind[tab]();
      window.scrollTo(0, y); paintLive();
    });
  }
  const bind = {};
  // phone tables show one row as a labelled list; copy each column heading onto its cells
  function labelStacks(root) {
    for (const t of root.querySelectorAll('table.stack')) {
      const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent);
      for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.l = heads[i]; });
    }
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; tab = b.dataset.tab; if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab); window.scrollTo(0, 0); render(); });
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (['dashboard', 'markets', 'cards', 'journal', 'results'].includes(h)) { tab = h; render(); } });

  function statusChip(st) { const label = { current: 'Current', delayed: 'Delayed', stale: 'Stale', unavailable: 'Unavailable', closed: 'Market closed' }[st] || st; return `<span class="chip st-${esc(st)}">${esc(label)}</span>`; }
  function assetName(id) { const a = S.watchlist.find((x) => x.id === id); return a ? a.symbol : id.split(':')[1]; }

  // ---------- Dashboard ----------
  function dashboard() {
    const m = C.computeMetrics(S); const v = C.valuation(S); const last = S.runs[S.runs.length - 1];
    const k = (l, val, c = '') => `<div class="panel kpi"><div class="l">${l}</div><div class="v ${c}">${val}</div></div>`;
    const rows = v.positions.map((p) => { const a = S.watchlist.find((x) => x.id === p.assetId) || C.makeAsset(p.assetId.split(':')[0], p.assetId.split(':')[1]);
      const st = C.classifyObservation(S.latest[p.assetId], a, Date.now(), S.settings);
      return `<tr><td>${esc(assetName(p.assetId))}</td><td class="n">${qtyf(p.qty)}</td><td class="n">${usd(p.avgCost)}</td><td class="n">${usd(p.price)} ${statusChip(st.status)}</td><td class="n">${usd(p.value)}</td><td class="n ${cls(p.unrealized)}">${signed(p.unrealized)}</td></tr>`; }).join('');
    const recent = S.journal.slice(-5).reverse().map(jitem).join('');
    return `<h1>${usd(m.equity)} <span class="small mute">simulated total value</span></h1>
      <p class="mute">${pct(m.totalReturnPct)} since ${when(S.account.createdAt)} on ${usd(S.account.startingCash, 0)} of virtual cash. Includes ${usd(m.fees + m.slippage)} of simulated fees and slippage.</p>
      <div class="grid">${k('Virtual cash', usd(m.cash))}${k('Current investments', usd(m.invested))}${k('Realized profit/loss', signed(m.realized), cls(m.realized))}${k('Unrealized profit/loss', signed(m.unrealized), cls(m.unrealized))}${k('Simulated fees', usd(m.fees))}${k('Simulated slippage', usd(m.slippage))}</div>
      ${v.missing.length ? `<div class="notice">No current price for ${v.missing.map(assetName).join(', ')}; those holdings are left out of the value until a price arrives.</div>` : ''}
      <div class="panel"><div class="row between"><h2>Performance over time</h2><span class="small mute">Forward paper trading, one point per run</span></div><div class="fig" id="eqfig"><svg id="eqsvg" role="img" aria-label="Simulated total value over time"></svg></div></div>
      <div class="two"><div class="panel"><h2>Current positions</h2>${rows ? `<div class="scroll"><table class="stack"><thead><tr><th>Asset</th><th class="n">Quantity</th><th class="n">Avg cost</th><th class="n">Price</th><th class="n">Value</th><th class="n">Unrealized</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="mute">No holdings. All value is virtual cash.</p>'}</div>
      <div class="panel"><h2>What the automation is doing</h2>
        <p>${S.schedule.enabled ? `Scheduled every ${triggerCard() ? triggerCard().settings.scheduleMinutes : '?'} minutes while this page is open.` : 'Paused. Press Run once or Start.'}</p>
        <p class="small">${last ? `Last run ${when(last.endedAt)}: <span class="chip st-${last.status}">${last.status}</span> strategy ${esc(last.strategyVersionId)}${last.errors.length ? ' — ' + esc(last.errors[0]) : ''}` : 'No runs yet.'}</p>
        <h3>Latest journal</h3>${recent || '<p class="mute">Nothing yet.</p>'}</div></div>`;
  }
  bind.dashboard = () => drawEquity();
  let eqObs = null;
  function drawEquity() {
    const svg = $('#eqsvg'); if (!svg) return;
    const draw = () => {
      const W = svg.clientWidth, H = svg.clientHeight; const pts = S.equityHistory.filter((p) => p.source === 'forward');
      const base = S.account.startingCash;
      if (pts.length < 2) { svg.innerHTML = `<text x="12" y="${H / 2}" fill="currentColor" opacity=".6" font-size="14">The line appears after two runs.</text>`; return; }
      const xs = pts.map((p) => p.t), ys = pts.map((p) => p.equity).concat(base);
      const x0 = Math.min(...xs), x1 = Math.max(...xs); let y0 = Math.min(...ys), y1 = Math.max(...ys); if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
      const L = 64, R = 10, T = 10, B = 24; const X = (t) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.equity).toFixed(1)).join('');
      const stale = pts.filter((p) => p.staleMarks).map((p) => `<circle cx="${X(p.t)}" cy="${Y(p.equity)}" r="3" fill="var(--amber)"><title>Some holdings had no current price</title></circle>`).join('');
      svg.innerHTML = `<line x1="${L}" x2="${W - R}" y1="${Y(base)}" y2="${Y(base)}" stroke="var(--line)" stroke-dasharray="4 4"/><text x="${L - 6}" y="${Y(base) + 4}" text-anchor="end" font-size="12" fill="currentColor" opacity=".7">${usd(base, 0)}</text>
        <text x="${L - 6}" y="${T + 10}" text-anchor="end" font-size="12" fill="currentColor" opacity=".7">${usd(y1, 0)}</text><text x="${L - 6}" y="${H - B}" text-anchor="end" font-size="12" fill="currentColor" opacity=".7">${usd(y0, 0)}</text>
        <path d="${d}" fill="none" stroke="var(--teal)" stroke-width="2.5"/>${stale}
        <text x="${L}" y="${H - 6}" font-size="12" fill="currentColor" opacity=".7">${when(x0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="12" fill="currentColor" opacity=".7">${when(x1)}</text>`;
    };
    if (eqObs) eqObs.disconnect(); eqObs = new ResizeObserver(draw); eqObs.observe(svg); draw();
  }

  // ---------- Markets ----------
  function markets() {
    const now = Date.now(); const ms = C.stockMarketStatus(now);
    const rows = S.watchlist.map((a) => { const o = S.latest[a.id]; const st = C.classifyObservation(o && o.price ? o : null, a, now, S.settings);
      const err = o && (o.lastError || o.error);
      return `<tr><td><strong>${esc(a.symbol)}</strong><br><span class="small mute">${esc(a.name)}</span></td><td>${a.kind === 'crypto' ? 'Crypto' : 'Stock'}</td><td class="n">${o && o.price ? usd(o.price, o.price < 1 ? 6 : 2) : '—'}</td>
      <td>${statusChip(st.status)}${st.note || err ? `<div class="small mute">${esc(st.note)}${err ? ' Last attempt: ' + esc(err) : ''}</div>` : ''}</td><td class="small">${esc(o && o.source || '—')}</td><td class="small">${o && o.marketTime ? when(o.marketTime) : '—'}</td><td class="small">${o && o.fetchedAt ? when(o.fetchedAt) : '—'}</td>
      <td><button class="danger" data-rm="${esc(a.id)}" aria-label="Remove ${esc(a.symbol)}">Remove</button></td></tr>`; }).join('');
    return `<h1>Markets</h1>
      <p>US stock market: <strong>${esc(ms.label)}</strong>.${esc(ms.note)} Crypto trades around the clock. Stock trades are only simulated during the regular session; extended hours are not modeled.</p>
      <div class="row"><button class="primary" id="mk-refresh">Refresh prices</button><span class="small mute">Uses ${S.watchlist.length} free requests. Status comes from the time each source reports for its price.</span></div>
      <div class="panel scroll" style="margin-top:12px"><table class="stack"><thead><tr><th>Asset</th><th>Type</th><th class="n">Price (USD)</th><th>Status</th><th>Source</th><th>Market time</th><th>Fetched</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8">Watchlist is empty.</td></tr>'}</tbody></table></div>
      <div class="panel"><h2>Add an asset</h2><form id="mk-add" class="fields"><div><label for="mk-kind">Type</label><select id="mk-kind"><option value="crypto">Crypto (Coinbase, USD pair)</option><option value="stock">US stock or ETF (Finnhub)</option></select></div>
        <div><label for="mk-sym">Symbol</label><input id="mk-sym" required maxlength="12" placeholder="e.g. LTC or NVDA" autocapitalize="characters"></div><div><label for="mk-name">Name (optional)</label><input id="mk-name" maxlength="40"></div>
        <div style="align-self:end"><button class="primary" type="submit">Add to watchlist</button></div></form>
        <p class="small mute">Status meanings: Current = price time within ${S.settings.currentWithinMinutes} min. Delayed = older but within the stale limit (${S.settings.cryptoStaleMinutes} min crypto, ${S.settings.stockStaleMinutes} min stocks). Stale = older than that; no new trades. Unavailable = no price; no new trades. Market closed = last stock price shown; no new stock trades.</p></div>`;
  }
  bind.markets = () => {
    $('#mk-refresh').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Refreshing…'; try { await data.refresh(S.watchlist); } finally { render(); } };
    $('#mk-add').onsubmit = (e) => { e.preventDefault(); try { const a = C.makeAsset($('#mk-kind').value, $('#mk-sym').value, $('#mk-name').value.trim() || undefined);
      if (S.watchlist.some((x) => x.id === a.id)) throw new Error(`${a.symbol} is already on the watchlist.`); $('#mk-sym').blur(); commit((s) => { s.watchlist.push(a); }); } catch (err) { info('Could not add', `<p>${esc(err.message)}</p>`); } };
    for (const b of $$('[data-rm]')) b.onclick = async () => { const id = b.dataset.rm; if (S.account.positions[id]) { info('Still held', `<p>The account holds ${esc(assetName(id))}. It stays on the watchlist so its value can be tracked.</p>`); return; }
      if (await confirmDanger('Remove asset?', `Remove ${esc(assetName(id))} from the watchlist? Its saved price history stays in backups.`, 'Remove')) commit((s) => { s.watchlist = s.watchlist.filter((x) => x.id !== id); }); };
  };

  // ---------- Cards ----------
  function lastStep(cardId) { for (let i = S.runs.length - 1; i >= 0; i--) { const st = S.runs[i].steps.find((x) => x.cardId === cardId); if (st) return { step: st, run: S.runs[i] }; } return null; }
  function stepFor(cardId) { const r = live.run || live.lastRun; if (r && r.test) { const st = r.steps.find((x) => x.cardId === cardId); if (st) return { step: st, run: r }; } return lastStep(cardId); }
  function layers(wf) {
    const val = C.validateWorkflow(wf); const depth = new Map(); const byId = new Map(wf.cards.map((c) => [c.id, c]));
    const trig = wf.cards.filter((c) => c.type === 'trigger');
    const q = trig.map((t) => { depth.set(t.id, 0); return t.id; });
    let guard = 0; while (q.length && guard++ < 1000) { const id = q.shift(); for (const e of wf.connections.filter((x) => x.from === id)) { const d = depth.get(id) + 1; if (!depth.has(e.to) || depth.get(e.to) < d) { if (d < wf.cards.length + 1) { depth.set(e.to, d); q.push(e.to); } } } }
    const rows = []; for (const c of wf.cards) { const d = depth.has(c.id) ? depth.get(c.id) : -1; if (d >= 0) (rows[d] = rows[d] || []).push(c); }
    const loose = wf.cards.filter((c) => !depth.has(c.id)); void byId;
    return { rows: rows.filter(Boolean), loose, val, depth };
  }
  function nodeHtml(c) {
    const ls = stepFor(c.id); const st = !c.enabled ? 'off' : live.activeCard === c.id ? 'running' : ls ? ls.step.status : 'idle';
    const t = C.CARD_TYPES[c.type]; const lastTxt = ls ? (ls.step.error || brief(c.type, ls.step.output)) : 'Not run yet.';
    return `<button class="node ${selCard === c.id ? 'sel' : ''} ${c.enabled ? '' : 'off'}" data-id="${esc(c.id)}" aria-pressed="${selCard === c.id}"><div class="nm">${esc(c.name)}</div>
      <div class="meta"><span class="chip st-${st}">${{ off: 'Off', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', idle: 'Ready' }[st] || esc(st)}</span><span class="chip">${c.mode === 'ai' ? 'AI Mode' : 'Rules Mode'}</span><span class="small mute">${esc(t.label)}</span></div>
      <div class="last">${esc(lastTxt)}</div></button>`;
  }
  function brief(type, o) {
    if (!o) return '';
    try {
      if (type === 'trigger') return `Started (${o.reason}).`;
      if (type === 'marketWatch') return `${o.assets.length} assets; ${o.missing.length} unavailable, ${o.stale.length} stale or closed.`;
      if (type === 'analyze') { const n = o.proposals.filter((p) => p.action !== 'hold'); return n.length ? n.map((p) => `${p.action} ${p.assetId.split(':')[1]}`).join(', ') : 'All hold.'; }
      if (type === 'challenge') { const b = o.verdicts.filter((v) => !v.agree); return b.length ? `Objected to ${b.map((v) => v.assetId.split(':')[1]).join(', ')}.` : 'No objections.'; }
      if (type === 'decision') return o.proposals.length ? o.proposals.map((p) => `${p.action} ${p.assetId.split(':')[1]}`).join(', ') : 'Hold everything.';
      if (type === 'rulesCheck') return `${o.approved.length} approved, ${o.rejected.length} rejected.`;
      if (type === 'ledger') return `${o.test ? 'Test: ' : ''}${o.fills.length} fill(s), ${o.rejected.length} rejected, ${o.holds.length} hold(s).`;
      if (type === 'outcomeReview') return o.reviews.length ? `${o.reviews.length} review(s), ${o.suggestions.length} suggestion(s).` : o.note;
    } catch (_) { /* fall through */ }
    return 'Done.';
  }
  function cards() {
    const L = layers(S.workflow); const v = L.val;
    const opts = S.workflow.cards.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const conns = S.workflow.connections.map((e) => { const f = S.workflow.cards.find((c) => c.id === e.from), t = S.workflow.cards.find((c) => c.id === e.to);
      return `<tr><td>${esc(f ? f.name : '?')}</td><td>→ ${esc(t ? t.name : '?')}</td><td class="n"><button data-inspect="${esc(e.id)}">Inspect</button> <button class="danger" data-disc="${esc(e.id)}">Disconnect</button></td></tr>`; }).join('');
    return `<h1>Automation cards</h1>
      <p class="mute">Information enters the Trigger and flows along each wire to the next card. This diagram is the exact order the app runs. Tap a card to edit it, or tap a wire to see what passed through it on the last run.</p>
      ${v.errors.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}${v.warnings.map((e) => `<div class="notice">${esc(e)}</div>`).join('')}
      ${v.ok ? '<div class="notice ok">Workflow check passed. Runs are allowed.</div>' : '<div class="notice err">Runs are blocked until these problems are fixed.</div>'}
      <div class="two"><div class="panel"><div class="board" id="board"><svg class="wires" id="wires" aria-hidden="false"></svg>
        ${L.rows.map((r) => `<div class="layer">${r.map(nodeHtml).join('')}</div>`).join('')}
        ${L.loose.length ? `<p class="small mute">Not connected to the trigger</p><div class="layer">${L.loose.map(nodeHtml).join('')}</div>` : ''}</div>
        <div class="row"><label for="add-type" class="small" style="margin:0">Add card</label><select id="add-type" style="width:auto">${Object.entries(C.CARD_TYPES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select><button id="add-card">Add</button></div></div>
      <div>${selEdge ? edgePanel() : ''}${selCard ? editor() : '<div class="panel"><p>Select a card to edit its instructions, settings and connections, or to test it.</p></div>'}
        <div class="panel"><h2>Connections</h2><p class="small mute">The easy way to wire cards on a phone. Loops and connections into the Trigger are refused.</p>
          <form id="conn-form" class="fields"><div><label for="c-from">From</label><select id="c-from">${opts}</select></div><div><label for="c-to">To</label><select id="c-to">${opts}</select></div><div style="align-self:end"><button class="primary" type="submit">Connect</button></div></form>
          <div class="scroll"><table><tbody>${conns || '<tr><td>No connections.</td></tr>'}</tbody></table></div></div></div></div>`;
  }
  function edgePanel() {
    const e = S.workflow.connections.find((x) => x.id === selEdge); if (!e) return '';
    const f = S.workflow.cards.find((c) => c.id === e.from), t = S.workflow.cards.find((c) => c.id === e.to);
    const r = live.lastRun && live.lastRun.edges && live.lastRun.edges[e.id] ? live.lastRun : [...S.runs].reverse().find((x) => x.edges && x.edges[e.id]);
    return `<div class="panel" id="edgepanel"><div class="row between"><h2>Wire: ${esc(f.name)} → ${esc(t.name)}</h2><button id="edge-close">Close</button></div>
      ${r ? `<p class="small mute">From ${r.test ? 'test ' : ''}run ${esc(r.id)} at ${when(r.startedAt)}, strategy ${esc(r.strategyVersionId)}.</p><pre>${esc(JSON.stringify(r.edges[e.id], null, 2))}</pre>` : '<p>Nothing has passed through this wire yet.</p>'}</div>`;
  }
  function editor() {
    const c = S.workflow.cards.find((x) => x.id === selCard); if (!c) return '';
    const t = C.CARD_TYPES[c.type]; const ls = stepFor(c.id);
    const fields = Object.entries(t.settings).map(([k, d]) => d.type === 'bool' ? `<label class="check"><input type="checkbox" data-set="${k}" ${c.settings[k] ? 'checked' : ''}> ${esc(d.label)}</label>`
      : `<div><label for="s-${k}">${esc(d.label)}</label><input id="s-${k}" data-set="${k}" ${d.type === 'number' ? `type="number" inputmode="decimal" min="${d.min}" max="${d.max}" step="${d.step}"` : 'type="text"'} value="${esc(c.settings[k])}"></div>`).join('');
    const hist = S.runs.filter((r) => r.steps.some((s) => s.cardId === c.id)).slice(-8).reverse().map((r) => { const s = r.steps.find((x) => x.cardId === c.id);
      return `<tr><td class="small">${when(s.startedAt)}</td><td><span class="chip st-${s.status}">${s.status}</span></td><td class="small">${esc(s.error || brief(c.type, s.output))}</td><td class="small mute">${esc(r.strategyVersionId)}</td></tr>`; }).join('');
    const aiNote = !t.aiCapable ? 'This card always runs fixed application code. Its instructions describe that code; editing them does not change the checks.'
      : ai.available ? `AI Mode is available with the local model ${esc(ai.model)}. In AI Mode the instructions below are sent to that model, and its answer is validated by code before use.`
        : 'AI Mode is unavailable: no local model is connected (see Results & Settings). This card runs in Rules Mode; the instructions are saved and versioned but not used by the rules.';
    return `<div class="panel" id="editor"><div class="row between"><h2>${esc(c.name)}</h2><span class="chip">${esc(t.label)}</span></div>
      <p class="small">${esc(t.purpose)}</p>
      <div class="fields"><div><label for="e-name">Name</label><input id="e-name" maxlength="60" value="${esc(c.name)}"></div>
        <div><label for="e-mode">Mode</label><select id="e-mode"><option value="rules" ${c.mode === 'rules' ? 'selected' : ''}>Rules Mode</option>${t.aiCapable ? `<option value="ai" ${c.mode === 'ai' ? 'selected' : ''} ${ai.available ? '' : 'disabled'}>AI Mode${ai.available ? '' : ' (unavailable)'}</option>` : ''}</select></div></div>
      <label class="check"><input type="checkbox" id="e-enabled" ${c.enabled ? 'checked' : ''}> Card is on</label>
      <label for="e-purpose">Purpose</label><input id="e-purpose" maxlength="200" value="${esc(c.purpose)}">
      <label for="e-prompt">Instructions</label><textarea id="e-prompt" maxlength="4000">${esc(c.prompt)}</textarea><p class="small mute">${aiNote}</p>
      <h3>Settings</h3><div class="fields">${fields}</div>
      <p class="small"><strong>Inputs:</strong> ${esc(t.inputs.join(', ') || 'none')} · <strong>Outputs:</strong> ${esc(t.outputs.join(', '))}${t.requires.length ? ` · <strong>Needs a wire from:</strong> ${esc(t.requires.map((r) => C.CARD_TYPES[r].label).join(', '))}` : ''}</p>
      <div class="row"><button class="primary" id="e-save">Save</button><button id="e-test">Test card</button><button id="e-dup">Duplicate</button><button class="danger" id="e-del">Remove</button></div>
      <p class="small mute">Test card runs this card and the cards feeding it with live data, without recording trades or journal entries.</p>
      <h3>Latest result</h3>${ls ? `<p class="small">${ls.run.test ? 'Test run' : 'Run'} ${esc(ls.run.id)} · ${when(ls.step.startedAt)} · <span class="chip st-${ls.step.status}">${ls.step.status}</span> ${esc(ls.step.error || '')}</p>
        <details><summary>Information received</summary><pre>${esc(JSON.stringify(ls.step.input, null, 2))}</pre></details><details><summary>Information passed on</summary><pre>${esc(JSON.stringify(ls.step.output, null, 2))}</pre></details>` : '<p class="mute">Not run yet.</p>'}
      <h3>History</h3>${hist ? `<div class="scroll"><table class="stack"><thead><tr><th>Time</th><th>Status</th><th>Result</th><th>Strategy</th></tr></thead><tbody>${hist}</tbody></table></div>` : '<p class="mute">No history.</p>'}</div>`;
  }
  bind.cards = () => {
    drawWires();
    for (const n of $$('.node')) n.onclick = () => { selCard = n.dataset.id; selEdge = null; render(); setTimeout(() => { const ed = $('#editor'); if (ed && innerWidth < 700) ed.scrollIntoView({ behavior: 'smooth' }); }, 60); };
    $('#add-card').onclick = () => { const c = C.makeCard($('#add-type').value); c.name = `${C.CARD_TYPES[c.type].label} (new)`; selCard = c.id; if (c.type === 'trigger') c.enabled = false;
      saveWorkflow((wf) => { wf.cards.push(c); }, `Added card ${c.name}`); };
    $('#conn-form').onsubmit = (e) => { e.preventDefault(); const from = $('#c-from').value, to = $('#c-to').value;
      const wf = C.clone(S.workflow); wf.connections.push({ id: C.uid('w'), from, to });
      const v = C.validateWorkflow(wf); const bad = v.errors.filter((x) => /Loop|itself|Duplicate|cannot receive|can only receive/.test(x));
      if (bad.length) { info('Connection refused', bad.map((x) => `<p>${esc(x)}</p>`).join('')); return; }
      saveWorkflow((w) => { w.connections = wf.connections; }, 'Connected cards'); };
    for (const b of $$('[data-disc]')) b.onclick = () => saveWorkflow((w) => { w.connections = w.connections.filter((x) => x.id !== b.dataset.disc); }, 'Disconnected cards');
    for (const b of $$('[data-inspect]')) b.onclick = () => { selEdge = b.dataset.inspect; render(); };
    const ec = $('#edge-close'); if (ec) ec.onclick = () => { selEdge = null; render(); };
    const c = S.workflow.cards.find((x) => x.id === selCard); if (!c) return;
    const read = () => { const n = C.clone(c); n.name = $('#e-name').value.trim() || c.name; n.purpose = $('#e-purpose').value; n.prompt = $('#e-prompt').value; n.mode = $('#e-mode').value; n.enabled = $('#e-enabled').checked;
      for (const el of $$('[data-set]')) { const d = C.CARD_TYPES[c.type].settings[el.dataset.set]; n.settings[el.dataset.set] = d.type === 'number' ? (el.value === '' ? NaN : Number(el.value)) : d.type === 'bool' ? el.checked : el.value; } return n; };
    $('#e-save').onclick = () => { const n = read(); const errs = C.validateCardSettings(n); if (errs.length) { info('Not saved', errs.map((x) => `<p>${esc(x)}</p>`).join('')); return; }
      document.activeElement.blur(); saveWorkflow((wf) => { wf.cards[wf.cards.findIndex((x) => x.id === c.id)] = n; }, `Edited ${n.name}`); };
    $('#e-test').onclick = async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Testing…'; const r = await engine.run({ reason: 'test', test: true, untilCardId: c.id }); if (r && r.skipped) info('Not started', `<p>${esc(r.message)}</p>`); render(); };
    $('#e-dup').onclick = () => { const d = C.clone(c); d.id = C.uid('card'); d.name = c.name + ' (copy)'; if (d.type === 'trigger') d.enabled = false; selCard = d.id; saveWorkflow((wf) => { wf.cards.push(d); }, `Duplicated ${c.name}`); };
    $('#e-del').onclick = async () => { if (await confirmDanger('Remove card?', `Remove "${esc(c.name)}" and its wires? Earlier strategy versions keep a copy.`, 'Remove')) { selCard = null; saveWorkflow((wf) => { wf.cards = wf.cards.filter((x) => x.id !== c.id); wf.connections = wf.connections.filter((e) => e.from !== c.id && e.to !== c.id); }, `Removed ${c.name}`); } };
  };
  function saveWorkflow(mut, note) {
    if (engine.isRunning()) { info('Run in progress', '<p>Wait for the current run to finish before changing the workflow.</p>'); return; }
    return commit((s) => { mut(s.workflow); C.ensureStrategyVersion(s, note); });
  }
  let wireObs = null;
  function drawWires() {
    const board = $('#board'), svg = $('#wires'); if (!board) return;
    const draw = () => {
      const b = board.getBoundingClientRect(); const L = layers(S.workflow); let html = '';
      const lr = live.lastRun || S.runs[S.runs.length - 1];
      for (const e of S.workflow.connections) {
        const f = board.querySelector(`.node[data-id="${CSS.escape(e.from)}"]`), t = board.querySelector(`.node[data-id="${CSS.escape(e.to)}"]`); if (!f || !t) continue;
        const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect(); let d;
        const skip = (L.depth.get(e.to) ?? 0) - (L.depth.get(e.from) ?? 0) > 1 && Math.abs((fr.left + fr.right) / 2 - (tr.left + tr.right) / 2) < 40;
        if (skip) { const x1 = fr.right - b.left, y1 = fr.top + fr.height * 0.7 - b.top, x2 = tr.right - b.left, y2 = tr.top + tr.height * 0.3 - b.top; const off = Math.min(26, b.right - Math.max(fr.right, tr.right) - 2); d = `M${x1} ${y1} C${x1 + off + 30} ${y1} ${x2 + off + 30} ${y2} ${x2} ${y2}`; }
        else { const x1 = (fr.left + fr.right) / 2 - b.left, y1 = fr.bottom - b.top, x2 = (tr.left + tr.right) / 2 - b.left, y2 = tr.top - b.top; const k = Math.max(16, (y2 - y1) / 2); d = `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`; }
        const used = lr && lr.edges && lr.edges[e.id];
        html += `<path class="wire ${used ? 'live' : ''} ${selEdge === e.id ? 'sel' : ''}" data-edge="${esc(e.id)}" d="${d}" marker-end="url(#arr)"/><path class="hit" data-edge="${esc(e.id)}" d="${d}" tabindex="0" role="button" aria-label="Inspect wire"><title>Tap to inspect</title></path>`;
      }
      svg.innerHTML = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--mute)"/></marker></defs>${html}`;
      for (const p of $$('path.hit', svg)) { const go = () => { selEdge = p.dataset.edge; selCard = null; render(); setTimeout(() => { const ep = $('#edgepanel'); if (ep && innerWidth < 700) ep.scrollIntoView({ behavior: 'smooth' }); }, 60); }; p.addEventListener('click', go); p.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') go(); }); }
      paintLive();
    };
    if (wireObs) wireObs.disconnect(); wireObs = new ResizeObserver(draw); wireObs.observe(board); draw();
  }

  // ---------- Journal ----------
  const KIND = { buy: 'Simulated buy', sell: 'Simulated sell', hold: 'Hold', rejected: 'Rejected', failed: 'Failed run', review: 'Outcome review', note: 'Note' };
  function jitem(j) { return `<div class="jitem"><div class="h"><span class="chip k-${esc(j.kind)}">${KIND[j.kind] || esc(j.kind)}</span>${j.assetId ? `<strong>${esc(assetName(j.assetId))}</strong>` : ''}<span>${when(j.t)}</span>${j.strategyVersionId ? `<span>strategy ${esc(j.strategyVersionId)}</span>` : ''}${j.runId ? `<span>run …${esc(j.runId.slice(-6))}</span>` : ''}</div><div>${esc(j.text)}</div></div>`; }
  function journal() {
    const groups = { all: () => true, trades: (j) => j.kind === 'buy' || j.kind === 'sell', hold: (j) => j.kind === 'hold', rejected: (j) => j.kind === 'rejected', failed: (j) => j.kind === 'failed', review: (j) => j.kind === 'review' };
    const items = S.journal.filter(groups[journalFilter]).slice().reverse();
    return `<h1>Trade journal</h1><p class="mute">Every simulated purchase and sale, every hold, rejected proposal, failed run and review, with the reason in plain language.</p>
      <div class="row">${[['all', 'All'], ['trades', 'Trades'], ['hold', 'Holds'], ['rejected', 'Rejected'], ['failed', 'Failed runs'], ['review', 'Reviews']].map(([k, l]) => `<button data-jf="${k}" class="${journalFilter === k ? 'primary' : ''}">${l}</button>`).join('')}<span style="flex:1"></span><button id="j-csv">Export trades CSV</button></div>
      <div class="panel" style="margin-top:12px">${items.slice(0, journalLimit).map(jitem).join('') || '<p class="mute">No entries yet.</p>'}${items.length > journalLimit ? '<button id="j-more">Show more</button>' : ''}</div>`;
  }
  bind.journal = () => {
    for (const b of $$('[data-jf]')) b.onclick = () => { journalFilter = b.dataset.jf; journalLimit = 150; render(); };
    const m = $('#j-more'); if (m) m.onclick = () => { journalLimit += 150; render(); };
    $('#j-csv').onclick = () => download(`paper-trades-${new Date().toISOString().slice(0, 10)}.csv`, C.fillsToCsv(S.fills), 'text/csv');
  };
  function download(name, text, type) {
    const blob = new Blob([text], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Results & Settings ----------
  function results() {
    const m = C.computeMetrics(S); const s = S.settings; const ds = data.status;
    const sug = S.suggestions.filter((g) => g.status === 'pending').map((g) => { const c = S.workflow.cards.find((x) => x.id === g.cardId);
      return `<div class="jitem"><p><strong>${esc(c ? c.name : 'Card')}:</strong> change "${esc(C.CARD_TYPES[c ? c.type : 'analyze'].settings[g.setting].label)}" from ${esc(g.from)} to ${esc(g.to)}.</p><p class="small">${esc(g.why)}</p><div class="row"><button class="primary" data-acc="${esc(g.id)}">Accept (new strategy version)</button><button data-rej="${esc(g.id)}">Reject</button></div></div>`; }).join('');
    const decided = S.suggestions.filter((g) => g.status !== 'pending').slice(-5).reverse().map((g) => `<li class="small">${esc(g.status)}: ${esc(g.setting)} ${esc(g.from)} → ${esc(g.to)} (${when(g.decidedAt)})</li>`).join('');
    const versions = S.strategyVersions.slice().reverse().slice(0, 30).map((v) => `<tr><td>${esc(v.id)}</td><td class="small">${when(v.createdAt)}</td><td class="small">${esc(v.note)}</td><td class="n">${v === C.currentStrategyVersion(S) ? '<span class="chip st-done">Active</span>' : `<button data-restore="${esc(v.id)}">Use again</button>`}</td></tr>`).join('');
    const runs = S.runs.slice().reverse().slice(0, 15).map((r) => `<tr><td class="small">${esc(r.id)}</td><td class="small">${when(r.startedAt)} → ${when(r.endedAt)}</td><td>${esc(r.reason)}</td><td><span class="chip st-${r.status}">${r.status}</span></td><td>${esc(r.strategyVersionId)}</td></tr>`).join('');
    const prov = (k) => { const p = PTData.PROVIDERS[k], st = ds[k]; return `<tr><td><strong>${esc(p.name)}</strong><div class="small mute">${esc(p.limitText)} <a href="${p.docs}" target="_blank" rel="noopener">Limits page</a></div></td><td>${st.ok === null ? '<span class="chip st-idle">Not used yet</span>' : st.ok ? '<span class="chip st-current">Working</span>' : '<span class="chip st-unavailable">Failing</span>'}<div class="small mute">${st.lastOkAt ? 'Last success ' + when(st.lastOkAt) : ''} ${st.lastError && !st.ok ? esc(st.lastError) : ''}</div></td></tr>`; };
    const row = (l, v, d) => `<tr><td>${l}</td><td class="n">${v}</td><td class="small mute">${d}</td></tr>`;
    return `<h1>Results &amp; settings</h1>
      <div class="panel"><h2>Performance</h2><p class="small mute">Forward paper trading only, measured from ${when(m.periodStart)} to ${when(m.periodEnd)}. Historical replay is not included in this version, so every number below comes from live runs. All figures include simulated fees and slippage.</p>
      <div class="scroll"><table><thead><tr><th>Measure</th><th class="n">Value</th><th>How it is calculated</th></tr></thead><tbody>
      ${row('Total return', `<span class="${cls(m.totalPnl)}">${pct(m.totalReturnPct)} (${signed(m.totalPnl)})</span>`, 'Simulated total value ÷ starting virtual cash − 1. Total value = cash + holdings at their latest price.')}
      ${row('Realized result', signed(m.realized), 'Sum over sales of (quantity × fill price − sale fee) − average cost of the quantity sold. Buy fees are part of the cost.')}
      ${row('Unrealized result', signed(m.unrealized), 'Holdings at the latest price − their remaining cost.')}
      ${row('Maximum drawdown', m.maxDrawdownPct.toFixed(2) + '%', 'Largest drop from a previous high in total value, using one value point per run.')}
      ${row('Completed trades', m.completedTrades, 'Number of simulated sales (each sale closes all or part of a position).')}
      ${row('Win rate', m.winRatePct === null ? '—' : m.winRatePct.toFixed(1) + '%', 'Sales with a positive realized result ÷ all sales.')}
      ${row('Simulated costs', usd(m.fees + m.slippage), `Fees ${usd(m.fees)} + slippage ${usd(m.slippage)} (difference between quote and fill price × quantity).`)}
      ${row('Runs', `${m.runs} (${m.failedRuns} failed)`, `${m.runsWithMissingData} run(s) had stale, closed or unavailable data for at least one asset.`)}
      </tbody></table></div>${m.missingMarks.length ? `<div class="notice">Missing prices for ${esc(m.missingMarks.map(assetName).join(', '))}: those holdings are left out of value and return.</div>` : ''}
      <p class="small mute">Not modeled: stock splits, dividends and other corporate actions; crypto network fees; order book depth; taxes. A split in a held stock would make its value wrong until you reset or adjust.</p></div>
      <div class="panel"><h2>Suggested strategy changes</h2>${sug || '<p class="mute">None waiting. The Outcome Review card suggests changes after enough reviewed decisions. Nothing changes unless you accept.</p>'}${decided ? `<ul>${decided}</ul>` : ''}</div>
      <div class="panel"><h2>Strategy versions</h2><p class="small mute">A new version is saved whenever a card, instruction, setting or wire changes. Every run and journal entry records its version.</p><div class="scroll"><table class="stack"><thead><tr><th>Version</th><th>Saved</th><th>Change</th><th></th></tr></thead><tbody>${versions}</tbody></table></div></div>
      <div class="panel"><h2>Recent runs</h2><div class="scroll"><table class="stack"><thead><tr><th>Run ID</th><th>Time</th><th>Reason</th><th>Status</th><th>Strategy</th></tr></thead><tbody>${runs || '<tr><td>No runs yet.</td></tr>'}</tbody></table></div></div>
      <div class="two"><div class="panel"><h2>Account</h2><label for="st-cash">Starting virtual cash ($)</label><input id="st-cash" type="number" inputmode="decimal" min="1" step="100" value="${S.account.startingCash}">
        <div class="row" style="margin-top:8px"><button class="danger" id="st-reset">Reset account with this amount</button></div><p class="small mute">Resetting clears cash, holdings, fills, journal and runs. Cards, watchlist and strategy versions stay. Export a backup first if you want to keep the history.</p></div>
      <div class="panel"><h2>Simulated costs and data freshness</h2><form id="st-form" class="fields">
        ${[['feePct', 'Fee per trade (%)', 0.01], ['feeFlatUsd', 'Flat fee per trade ($)', 0.01], ['slippagePct', 'Slippage against you (%)', 0.01], ['currentWithinMinutes', 'Current if price is younger than (min)', 0.5], ['cryptoStaleMinutes', 'Crypto stale after (min)', 1], ['stockStaleMinutes', 'Stock stale after (min)', 1]].map(([k, l, st]) => `<div><label for="st-${k}">${l}</label><input id="st-${k}" data-k="${k}" type="number" inputmode="decimal" min="0" step="${st}" value="${s[k]}"></div>`).join('')}
        <div style="align-self:end"><button class="primary" type="submit">Save</button></div></form></div></div>
      <div class="panel"><h2>Data connections</h2><div class="scroll"><table class="stack"><thead><tr><th>Source</th><th>Status</th></tr></thead><tbody>${prov('coinbase')}${prov('coingecko')}${prov('finnhub')}</tbody></table></div>
        <form id="fh-form" class="fields"><div><label for="fh-key">Your free Finnhub key (for stock prices)</label><input id="fh-key" type="password" autocomplete="off" value="${esc(s.finnhubKey)}" placeholder="Paste key from finnhub.io"></div>
        <label class="check"><input type="checkbox" id="fh-inc" ${s.includeKeyInBackup ? 'checked' : ''}> Include the key in backups</label><div style="align-self:end"><button class="primary" type="submit">Save key</button></div></form>
        <p class="small mute">The key is your own, stays in this browser's storage, is sent only to Finnhub, and is never put in a prompt. It is not in the app's source code. Finnhub's free sign-up needs an email, not a card. Without it, stocks show as unavailable and are never traded.</p></div>
      <div class="panel"><h2>AI Mode</h2><p><strong>Status:</strong> ${ai.available ? `<span class="chip st-current">Available</span> local model ${esc(ai.model)}` : `<span class="chip st-unavailable">Unavailable</span> ${esc(ai.lastError)}`}</p>
        <p class="small">All cards currently run in <strong>Rules Mode</strong> unless you switch Analyze or Challenge to AI Mode. Rules Mode is fixed code (moving averages and limits); its explanations are generated from numbers, not by AI. AI Mode needs a free local model through <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> running on a computer you already have. It cannot run on the phone browser.</p>
        <form id="ai-form" class="fields"><div><label for="ai-ep">Ollama address</label><input id="ai-ep" value="${esc(s.aiEndpoint)}"></div><div><label for="ai-model">Model</label><input id="ai-model" value="${esc(s.aiModel)}"></div><div style="align-self:end"><button class="primary" type="submit">Save and test connection</button></div></form></div>
      <div class="panel"><h2>Backup and restore</h2><div class="row"><button class="primary" id="bk-export">Export full backup (JSON)</button><button id="bk-csv">Export trades (CSV)</button><label class="btn" for="bk-file" style="display:inline-flex;align-items:center;margin:0;color:var(--ink);font-size:15px;font-weight:600">Import backup…</label><input id="bk-file" type="file" accept="application/json,.json" hidden></div>
        <div id="bk-msg"></div><p class="small mute">Imports are fully checked first (structure, workflow, and that cash and holdings match the recorded fills). Nothing is replaced until you confirm. Restoring pauses the schedule.</p></div>
      <div class="panel"><h2>Storage and background running</h2><p id="storage-info" class="small">Saved in this browser with ${esc(PTStore.backend)}${PTStore.persisted ? ' (marked persistent)' : PTStore.persisted === false ? ' (the browser may clear it under storage pressure)' : ''}.</p>
        <ul class="small"><li>Data lives only in this browser on this device. There is no cloud sync. Clearing site data, private mode or uninstalling the browser deletes it. Use backups.</li>
        <li>Automation runs only while this page is open. Browsers slow or stop timers in background tabs, and a sleeping or locked phone stops them. A missed schedule runs at the next check after the page wakes; prices are never back-filled.</li>
        <li>For steadier running, keep the page open on a computer you already have, plugged in, with sleep turned off. No paid server is needed or used.</li></ul></div>`;
  }
  bind.results = () => {
    for (const b of $$('[data-acc]')) b.onclick = () => commit((s) => { C.acceptSuggestion(s, b.dataset.acc); });
    for (const b of $$('[data-rej]')) b.onclick = () => commit((s) => { C.rejectSuggestion(s, b.dataset.rej); });
    for (const b of $$('[data-restore]')) b.onclick = async () => { const v = S.strategyVersions.find((x) => x.id === b.dataset.restore); if (await confirmDanger('Use this version again?', `The cards and wires from ${esc(v.id)} become active as a new version. Nothing is deleted.`, 'Use again')) saveWorkflow((wf) => { wf.cards = C.clone(v.workflow.cards); wf.connections = C.clone(v.workflow.connections); }, `Restored ${v.id}`); };
    $('#st-reset').onclick = async () => { const amt = Number($('#st-cash').value); if (!(amt >= 1 && amt <= 1e9)) { info('Check the amount', '<p>Enter an amount from $1 to $1,000,000,000.</p>'); return; }
      if (engine.isRunning()) { info('Run in progress', '<p>Wait for the run to finish.</p>'); return; }
      if (await confirmDanger('Reset the virtual account?', `This clears cash, holdings, fills, journal and run history, and starts again with ${usd(amt)} of virtual cash. This cannot be undone unless you have a backup.`, 'Reset account')) commit((s) => C.resetAccount(s, amt)); };
    $('#st-form').onsubmit = (e) => { e.preventDefault(); const vals = {}; for (const el of $$('[data-k]')) { const v = Number(el.value); if (!(v >= 0) || v > 1000) { info('Not saved', `<p>${esc(el.previousElementSibling.textContent)} must be 0 or more.</p>`); return; } vals[el.dataset.k] = v; }
      if (vals.currentWithinMinutes > vals.cryptoStaleMinutes || vals.currentWithinMinutes > vals.stockStaleMinutes) { info('Not saved', '<p>"Current" must be shorter than the stale limits.</p>'); return; }
      document.activeElement.blur(); commit((s) => Object.assign(s.settings, vals)); };
    $('#fh-form').onsubmit = (e) => { e.preventDefault(); const k = $('#fh-key').value.trim(); if (k && !/^[A-Za-z0-9_\-]{8,80}$/.test(k)) { info('Not saved', '<p>That does not look like a Finnhub key.</p>'); return; } document.activeElement.blur(); commit((s) => { s.settings.finnhubKey = k; s.settings.includeKeyInBackup = $('#fh-inc').checked; }); };
    $('#ai-form').onsubmit = async (e) => { e.preventDefault(); const ep = $('#ai-ep').value.trim(), md = $('#ai-model').value.trim(); if (!/^https?:\/\/[^\s]+$/.test(ep) || !md) { info('Not saved', '<p>Enter an address like http://localhost:11434 and a model name.</p>'); return; }
      document.activeElement.blur(); await commit((s) => { s.settings.aiEndpoint = ep; s.settings.aiModel = md; }); await ai.test();
      if (!ai.available) await commit((s) => { for (const c of s.workflow.cards) if (c.mode === 'ai') c.mode = 'rules'; C.ensureStrategyVersion(s, 'AI unavailable: cards set to Rules Mode'); });
      render(); };
    $('#bk-export').onclick = () => download(`paper-trader-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`, JSON.stringify(C.exportBackup(S), null, 1), 'application/json');
    $('#bk-csv').onclick = () => download(`paper-trades-${new Date().toISOString().slice(0, 10)}.csv`, C.fillsToCsv(S.fills), 'text/csv');
    $('#bk-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const msg = $('#bk-msg');
      if (f.size > 50e6) { msg.innerHTML = '<div class="notice err">File is larger than 50 MB.</div>'; return; }
      let obj; try { obj = JSON.parse(await f.text()); } catch (_) { msg.innerHTML = '<div class="notice err">Not valid JSON. Nothing was changed.</div>'; return; }
      const v = C.validateBackup(obj); e.target.value = '';
      if (!v.ok) { msg.innerHTML = `<div class="notice err"><strong>Backup refused. Nothing was changed.</strong>${v.errors.slice(0, 12).map((x) => `<br>${esc(x)}`).join('')}</div>`; return; }
      const sm = v.summary; pendingImport = obj;
      const go = await confirmDanger('Replace all data with this backup?', `Backup from ${esc(sm.exportedAt)}: ${usd(sm.cash)} virtual cash, ${sm.positions} holding(s), ${sm.fills} fill(s), ${sm.journal} journal entries, ${sm.cards} cards, ${sm.versions} strategy versions, ${sm.watchlist} assets. Everything currently in this browser will be replaced.`, 'Replace data');
      if (!go) { pendingImport = null; msg.innerHTML = '<div class="notice">Import cancelled. Nothing was changed.</div>'; return; }
      if (engine.isRunning()) { info('Run in progress', '<p>Try again after the run.</p>'); return; }
      const restored = C.restoreFromBackup(pendingImport, S.settings); pendingImport = null;
      await commit((s) => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, restored); });
      msg.innerHTML = '<div class="notice ok">Backup restored. The schedule is paused.</div>'; };
  };

  // ---------- start ----------
  (async function boot() {
    let loaded = null; try { loaded = await PTStore.load(); } catch (_) { loaded = null; }
    S = loaded && loaded.app === C.APP_ID ? loaded : C.createInitialState();
    S.settings = Object.assign(C.defaultSettings(), S.settings);
    if (!loaded) { try { await PTStore.save(S); } catch (_) { /* shown in settings */ } }
    PTStore.requestPersist().then(render);
    const h = location.hash.slice(1); if (['dashboard', 'markets', 'cards', 'journal', 'results'].includes(h)) tab = h;
    render();
    // AI is tested only on request (or if a card was left in AI Mode), so the page never probes your network unasked
    if (S.workflow.cards.some((c) => c.mode === 'ai')) ai.test().then(render);
    if (!Object.keys(S.latest).length) data.refresh(S.watchlist).catch(() => {}).then(render);
  })();
  window.__pt = { get state() { return S; }, engine, data, ai, commit };
})();

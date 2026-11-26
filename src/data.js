/* Market data connections. Free, keyless where possible. Never fabricates a price:
 * a failed request becomes an "unavailable" observation with the error text. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.PTData = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Limits checked Nov 2026 from each provider's documentation. We stay well under them.
  const PROVIDERS = {
    coinbase: { name: 'Coinbase Exchange public API', perMinute: 120, docs: 'https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits', limitText: 'Public endpoints: 10 requests/second per IP. No key needed.' },
    coingecko: { name: 'CoinGecko keyless public API', perMinute: 4, docs: 'https://docs.coingecko.com/docs/keyless-public-api', limitText: 'About 5 calls/minute, shared per IP, varies with load. Used only as a backup for crypto. Data provided by CoinGecko.' },
    finnhub: { name: 'Finnhub free plan', perMinute: 50, docs: 'https://finnhub.io/pricing', limitText: 'Free plan, 60 calls/minute, needs your own free key (email sign-up). The app measures how old each price is instead of assuming real time.' },
  };

  function createDataLayer(opts) {
    // opts: { fetch, now, getState, commit(mutator), timeoutMs }
    const now = opts.now || (() => Date.now());
    const doFetch = opts.fetch;
    const status = {}; for (const k of Object.keys(PROVIDERS)) status[k] = { ok: null, lastOkAt: null, lastError: null, lastErrorAt: null, calls: [], backoffUntil: 0 };

    async function call(provider, url) {
      const st = status[provider]; const t = now();
      st.calls = st.calls.filter((x) => t - x < 60000);
      if (t < st.backoffUntil) throw new Error(`${PROVIDERS[provider].name} asked us to slow down; waiting until ${new Date(st.backoffUntil).toLocaleTimeString()}.`);
      if (st.calls.length >= PROVIDERS[provider].perMinute) throw new Error(`Free limit guard: ${PROVIDERS[provider].name} already used ${st.calls.length} calls this minute.`);
      st.calls.push(t);
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 10000) : null;
      try {
        const r = await doFetch(url, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
        if (r.status === 429) { st.backoffUntil = now() + 120000; throw new Error(`${PROVIDERS[provider].name} rate limit reached (HTTP 429). Pausing this source for 2 minutes.`); }
        if (r.status === 401 || r.status === 403) throw new Error(`${PROVIDERS[provider].name} refused the request (HTTP ${r.status}). Check the key in Settings.`);
        if (!r.ok) throw new Error(`${PROVIDERS[provider].name} returned HTTP ${r.status}.`);
        const j = await r.json(); st.ok = true; st.lastOkAt = now(); return j;
      } catch (e) {
        const msg = e && e.name === 'AbortError' ? `${PROVIDERS[provider].name} did not answer within 10 seconds.` : (e && e.message) || String(e);
        st.ok = false; st.lastError = /Failed to fetch|NetworkError|Load failed/i.test(msg) ? `${PROVIDERS[provider].name}: network error or blocked by the browser (offline, ad blocker, or CORS).` : msg; st.lastErrorAt = now();
        throw new Error(st.lastError);
      } finally { if (timer) clearTimeout(timer); }
    }

    async function coinbaseTicker(asset) {
      const j = await call('coinbase', `https://api.exchange.coinbase.com/products/${encodeURIComponent(asset.coinbaseProduct)}/ticker`);
      const price = parseFloat(j.price); const mt = Date.parse(j.time);
      if (!(price > 0) || !Number.isFinite(mt)) throw new Error(`Coinbase gave no usable price for ${asset.symbol}.`);
      return { assetId: asset.id, price, marketTime: mt, fetchedAt: now(), source: 'Coinbase', kind: 'quote' };
    }
    async function coinbaseHistory(asset) {
      const j = await call('coinbase', `https://api.exchange.coinbase.com/products/${encodeURIComponent(asset.coinbaseProduct)}/candles?granularity=3600`);
      if (!Array.isArray(j)) throw new Error('Coinbase candles were not a list.');
      // [time, low, high, open, close, volume]; newest first. Close of an hourly candle is known at time+1h.
      const t = now();
      return j.filter((c) => Array.isArray(c) && c[4] > 0).map((c) => ({ assetId: asset.id, price: +c[4], marketTime: (c[0] + 3600) * 1000, fetchedAt: t, source: 'Coinbase hourly candle', kind: 'candle' }))
        .filter((o) => o.marketTime <= t).sort((a, b) => a.marketTime - b.marketTime);
    }
    async function coingeckoMany(assets) {
      const ids = assets.map((a) => a.coingeckoId).filter(Boolean); if (!ids.length) return {};
      const j = await call('coingecko', `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_last_updated_at=true`);
      const out = {}; const t = now();
      for (const a of assets) { const r = a.coingeckoId && j[a.coingeckoId]; if (r && r.usd > 0 && r.last_updated_at) out[a.id] = { assetId: a.id, price: +r.usd, marketTime: r.last_updated_at * 1000, fetchedAt: t, source: 'CoinGecko', kind: 'quote' }; }
      return out;
    }
    async function finnhubQuote(asset) {
      const key = opts.getState().settings.finnhubKey;
      if (!key) throw new Error('Stock prices need a free Finnhub key. Add one in Results & Settings → Data connections.');
      const j = await call('finnhub', `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(asset.symbol)}&token=${encodeURIComponent(key)}`);
      if (!j || !(j.c > 0) || !(j.t > 0)) throw new Error(`Finnhub has no price for ${asset.symbol} (unknown symbol or not covered on the free plan).`);
      const t = now();
      return { quote: { assetId: asset.id, price: +j.c, marketTime: j.t * 1000, fetchedAt: t, source: 'Finnhub', kind: 'quote' }, prevClose: j.pc > 0 ? +j.pc : null };
    }

    async function quote(asset) {
      if (asset.kind === 'crypto') {
        try { return await coinbaseTicker(asset); }
        catch (e1) {
          if (!asset.coingeckoId) throw e1;
          try { const m = await coingeckoMany([asset]); if (m[asset.id]) return m[asset.id]; throw new Error(`CoinGecko had no price for ${asset.symbol}.`); }
          catch (e2) { throw new Error(`${e1.message} Backup source: ${e2.message}`); }
        }
      }
      return (await finnhubQuote(asset)).quote;
    }

    // Fetch quotes for assets; seed crypto history from hourly candles once an hour.
    async function refresh(assets) {
      const results = {}; const newObs = []; const t = now(); const state = opts.getState();
      const cryptoNeedingCb = []; const errors = {};
      for (const a of assets) {
        try {
          if (a.kind === 'crypto') {
            const hist = state.observations[a.id] || [];
            const lastSeed = state.historySeededAt && state.historySeededAt[a.id];
            if (!lastSeed || t - lastSeed > 3600000 || hist.length < 5) { try { newObs.push(...(await coinbaseHistory(a))); (state.historySeededAt = state.historySeededAt || {})[a.id] = t; } catch (_) { /* history is optional */ } }
            try { results[a.id] = await coinbaseTicker(a); } catch (e) { cryptoNeedingCb.push(a); errors[a.id] = e.message; }
          } else {
            const r = await finnhubQuote(a); results[a.id] = r.quote;
          }
        } catch (e) { errors[a.id] = e.message; }
      }
      if (cryptoNeedingCb.length) {
        try { const m = await coingeckoMany(cryptoNeedingCb); for (const a of cryptoNeedingCb) if (m[a.id]) { results[a.id] = m[a.id]; delete errors[a.id]; } else errors[a.id] += ' Backup CoinGecko had no price.'; }
        catch (e) { for (const a of cryptoNeedingCb) errors[a.id] += ` Backup source: ${e.message}`; }
      }
      for (const a of assets) if (!results[a.id]) results[a.id] = { assetId: a.id, price: null, marketTime: null, fetchedAt: t, source: null, error: errors[a.id] || 'No data.' };
      await opts.commit((s) => {
        for (const o of newObs) addObservation(s, o);
        for (const a of assets) { const o = results[a.id]; if (o.price) addObservation(s, o); else s.latest[a.id] = s.latest[a.id] && s.latest[a.id].price ? Object.assign({}, s.latest[a.id], { lastError: o.error, lastErrorAt: t }) : o; }
        s.historySeededAt = Object.assign({}, s.historySeededAt || {}, state.historySeededAt || {});
        s.dataLog.push({ t, ok: Object.values(results).filter((o) => o.price).length, failed: Object.values(results).filter((o) => !o.price).map((o) => ({ assetId: o.assetId, error: o.error })) });
        if (s.dataLog.length > 200) s.dataLog.splice(0, s.dataLog.length - 200);
      });
      // a fresh failure must show as unavailable to the run, even if an old price is kept for display
      return results;
    }
    function addObservation(s, o) {
      const list = (s.observations[o.assetId] = s.observations[o.assetId] || []);
      if (!list.some((x) => x.marketTime === o.marketTime && x.source === o.source)) {
        list.push({ price: o.price, marketTime: o.marketTime, fetchedAt: o.fetchedAt, source: o.source, kind: o.kind });
        list.sort((a, b) => a.marketTime - b.marketTime);
        const cap = s.settings.historyPerAsset || 400; if (list.length > cap) list.splice(0, list.length - cap);
      }
      const cur = s.latest[o.assetId];
      if (o.kind === 'quote' || !cur || !cur.price || cur.marketTime < o.marketTime) { if (!cur || !cur.marketTime || o.marketTime >= cur.marketTime || o.kind === 'quote') s.latest[o.assetId] = { assetId: o.assetId, price: o.price, marketTime: o.marketTime, fetchedAt: o.fetchedAt, source: o.source, kind: o.kind }; }
    }
    async function fillQuote(asset) {
      const q = await quote(asset);
      await opts.commit((s) => addObservation(s, q));
      return q;
    }
    return { refresh, fillQuote, quote, status, PROVIDERS };
  }
  return { createDataLayer, PROVIDERS };
});

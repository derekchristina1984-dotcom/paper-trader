/* Optional local AI through Ollama (free, open source, runs on your own computer).
 * AI Mode is "available" only after a real connection test succeeds. Prompt text is sent
 * to the model as text; it is never run as program code. No keys or secrets are sent. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.PTAI = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SYSTEM = 'You are one step in a paper-trading practice app. No real money is involved. Use only the facts in the DATA block. Never invent prices, news, balances or events. If information is missing, say so and choose hold. Reply with a single JSON object only, matching the REQUIRED OUTPUT shape exactly. Do not include prices, quantities or order sizes in your output; the app computes those.';

  function createAI(opts) {
    // opts: { fetch, getSettings }
    const ai = { available: false, model: null, lastCheck: null, lastError: 'Not tested yet.', models: [] };
    ai.test = async function () {
      const s = opts.getSettings(); ai.lastCheck = Date.now();
      try {
        const r = await opts.fetch(s.aiEndpoint.replace(/\/$/, '') + '/api/tags');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json(); ai.models = (j.models || []).map((m) => m.name);
        if (!ai.models.length) throw new Error('Ollama is running but has no models. Run: ollama pull ' + s.aiModel);
        if (!ai.models.some((m) => m === s.aiModel || m.split(':')[0] === s.aiModel.split(':')[0])) throw new Error(`Model "${s.aiModel}" is not installed. Installed: ${ai.models.join(', ')}`);
        ai.available = true; ai.model = s.aiModel; ai.lastError = null;
      } catch (e) {
        ai.available = false; ai.model = null;
        ai.lastError = /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? `Could not reach ${s.aiEndpoint}. Ollama is not running there, or the browser blocked the request.` : e.message;
      }
      return ai;
    };
    ai.completeJSON = async function ({ instructions, facts, schema }) {
      if (!ai.available) throw new Error('AI Mode is unavailable.');
      const s = opts.getSettings();
      const user = `INSTRUCTIONS (from the card, edited by the user):\n${instructions}\n\nREQUIRED OUTPUT (JSON):\n${schema}\n\nDATA (JSON):\n${JSON.stringify(facts)}`;
      const r = await opts.fetch(s.aiEndpoint.replace(/\/$/, '') + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ai.model, stream: false, format: 'json', options: { temperature: 0.2 }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }) });
      if (!r.ok) throw new Error(`Local model returned HTTP ${r.status}.`);
      const j = await r.json(); const text = j && j.message && j.message.content;
      try { return JSON.parse(text); } catch (_) { throw new Error('AI output rejected: the model did not return valid JSON.'); }
    };
    return ai;
  }
  return { createAI, SYSTEM };
});

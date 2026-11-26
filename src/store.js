/* Persistence in this browser only (IndexedDB, with localStorage as a fallback).
 * The whole state is written in one transaction, so a fill and its cash update are saved together. */
(function (root) {
  'use strict';
  const DB = 'paper-trader', STORE = 'kv', KEY = 'state', LS = 'paper-trader-state';
  function openDb() {
    return new Promise((res, rej) => {
      if (!('indexedDB' in self)) return rej(new Error('IndexedDB not available'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  let dbp = null; const db = () => (dbp = dbp || openDb());
  const Store = {
    backend: 'unknown', persisted: null,
    async load() {
      try { const d = await db(); this.backend = 'IndexedDB';
        return await new Promise((res, rej) => { const t = d.transaction(STORE, 'readonly').objectStore(STORE).get(KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); });
      } catch (_) {
        try { this.backend = 'localStorage'; const s = localStorage.getItem(LS); return s ? JSON.parse(s) : null; } catch (e) { this.backend = 'none (memory only)'; return null; }
      }
    },
    async save(state) {
      if (this.backend === 'IndexedDB') {
        const d = await db();
        return new Promise((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(state, KEY); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Save aborted')); });
      }
      if (this.backend === 'localStorage') { localStorage.setItem(LS, JSON.stringify(state)); return; }
      throw new Error('This browser is not saving data (private mode or storage blocked).');
    },
    async requestPersist() {
      try { if (navigator.storage && navigator.storage.persist) this.persisted = await navigator.storage.persist(); } catch (_) { this.persisted = false; }
      return this.persisted;
    },
    async estimate() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (_) { return null; } },
  };
  // one run at a time across tabs (Web Locks); falls back to in-page only
  Store.withRunLock = async function (fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('paper-trader-run', { ifAvailable: true }, async (lock) => (lock ? fn() : null));
    return fn();
  };
  root.PTStore = Store;
})(self);

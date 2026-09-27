// 静的配信版の起動部。Pyodide（ブラウザで動く Python）にゲーム本体を読み込み、
// game.js の通信（/api/*）をブラウザ内の呼び出しに置き換える。セーブはこの端末の localStorage。
(function () {
  'use strict';
  const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
  const SAVE_KEY = 'mrpg_save_v1';
  const note = document.getElementById('bootnote');
  const show = t => { if (note) note.textContent = t; };

  const store = {
    get() { try { return localStorage.getItem(SAVE_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, v); } catch (e) { /* 保存できない環境では続行のみ */ } },
    backup(v) { try { localStorage.setItem(SAVE_KEY + '_broken_' + Date.now(), v); } catch (e) { /* 無視 */ } },
  };

  function loadScript(src) {
    return new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => ng(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }

  async function init() {
    show('よみこみ中…（はじめは 少し 時間が かかります）');
    await loadScript(PYODIDE + 'pyodide.js');
    const py = await loadPyodide({ indexURL: PYODIDE });
    const files = await (await fetch('py/files.json', { cache: 'no-cache' })).json();
    for (const f of files) {
      const body = await (await fetch('py/' + f, { cache: 'no-cache' })).text();
      const dir = '/app/' + f.split('/').slice(0, -1).join('/');
      py.FS.mkdirTree(dir);
      py.FS.writeFile('/app/' + f, body, { encoding: 'utf8' });
    }
    py.runPython("import sys; sys.path.insert(0, '/app')");
    const mod = py.pyimport('web_local');
    const saved = store.get();
    // 読めずに新規になった場合は、元のセーブを別キーに退避しておく
    if (!mod.start(saved) && saved) store.backup(saved);
    show('');
    return mod;
  }

  const ready = init().catch(e => {
    show('よみこみに 失敗しました。通信状態を 確認して ページを 再読み込み してください。');
    throw e;
  });

  window.MRPG_LOCAL = {
    async act(body) {
      const mod = await ready;
      const r = JSON.parse(mod.act(JSON.stringify(body)));
      if (r.save) store.set(r.save);
      return r.out;
    },
    async get(url) {
      const mod = await ready;
      if (url.startsWith('/api/dex')) return JSON.parse(mod.dex());
      return JSON.parse(mod.act(JSON.stringify({ op: 'state' }))).out;
    },
  };
})();

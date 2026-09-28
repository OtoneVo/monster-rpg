'use strict';
// モンスターRPG Web 版（DS 風 2 画面）。ゲームの中身はサーバーの Game、ここは見た目と操作だけ。
(() => {
  const W = 256, H = 192, SC = 4;
  const FONT = '"DotGothic16","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
  const $ = s => document.querySelector(s);
  const cv = $('#top');
  cv.width = W * SC; cv.height = H * SC;
  const g = cv.getContext('2d');
  const panel = $('#panel');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const ESCAPES = ['ああっ！ すぐに', 'ああっ！ 少し', 'あと少し', 'あーっ！'];

  // rAF が止まる環境（非表示ペイン・省電力）でも進むよう、タイマーを保険にする
  function raf(fn) {
    let done = false;
    const go = () => { if (done) return; done = true; clearTimeout(tm); fn(performance.now()); };
    const tm = setTimeout(go, 40);
    requestAnimationFrame(go);
  }
  function tween(ms, fn) {
    return new Promise(res => {
      const t0 = performance.now();
      const f = now => {
        const t = Math.min(1, (now - t0) / ms);
        fn(t);
        if (t < 1) raf(f); else res();
      };
      raf(f);
    });
  }

  // ================= サウンド（WebAudio で生成） =================
  const Snd = (() => {
    let ac = null, master = null, bus = null, seBus = null, noiseBuf = null;
    let muted = false, song = null, timer = null, nextT = 0, step = 0, wanted = null;
    try { muted = localStorage.getItem('mrpg_mute') === '1'; } catch (e) { /* 保存できない環境 */ }
    const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
    const midi = s => { const m = s.match(/^([A-G]#?)(\d)$/); return 12 * (+m[2] + 1) + NOTE[m[1]]; };
    const mtof = n => 440 * Math.pow(2, (n - 69) / 12);

    function init() {
      try {
        if (!ac) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ac = new AC();
          master = ac.createGain(); master.gain.value = muted ? 0 : 0.55; master.connect(ac.destination);
          bus = ac.createGain(); bus.gain.value = 0.3; bus.connect(master);
          seBus = ac.createGain(); seBus.gain.value = 0.6; seBus.connect(master);
          if (wanted) { const w = wanted; wanted = null; play(w); }
        }
        if (ac.state === 'suspended') ac.resume();
      } catch (e) { /* 音なしで続行 */ }
    }
    function osc(type, f, t, dur, vol, dest, f2) {
      const o = ac.createOscillator(), v = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      v.gain.setValueAtTime(0.0001, t);
      v.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(v); v.connect(dest); o.start(t); o.stop(t + dur + 0.02);
    }
    function noise(t, dur, vol, dest, hp) {
      if (!noiseBuf) {
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const f = ac.createBiquadFilter(); f.type = hp ? 'highpass' : 'lowpass'; f.frequency.value = hp || 1400;
      const v = ac.createGain(); v.gain.setValueAtTime(vol, t); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(v); v.connect(dest); s.start(t); s.stop(t + dur + 0.02);
    }
    const seq = (t, notes, gap, len, type = 'square', vol = 0.13) =>
      notes.forEach((f, i) => osc(type, f, t + i * gap, i === notes.length - 1 ? len * 3 : len, vol, seBus));
    const SE = {
      cursor: t => osc('square', 1320, t, 0.04, 0.1, seBus),
      ok: t => { osc('square', 880, t, 0.05, 0.12, seBus); osc('square', 1320, t + 0.05, 0.08, 0.12, seBus); },
      bump: t => osc('square', 120, t, 0.09, 0.2, seBus, 70),
      hit: t => { noise(t, 0.18, 0.55, seBus); osc('square', 220, t, 0.12, 0.2, seBus, 60); },
      crit: t => { noise(t, 0.3, 0.7, seBus); osc('sawtooth', 520, t, 0.25, 0.2, seBus, 50); },
      weak: t => { noise(t, 0.12, 0.3, seBus); osc('square', 160, t, 0.1, 0.15, seBus, 90); },
      faint: t => osc('square', 700, t, 0.7, 0.16, seBus, 60),
      throw: t => osc('triangle', 300, t, 0.3, 0.25, seBus, 1200),
      pop: t => { osc('square', 300, t, 0.12, 0.16, seBus, 900); noise(t, 0.1, 0.2, seBus, 3000); },
      shake: t => { osc('square', 190, t, 0.05, 0.2, seBus); osc('square', 150, t + 0.07, 0.05, 0.2, seBus); },
      capture: t => seq(t, [523, 659, 784, 1047], 0.09, 0.1),
      levelup: t => seq(t, [784, 988, 1175, 1568], 0.07, 0.08),
      heal: t => seq(t, [523, 659, 784, 1047, 784, 1047, 1319], 0.12, 0.14, 'triangle', 0.25),
      encounter: t => { for (let i = 0; i < 10; i++) osc('square', 300 + i * 110, t + i * 0.035, 0.05, 0.11, seBus); },
      buzz: t => osc('square', 90, t, 0.25, 0.2, seBus),
      run: t => { for (let i = 0; i < 4; i++) osc('triangle', 700 - i * 140, t + i * 0.06, 0.08, 0.22, seBus); },
      coin: t => { osc('square', 1976, t, 0.06, 0.1, seBus); osc('square', 2637, t + 0.06, 0.2, 0.1, seBus); },
      win: t => { seq(t, [784, 1047, 1319, 1568], 0.1, 0.09); osc('square', 2093, t + 0.45, 0.6, 0.12, seBus); osc('triangle', 523, t + 0.45, 0.6, 0.25, seBus); },
      door: t => { osc('square', 220, t, 0.06, 0.15, seBus); osc('square', 330, t + 0.07, 0.1, 0.15, seBus); },
    };
    function se(name) { if (!ac || muted) return; try { SE[name](ac.currentTime + 0.01); } catch (e) { /* 無音 */ } }
    function cry(sid) {
      if (!ac || muted) return;
      const h = Art.hash(String(sid)), t = ac.currentTime + 0.01, f = 180 + (h % 320);
      osc('sawtooth', f, t, 0.12, 0.1, seBus, f * 1.7);
      osc('square', f * 1.6, t + 0.1, 0.2, 0.08, seBus, f * (0.6 + (h % 5) / 10));
      noise(t, 0.08, 0.08, seBus, 2000);
    }

    // 曲（16分音符単位。1小節 = 16）
    const parse = s => s.split('|').map(bar => bar.trim().split(/\s+/).map(tok => {
      const [n, l] = tok.split(':'); return [n === 'r' ? null : midi(n), +l];
    }));
    const CH = { C: [48, 52, 55], Am: [45, 48, 52], F: [41, 45, 48], G: [43, 47, 50], E: [40, 44, 47], Dm: [38, 41, 45] };
    const SONGS = {
      field: { tempo: 118, style: 'field', chords: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'],
        lead: parse('E5:2 G5:2 C6:4 B5:2 G5:2 E5:4 | A5:2 C6:2 E6:4 D6:2 C6:2 A5:4 | F5:2 A5:2 C6:2 A5:2 G5:4 F5:4 | G5:2 B5:2 D6:4 C6:2 B5:2 G5:4 |' +
          ' E5:2 G5:2 C6:4 B5:2 G5:2 E5:4 | A5:2 C6:2 E6:4 D6:2 C6:2 A5:4 | F5:2 A5:2 C6:2 F6:2 E6:4 D6:4 | B5:2 D6:2 G5:2 B5:2 D6:8') },
      battle: { tempo: 168, style: 'battle', chords: ['Am', 'F', 'G', 'E'],
        lead: parse('A4:1 C5:1 E5:1 A5:1 G5:2 E5:2 A5:3 B5:1 C6:2 B5:2 | C6:2 A5:2 F5:2 A5:2 C6:3 D6:1 C6:2 A5:2 | B5:2 G5:2 D5:2 G5:2 B5:3 C6:1 D6:4 | E6:4 D6:2 C6:2 B5:4 G#5:4') },
      title: { tempo: 100, style: 'title', chords: ['C', 'G', 'Am', 'F'],
        lead: parse('G5:6 E5:2 C6:8 | B5:6 A5:2 G5:8 | A5:4 C6:4 E6:4 D6:4 | C6:8 A5:4 G5:4') },
    };
    for (const s of Object.values(SONGS)) {
      s.total = s.lead.length * 16; s.at = {};
      s.lead.forEach((bar, bi) => { let p = bi * 16; for (const [n, l] of bar) { if (n) s.at[p] = [n, l]; p += l; } });
    }
    function play(name) {
      if (!ac) { wanted = name; return; }
      if (song && song.name === name) return;
      stop();
      if (!name) return;
      song = Object.assign({ name }, SONGS[name]);
      step = 0; nextT = ac.currentTime + 0.08;
      timer = setInterval(tick, 25);
    }
    function stop() { if (timer) clearInterval(timer); timer = null; song = null; }
    function tick() {
      if (!song || !ac) return;
      const sp = 60 / song.tempo / 4;
      if (nextT < ac.currentTime) nextT = ac.currentTime + 0.05;
      while (nextT < ac.currentTime + 0.15) { sched(step, nextT, sp); step = (step + 1) % song.total; nextT += sp; }
    }
    function sched(s, t, sp) {
      const p = s % 16, ch = CH[song.chords[Math.floor(s / 16) % song.chords.length]];
      const ln = song.at[s];
      if (ln) {
        const d = ln[1] * sp * 0.92;
        osc('square', mtof(ln[0]), t, d, 0.08, bus);
        osc('triangle', mtof(ln[0]) * 1.004, t, d, 0.06, bus);
      }
      if (song.style === 'field') {
        if (p % 4 === 0) osc('triangle', mtof(ch[p % 8 === 0 ? 0 : 2] - 12), t, sp * 3.5, 0.32, bus);
        if (p % 2 === 0) osc('square', mtof(ch[(p / 2) % 3] + 12), t, sp * 0.9, 0.025, bus);
        if (p % 4 === 2) noise(t, 0.03, 0.05, bus, 7000);
      } else if (song.style === 'battle') {
        if (p % 2 === 0) osc('triangle', mtof(ch[0] - 12 + ((p / 2) % 2 ? 12 : 0)), t, sp * 1.8, 0.34, bus);
        osc('square', mtof(ch[p % 3] + 12), t, sp * 0.8, 0.018, bus);
        if (p === 0 || p === 8) osc('sine', 150, t, 0.14, 0.6, bus, 40);
        if (p === 4 || p === 12) noise(t, 0.12, 0.35, bus, 1800);
        if (p % 2 === 0) noise(t, 0.03, 0.07, bus, 8000);
      } else {
        if (p === 0) ch.forEach(n => osc('triangle', mtof(n + 12), t, sp * 15, 0.06, bus));
        if (p % 8 === 0) osc('triangle', mtof(ch[0] - 12), t, sp * 7, 0.3, bus);
        if (p % 2 === 1) osc('square', mtof(ch[(p >> 1) % 3] + 24), t, sp * 0.8, 0.015, bus);
      }
    }
    function setMute(m) {
      muted = m;
      try { localStorage.setItem('mrpg_mute', m ? '1' : '0'); } catch (e) { /* 保存できない環境 */ }
      if (master) master.gain.value = m ? 0 : 0.55;
    }
    document.addEventListener('visibilitychange', () => {
      if (!ac) return;
      if (document.hidden) ac.suspend(); else { ac.resume(); nextT = ac.currentTime + 0.05; }
    });
    return { init, se, cry, play, setMute, get muted() { return muted; } };
  })();

  // ================= 状態 =================
  let N = null, DEX = null;
  const NAME2SID = {};
  let scene = 'boot';
  let busy = false, walking = false;
  const ui = { sub: 'main' };
  const FX = { fade: 0, flash: 0, flashColor: '#ffffff', wipe: 0, banner: null };
  const P = { x: 0, y: 0, facing: 'down', frame: 0, stepN: 0 };
  let areaView = null, B = null, EV = null;
  const ST = { sel: 0, chosen: null };
  const npcFace = {};
  let particles = [], parade = [];
  let T = 0;
  let CUR = null;  // 今 表示している メッセージ時点の 戦闘の様子（サーバーの frames）
  const HP_STEPS = 48;

  const monInfo = sid => (DEX && DEX.species[sid]) || { line: String(sid), stage: 0, types: ['ノーマル'], name: '？？？' };
  // 差し替え画像（data/images.json）。読み込めた種族だけ 手描きの代わりに使う。読み込み中・失敗時は 手描きのまま
  // 色違いも 同じ画像。後ろ姿は 左右反転で 代用する
  const IMG = {}, imgSprite = {};
  let imgRedraw = 0;
  function loadImages() {
    for (const [sid, s] of Object.entries(DEX.species)) {
      if (!s.img) continue;
      const im = new Image();
      im.onload = () => {
        if (!im.naturalWidth || !im.naturalHeight) return;
        IMG[sid] = im;
        for (const k of Object.keys(iconCache)) if (k.startsWith(sid + '|')) delete iconCache[k];
        clearTimeout(imgRedraw);
        imgRedraw = setTimeout(() => { if (N) renderPanel(); }, 60);  // まとめて 描き直す
      };
      im.src = s.img;
    }
  }
  function imageSprite(sid, back) {
    const k = sid + '|' + !!back;
    if (imgSprite[k]) return imgSprite[k];
    const im = IMG[sid], ref = Art.monster(sid, monInfo(sid), false, false);
    const W = ref.width, H = ref.height;
    const [c, x] = Art.canvas(W, H);
    const sc = Math.min(W / im.naturalWidth, H / im.naturalHeight);
    const w = Math.max(1, Math.round(im.naturalWidth * sc)), h = Math.max(1, Math.round(im.naturalHeight * sc));
    x.imageSmoothingEnabled = sc < 1;  // 縮小は なめらかに、拡大は ドットのまま
    if (x.imageSmoothingEnabled) x.imageSmoothingQuality = 'high';
    if (back) { x.translate(W, 0); x.scale(-1, 1); }
    x.drawImage(im, Math.floor((W - w) / 2), H - h, w, h);  // 足元を 手描きと そろえる
    return (imgSprite[k] = c);
  }
  const monSprite = (sid, back, shiny) => IMG[sid] ? imageSprite(sid, !!back) : Art.monster(sid, monInfo(sid), !!back, !!shiny);
  const silCache = new WeakMap();
  function silhouette(c, color) {
    let m = silCache.get(c);
    if (!m) { m = {}; silCache.set(c, m); }
    if (!m[color]) {
      const [s, x] = Art.canvas(c.width, c.height);
      x.drawImage(c, 0, 0); x.globalCompositeOperation = 'source-in';
      x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
      m[color] = s;
    }
    return m[color];
  }
  const iconCache = {};
  function icon(sid, shiny) {
    const k = sid + '|' + !!shiny;
    if (!iconCache[k]) iconCache[k] = monSprite(sid, false, shiny).toDataURL();
    return iconCache[k];
  }
  const typeCss = t => Art.rgb(Art.typeColor(t));
  const typeTags = types => (types || []).map(t => `<span class="tag" style="background:${typeCss(t)}">${esc(t)}</span>`).join(' ');

  // ================= 描画の小道具 =================
  function rr(x, y, w, h, r, fill, stroke, lw = 1) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
  }
  function text(s, x, y, o = {}) {
    g.font = `${o.size || 12}px ${FONT}`;
    g.textAlign = o.align || 'left'; g.textBaseline = 'alphabetic';
    if (o.outline) { g.lineJoin = 'round'; g.lineWidth = o.lw || 3; g.strokeStyle = o.outline; g.strokeText(s, x, y); }
    if (o.shadow) { g.fillStyle = o.shadow; g.fillText(s, x + 1, y + 1); }
    g.fillStyle = o.color || '#28303c'; g.fillText(s, x, y);
  }
  const NO_HEAD = '、。！？」』）…ー', BREAK_AFTER = '、。！？」』）';
  function wrapText(s, maxW, size = 12) {
    g.save(); g.font = `${size}px ${FONT}`;
    // 文字単位で折る。句読点は行頭に置かず、なるべく句読点・空白の直後で折る。
    // ただしそれで行数が増える（「よ』」だけ次ページ等）なら、行数の少ない折り方を採る
    const wrapPara = (para, look) => {
      const out = [];
      let cur = '';
      for (const ch of para) {
        if (!cur && ch === ' ') continue;
        if (g.measureText(cur + ch).width > maxW && cur) {
          let cut = -1;
          for (let k = cur.length - 1; k >= Math.max(1, cur.length - look); k--) {
            if (BREAK_AFTER.includes(cur[k]) || cur[k] === ' ') { cut = k + 1; break; }
          }
          if (cut < 0 || cut >= cur.length) {
            cut = cur.length; // 行頭禁則の文字が来たら、直前の文字ごと次の行へ送る（はみ出させない）
            const head = i => (i === cur.length ? ch : cur[i]);
            while (cut > 1 && head(cut) !== ' ' && NO_HEAD.includes(head(cut))) cut--;
          }
          out.push(cur.slice(0, cut).trimEnd()); cur = cur.slice(cut).trimStart();
          if (ch === ' ') continue;
        }
        cur += ch;
      }
      out.push(cur);
      return out;
    };
    const lines = [];
    for (const para of String(s).split('\n')) {
      const nice = wrapPara(para, 8), tight = wrapPara(para, 0);
      lines.push(...(nice.length > tight.length ? tight : nice));
    }
    g.restore();
    return lines;
  }

  // ================= メッセージ窓 =================
  const MSG = { pages: null, page: 0, shown: 0, lock: false, resolve: null };
  function say(s, anim) {
    const lines = wrapText(s, 222);
    const pages = [];
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2));
    return new Promise(res => {
      Object.assign(MSG, { pages, page: 0, shown: 0, lock: !!anim, resolve: res });
      if (anim) Promise.resolve(anim).catch(() => {}).then(() => { MSG.lock = false; });
    });
  }
  const pageLen = () => (MSG.pages ? MSG.pages[MSG.page].join('').length : 0);
  function advance() {
    if (!MSG.pages) return false;
    if (MSG.shown < pageLen()) { MSG.shown = pageLen(); return true; }
    if (MSG.lock) return true;
    Snd.se('cursor');
    if (MSG.page + 1 < MSG.pages.length) { MSG.page++; MSG.shown = 0; return true; }
    const r = MSG.resolve; MSG.pages = null; MSG.resolve = null; r && r();
    return true;
  }
  const hintCache = {};
  function hintText() {
    if (busy || !N || MSG.pages) return null;
    if (scene === 'prof') return PF.hint || null;  // 名前を 選ぶ間も 博士の 問いかけを 残す
    if (scene === 'battle' && N.battle && B) {
      if (N.battle.state === 'force_switch') return N.battle.kind === 'wild' ? '次の モンスターを 出す？ 逃げる？' : '次に出す モンスターを 選んでください';
      if (N.battle.state === 'offer_switch') return ui.sub === 'oswitch' ? '入れ替える モンスターを 選んでください' : 'モンスターを 入れ替えますか？';
      const me = N.party[N.battle.player_index];
      if (N.battle.state === 'choose' && me) return ui.sub === 'fight' ? '技を 選んでください' : ui.sub === 'mdet' ? 'もう一度 押すと その技を 使う' : `${me.name}は どうする？`;
      return null;
    }
    if (scene === 'title' || !N.prompt) return null;
    const p = N.prompt;
    if (p.kind === 'shop') return ui.sub === 'qty' ? 'いくつ 買いますか？' : `いらっしゃい！ 何に します？（所持金 ${N.money}円）`;
    if (p.kind === 'box') {
      if (ui.sub === 'boxsw') return 'だれと 入れ替える？（預けた子は 元気に なる）';
      return ui.boxTab ? '手持ちに 加える モンスターを 選んでください' : '預ける モンスターを 選んでください';
    }
    return p.text || null;
  }
  function drawMsg() {
    let lines, typed = Infinity, done = true;
    if (MSG.pages) { lines = MSG.pages[MSG.page]; typed = Math.floor(MSG.shown); done = MSG.shown >= pageLen() && !MSG.lock; }
    else {
      const h = hintText();
      if (!h) return;
      lines = (hintCache[h] = hintCache[h] || wrapText(h, 222)).slice(0, 2);
      done = false;
    }
    rr(3, 145, 250, 44, 5, '#fbfbf6', '#34507e', 2);
    rr(6, 148, 244, 38, 3, null, '#a8c0e0', 1);
    let left = typed;
    lines.forEach((ln, i) => {
      const part = left >= ln.length ? ln : ln.slice(0, Math.max(0, left));
      left -= ln.length;
      text(part, 12, 163 + i * 17, { color: '#2a2e38', shadow: '#d0d4dc' });
    });
    if (done && Math.floor(T / 300) % 2) {
      g.fillStyle = '#e0563c';
      g.beginPath(); g.moveTo(236, 178); g.lineTo(244, 178); g.lineTo(240, 183); g.fill();
    }
  }

  // ================= 通信 =================
  async function api(body) {
    if (window.MRPG_LOCAL) return window.MRPG_LOCAL.act(body);  // 静的版: ブラウザ内の Python が処理
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch('/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!j.state) throw new Error(j.error || String(r.status));
        return j;
      } catch (e) {
        if (attempt >= 2) {
          Snd.se('buzz');
          await say('（PC の サーバーに つながらない。 サーバーが 動いているか 確認してね）');
          throw e;
        }
        await sleep(700);
      }
    }
  }
  async function getJSON(url) {
    if (window.MRPG_LOCAL) return window.MRPG_LOCAL.get(url);
    for (;;) {
      try { const r = await fetch(url); return await r.json(); } catch (e) { await sleep(1500); }
    }
  }

  // ================= メッセージの整形 =================
  function cleanMsg(m) {
    return String(m).replace(/（[^（）]*(選択|A ボタン|で答えて|コマンド|番号|count)[^（）]*）/g, '').trim();
  }
  function isNoise(m) {
    return /^(北|南|東|西)へ \d+ 歩 進んだ。$/.test(m) || m === 'その先へは 進めない。' ||
      /^目の前に .+がある。/.test(m) || /^目の前には 何もない/.test(m) || /選択待ち/.test(m) ||
      m === '新しい冒険を はじめた。' ||
      // 建物の 出入りは 地名表示と 暗転で 分かるので 文章は 出さない
      /^.+に 入った。$/.test(m) || m === '外に 出た。' ||
      /^あずかり箱を 開いた/.test(m) || /^.+を 開いた。（預けた/.test(m) || m === 'あずかり箱を 閉じた。';
  }

  // ================= 行動の実行 =================
  function setBusy(v) { busy = v; renderPanel(); }
  async function act(body, opts = {}) {
    if (busy) return;
    setBusy(true);
    const old = N;
    let res;
    try {
      const req = api(body);
      if (opts.during) await Promise.all([req, opts.during()]);
      res = await req;
    } catch (e) { setBusy(false); return; }
    if (opts.after) await opts.after(res);
    await present(res, old);
    setBusy(false);
  }
  async function present(res, old) {
    const nw = res.state;
    N = nw;
    if (res.error) { Snd.se('buzz'); await say(`（${res.error}）`); }
    // メッセージ1件ごとの 戦闘の様子（HP・状態異常）を 並べて持つ。無ければ 最後の状態から 推し量る
    const fr = Array.isArray(res.frames) && res.frames.length === res.messages.length ? res.frames : null;
    const items = [];
    res.messages.forEach((raw, i) => { const m = cleanMsg(raw); if (m && !isNoise(m)) items.push({ m, f: fr ? fr[i] : null }); });
    const msgs = items.map(x => x.m);
    try {
      for (let i = 0; i < items.length; i++) { CUR = items[i].f; await handle(msgs[i], msgs.slice(i + 1), old, nw); }
    } finally { CUR = null; }
    await settle(old, nw);
  }

  // ================= メッセージごとの演出 =================
  const disp = side => (side === 'e' ? B.enemy.hp : B.player.hp);
  // そのメッセージ時点の HP（frames があれば それを使う。毒のダメージと 技のダメージを 別々に 見せるため）
  function frameHp(side) {
    if (!CUR || !B) return null;
    if (side === 'e') return B.enemy && B.enemy.eidx === CUR.e_idx && CUR.e_steps != null ? CUR.e_steps / HP_STEPS : null;
    return B.player && B.player.idx === CUR.p_idx && CUR.p_hp != null ? CUR.p_hp : null;
  }
  function finalHp(side, rest, nw) {
    const f = frameHp(side);
    if (f != null) return f;
    if (side === 'e') {
      if (rest.some(r => r === `${B.enemy.label}は 倒れた！`)) return 0;
      const e = nw.battle && nw.battle.enemy;
      if (e && e.name === B.enemy.name) return e.hp_steps / e.hp_steps_max;
      return B.enemy.hp;
    }
    if (rest.some(r => r === `${B.player.name}は 倒れた！`)) return 0;
    const m = nw.party[B.player.idx];
    return m && m.name === B.player.name ? m.hp : B.player.hp;
  }
  function tweenHp(side, to) {
    const o = side === 'e' ? B.enemy : B.player;
    const from = o.hp;
    if (Math.abs(from - to) < 1e-6) return Promise.resolve();
    const span = side === 'e' ? Math.abs(from - to) : Math.abs(from - to) / Math.max(1, o.max_hp);
    return tween(250 + 900 * span, t => { o.hp = from + (to - from) * t; });
  }
  function tweenExp(to) {
    const o = B.player, from = o.exp;
    if (to <= from) { o.exp = to; return Promise.resolve(); }
    return tween(300 + 700 * (to - from), t => { o.exp = from + (to - from) * t; });
  }
  async function lunge(side) {
    const o = side === 'e' ? B.enemy : B.player, k = side === 'e' ? -12 : 14;
    await tween(110, t => { o.dx = k * t; o.dy = side === 'e' ? 3 * t : -3 * t; });
    await tween(130, t => { o.dx = k * (1 - t); o.dy = (side === 'e' ? 3 : -3) * (1 - t); });
  }
  async function blink(side) {
    const o = side === 'e' ? B.enemy : B.player;
    o.blink = true; await sleep(420); o.blink = false;
  }
  const center = side => (side === 'e' ? { x: 188, y: 56 } : { x: 64, y: 110 });
  function burst(x, y, color, n = 14, speed = 1.6, kind = 'spark') {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.3, life: 0, max: 380 + Math.random() * 300, color, size: 1 + Math.random() * 2, kind });
    }
  }
  const mkEnemy = (e, kind, eidx) => ({
    eidx: eidx == null ? -1 : eidx, name: e.name, sid: e.species, level: e.level, types: e.types, shiny: e.shiny, status: e.status,
    hp: e.hp_steps / e.hp_steps_max, label: (kind === 'wild' ? '野生の ' : '相手の ') + e.name,
    visible: true, dx: 0, dy: 0, sink: 0, scale: 1, white: 0, blink: false,
  });
  function mkPlayer(nw, idx, old) {
    const m = nw.party[idx];
    if (!m) return null;
    const om = old && old.party && old.party[idx];
    const same = om && om.name === m.name;
    // 出した時点の HP・状態異常を使う（最後の状態を先に見せると、この後 毒になる 等が 先にばれる）
    const f = CUR && CUR.p_idx === idx ? CUR : null;
    return {
      name: m.name, sid: m.species, level: same ? om.level : m.level, max_hp: f ? f.p_max : same ? om.max_hp : m.max_hp,
      hp: f ? f.p_hp : same ? om.hp : m.hp, exp: same ? om.exp_ratio : m.exp_ratio,
      status: f ? f.p_status : same ? om.status : m.status, shiny: m.shiny, idx,
      visible: false, dx: 0, dy: 0, sink: 0, scale: 1, white: 0, blink: false,
    };
  }
  function initBattle(nw, old) {
    const b = nw.battle;
    B = {
      kind: b.kind, team: b.enemy_team.slice(),
      trainer: b.trainer ? { id: b.trainer.id, style: Art.styleFor(b.trainer.id), dx: 0, visible: b.kind !== 'wild' } : null,
      hero: { dx: 0, visible: true }, enemy: mkEnemy(b.enemy, b.kind, b.enemy_index),
      player: mkPlayer(nw, b.player_index, old), ball: null,
    };
    B.enemy.visible = b.kind === 'wild';
  }
  async function startBattle(nw, old) {
    Snd.play('battle'); Snd.se('encounter');
    for (let k = 0; k < 3; k++) { await tween(80, t => { FX.flash = 0.9 * (1 - t); }); await sleep(40); }
    FX.flash = 0;
    await tween(420, t => { FX.wipe = t; });
    initBattle(nw, old);
    scene = 'battle';
    const slide = o => { if (o) o.dx = 150; };
    slide(B.kind === 'wild' ? B.enemy : B.trainer);
    B.hero.dx = -150;
    await tween(360, t => { FX.wipe = 1 - t; });
    await tween(480, t => {
      const k = 150 * (1 - ease(t));
      if (B.kind === 'wild') B.enemy.dx = k; else if (B.trainer) B.trainer.dx = k;
      B.hero.dx = -k;
    });
    if (B.kind === 'wild') {
      Snd.cry(B.enemy.sid);
      if (B.enemy.shiny) burst(188, 50, '#fff6a0', 20, 1.2, 'star');
    }
  }
  async function throwBall(fx, fy, tx, ty, ms = 380, kind = '') {
    Snd.se('throw');
    B.ball = { x: fx, y: fy, rot: 0, dim: false, kind };
    await tween(ms, t => {
      B.ball.x = fx + (tx - fx) * t;
      B.ball.y = fy + (ty - fy) * t - 46 * Math.sin(Math.PI * t);
      B.ball.rot = t * 14;
    });
  }
  async function sendOut(side, o) {
    const c = side === 'e' ? { x: 188, y: 62 } : { x: 64, y: 120 };
    const from = side === 'e' ? { x: 250, y: 30 } : { x: 10, y: 120 };
    await throwBall(from.x, from.y, c.x, c.y, 320);
    B.ball = null;
    Snd.se('pop');
    burst(c.x, c.y, '#ffffff', 16, 1.4);
    o.visible = true; o.scale = 0; o.white = 1;
    await tween(260, t => { o.scale = t; o.white = 1 - t; });
    o.scale = 1; o.white = 0;
    Snd.cry(o.sid);
  }
  async function slideOut(o, dist) {
    if (!o || !o.visible) return;
    await tween(300, t => { o.dx = dist * t; });
    o.visible = false; o.dx = 0;
  }
  async function captureAnim(shakes, ok) {
    await throwBall(30, 140, 184, 52, 450, B.ballKind || '');
    const e = B.enemy;
    await tween(240, t => { e.white = t; e.scale = 1 - t * 0.9; });
    e.visible = false; e.scale = 1; e.white = 0;
    await tween(320, t => {
      const b = t < 0.7 ? (t / 0.7) ** 2 : 1 - 0.25 * Math.sin(Math.PI * (t - 0.7) / 0.3);
      B.ball.y = 52 + 24 * b; B.ball.rot = 0;
    });
    Snd.se('pop');
    for (let k = 0; k < shakes; k++) {
      await sleep(380);
      Snd.se('shake');
      await tween(320, t => { B.ball.rot = Math.sin(t * Math.PI * 2) * 0.5; });
    }
    await sleep(260);
    if (ok) {
      Snd.play(null); Snd.se('capture');
      burst(B.ball.x, B.ball.y - 4, '#fff6a0', 18, 1.1, 'star');
      B.ball.dim = true;
    } else {
      Snd.se('pop');
      B.ball = null;
      e.visible = true; e.white = 1; e.scale = 0;
      burst(184, 60, '#ffffff', 14, 1.4);
      await tween(240, t => { e.scale = t; e.white = 1 - t; });
      e.scale = 1; e.white = 0;
    }
  }
  function enemyFromMsg(name, level, nw) {
    const e = nw.battle && nw.battle.enemy;
    const f = CUR && CUR.e_steps != null ? CUR : null;
    const eidx = f ? f.e_idx : e && e.name === name ? nw.battle.enemy_index : -1;
    const st = { hp_steps: f ? f.e_steps : 1, hp_steps_max: f ? HP_STEPS : 1, status: f ? f.e_status : null, level };
    if (e && e.name === name) return mkEnemy(Object.assign({}, e, st), B.kind, eidx);
    const sid = NAME2SID[name];
    const info = monInfo(sid);
    return mkEnemy(Object.assign({ name, species: sid, types: info.types, shiny: false }, st), B.kind, eidx);
  }
  // メッセージ時点の 状態異常を 画面へ反映し、HP が ずれていれば 合わせる
  function applyFrameStatus() {
    if (!CUR || !B) return;
    if (B.player && B.player.idx === CUR.p_idx) B.player.status = CUR.p_status;
    if (B.enemy && B.enemy.eidx === CUR.e_idx) B.enemy.status = CUR.e_status;
  }
  function syncHpToFrame() {
    if (!CUR || !B) return null;
    const jobs = [];
    for (const side of ['e', 'p']) {
      const f = frameHp(side), o = side === 'e' ? B.enemy : B.player;
      if (f != null && o && o.visible && Math.abs(o.hp - f) > 1e-6) jobs.push(tweenHp(side, f));
    }
    return jobs.length ? Promise.all(jobs) : null;
  }

  async function handle(m, rest, old, nw) {
    // ---- 場所の移動 ----
    if (/に 着いた。$/.test(m) && nw.area && m.startsWith(nw.area.name)) {
      if (!areaView || areaView.id !== nw.area.id || scene !== 'field') await changeArea(nw);
      else showBanner(nw.area.name);
      return;
    }
    // ---- 相棒選び ----
    if (/を 相棒に選んだ！/.test(m) && scene === 'starter') {
      Snd.se('win');
      await say(m);
      await tween(300, t => { FX.fade = t; });
      ST.chosen = null; setArea(nw); scene = 'field'; Snd.play('field');
      await tween(300, t => { FX.fade = 1 - t; });
      return;
    }
    // ---- 戦闘の始まり ----
    if ((/^あっ！ 野生の/.test(m) || /勝負を しかけてきた！$/.test(m)) && scene !== 'battle' && nw.battle) {
      await startBattle(nw, old);
      return say(m);
    }
    if (scene !== 'battle' || !B) return fieldMsg(m, rest, nw);

    // ---- 以下、戦闘中 ----
    applyFrameStatus();
    const am = m.match(/^(野生の |相手の )?(.+?)の (.+?)！$/);
    if (am && DEX.moves[am[3]] !== undefined) {
      const side = am[1] ? 'e' : 'p', tgt = side === 'e' ? 'p' : 'e';
      const type = DEX.moves[am[3]];
      const miss = (rest[0] || '').startsWith('しかし');
      const to = finalHp(tgt, rest, nw);
      const hits = !miss && to < disp(tgt) - 1e-6;
      const crit = rest.slice(0, 3).some(r => r.startsWith('急所'));
      const anim = (async () => {
        await lunge(side);
        const c = center(hits ? tgt : side);
        if (hits) {
          Snd.se(crit ? 'crit' : 'hit');
          burst(c.x, c.y, Art.rgb(Art.typeColor(type)), 16, 1.8);
          burst(c.x, c.y, '#ffffff', 6, 1.2);
          await Promise.all([blink(tgt), tweenHp(tgt, to)]);
        } else if (!miss) {
          Snd.se('ok');
          burst(c.x, c.y, Art.rgb(Art.light(Art.typeColor(type), 0.4)), 12, 0.8, 'star');
          await sleep(300);
        }
      })();
      return say(m, anim);
    }
    if (/^効果は いまひとつ/.test(m)) { Snd.se('weak'); return say(m); }
    const fm = m.match(/^(.+)は 倒れた！$/);
    if (fm) {
      for (const side of ['e', 'p']) {
        const o = side === 'e' ? B.enemy : B.player;
        const nm = side === 'e' ? o.label : o.name;
        if (o && o.visible && fm[1] === nm) {
          await tweenHp(side, 0);
          Snd.se('faint');
          await tween(420, t => { o.sink = t; });
          o.visible = false; o.sink = 0;
          if (side === 'e') {
            const i = B.team.indexOf(1);
            if (B.kind !== 'wild' && i >= 0) B.team[i] = 0;
            if (!nw.battle && B.kind === 'wild') { Snd.play(null); Snd.se('win'); }
          }
          return say(m);
        }
      }
      return say(m);
    }
    const xm = m.match(/^(.+)は (\d+) の 経験値を もらった！$/);
    if (xm && B.player && xm[1] === B.player.name && B.player.visible) {
      const lvl = rest.some(r => r.startsWith(`${B.player.name}は Lv`));
      const fmn = nw.party[B.player.idx];
      return say(m, tweenExp(lvl ? 1 : (fmn ? fmn.exp_ratio : B.player.exp)));
    }
    const lm = m.match(/^(.+)は Lv(\d+) に 上がった！$/);
    if (lm && B.player && lm[1] === B.player.name) {
      Snd.se('levelup');
      const o = B.player, fmn = nw.party[o.idx];
      o.level = +lm[2];
      if (fmn && fmn.level === o.level) { o.hp = Math.min(fmn.max_hp, o.hp + (fmn.max_hp - o.max_hp)); o.max_hp = fmn.max_hp; }
      o.exp = 0;
      burst(64, 110, '#a0e8ff', 14, 1, 'star');
      const more = rest.some(r => r.startsWith(`${o.name}は Lv`));
      return say(m, tweenExp(more ? 1 : (fmn ? fmn.exp_ratio : 0)));
    }
    let sm = m.match(/^(野生の |相手の )?(.+)は (反動を 受けた|体力を 回復した)！$/);
    if (sm) {
      const side = sm[1] ? 'e' : 'p';
      if (sm[3] === '体力を 回復した') Snd.se('heal'); else Snd.se('weak');
      return say(m, tweenHp(side, finalHp(side, rest, nw)));
    }
    if (/ダメージを受けている|^砂嵐が|^雪が|自分を攻撃した/.test(m)) {
      Snd.se('weak');
      return say(m, Promise.all([tweenHp('e', finalHp('e', rest, nw)), tweenHp('p', finalHp('p', rest, nw))]));
    }
    sm = m.match(/^(.+)を使った。/);
    if (sm) {
      Snd.se('heal');
      burst(64, 110, '#a0ffb0', 14, 0.9, 'star');
      const o = B.player;
      return say(m, (async () => { if (o && !o.visible) return; await tweenHp('p', finalHp('p', rest, nw)); })());
    }
    sm = m.match(/^戻れ、(.+)！$/);
    if (sm && B.player && B.player.visible) {
      Snd.se('ok');
      const o = B.player;
      const anim = (async () => {
        o.white = 1;
        await tween(260, t => { o.scale = 1 - t; });
        o.visible = false; o.scale = 1; o.white = 0;
      })();
      return say(m, anim);
    }
    sm = m.match(/^行け、(.+)！$/);
    if (sm) {
      let idx = CUR && nw.party[CUR.p_idx] && nw.party[CUR.p_idx].name === sm[1] ? CUR.p_idx
        : nw.battle && nw.party[nw.battle.player_index] && nw.party[nw.battle.player_index].name === sm[1]
        ? nw.battle.player_index : nw.party.findIndex(p => p.name === sm[1] && p.hp > 0);
      if (idx < 0) idx = nw.party.findIndex(p => p.name === sm[1]);
      const o = mkPlayer(nw, Math.max(0, idx), old);
      const anim = (async () => {
        await Promise.all([slideOut(B.hero, -140), (async () => { B.player = o; await sendOut('p', o); })()]);
      })();
      return say(m, anim);
    }
    sm = m.match(/^(.+)は (.+)（Lv(\d+)）を 繰り出した！$/);
    if (sm) {
      const e = enemyFromMsg(sm[2], +sm[3], nw);
      e.visible = false;
      const anim = (async () => {
        await slideOut(B.trainer, 140);
        B.enemy = e;
        await sendOut('e', e);
      })();
      return say(m, anim);
    }
    sm = m.match(/^(.+)を 投げた！$/);
    if (sm) {
      const next = rest[0] || '';
      const ok = next.startsWith('やった！');
      const shakes = ok ? 3 : Math.max(0, ESCAPES.findIndex(s => next.startsWith(s)));
      return say(m, captureAnim(shakes, ok));
    }
    if (/^やった！/.test(m)) { Snd.se('win'); return say(m); }
    if (/^うまく 逃げ切れた/.test(m)) { Snd.se('run'); return say(m); }
    if (/との 勝負に 勝った！$/.test(m)) {
      Snd.play(null); Snd.se('win');
      if (B.trainer) { B.trainer.visible = true; B.trainer.dx = 150; tween(400, t => { B.trainer.dx = 150 * (1 - ease(t)); }); }
      return say(m);
    }
    if (/^賞金として/.test(m)) { Snd.se('coin'); return say(m); }
    if (/目の前が 真っ暗/.test(m)) {
      Snd.play(null);
      await say(m);
      await tween(500, t => { FX.fade = t; });
      return;
    }
    if (/手に入れた！/.test(m)) { Snd.se('win'); return say(m); }
    if (/が 仲間に 加わった|ボックスに/.test(m)) { Snd.se('capture'); return say(m); }
    if (/覚えた！$/.test(m)) { Snd.se('levelup'); return say(m); }
    if (/^急所に/.test(m) || /^効果は 抜群/.test(m)) return say(m);
    return say(m, syncHpToFrame());
  }

  async function fieldMsg(m, rest, nw) {
    if (/^休み処で/.test(m)) {
      Snd.se('heal');
      FX.flashColor = '#ffd0e0';
      tween(900, t => { FX.flash = 0.7 * Math.sin(Math.PI * t); }).then(() => { FX.flash = 0; FX.flashColor = '#ffffff'; });
      return say(m);
    }
    if (/^おめでとう！/.test(m)) { Snd.se('win'); return say(m); }
    if (/手に入れた！|もらった/.test(m)) { Snd.se('coin'); return say(m); }
    if (/を使った。/.test(m)) { Snd.se('heal'); return say(m); }
    if (/覚えた！$/.test(m)) { Snd.se('levelup'); return say(m); }
    if (/^【/.test(m)) { Snd.se('win'); return say(m); }
    return say(m);
  }

  async function settle(old, nw) {
    if (scene === 'battle' && !nw.battle) { // 戦闘終了
      if (FX.fade < 1) { const f0 = FX.fade; await tween(320, t => { FX.fade = f0 + (1 - f0) * t; }); }
      B = null; particles = [];
      setArea(nw);
      if (nw.prompt && nw.prompt.kind === 'evolve') enterEvolve(nw);
      else { scene = 'field'; Snd.play('field'); }
      await tween(320, t => { FX.fade = 1 - t; });
      FX.fade = 0;
    }
    if (nw.battle && scene !== 'battle') { // 演出の合図なしで戦闘になっていた場合
      initBattle(nw, null);
      B.enemy.visible = true; B.hero.visible = false; if (B.trainer) B.trainer.visible = false;
      if (B.player) B.player.visible = B.player.hp > 0;
      scene = 'battle'; Snd.play('battle');
    }
    if (scene === 'battle' && nw.battle) syncBattle(nw);
    if (!nw.battle && nw.prompt && nw.prompt.kind === 'evolve' && (scene !== 'evolve' || !EV || EV.party !== nw.prompt.party)) {
      await tween(260, t => { FX.fade = t; });
      setArea(nw); enterEvolve(nw);
      await tween(260, t => { FX.fade = 1 - t; });
    }
    if (scene === 'evolve' && !(nw.prompt && nw.prompt.kind === 'evolve')) {
      await tween(300, t => { FX.fade = t; });
      EV = null; setArea(nw); scene = 'field'; Snd.play('field');
      await tween(300, t => { FX.fade = 1 - t; });
    }
    if (!nw.battle && nw.prompt && nw.prompt.kind === 'starter' && scene !== 'starter') { scene = 'starter'; ST.chosen = null; }
    if (scene === 'starter' && !(nw.prompt && nw.prompt.kind === 'starter') && !nw.battle) { setArea(nw); scene = 'field'; }
    if (scene === 'field') {
      if (!areaView || areaView.id !== nw.area.id) await changeArea(nw);
      else { areaView = nw.area; if (!walking) snapP(); }
    }
    FX.fade = Math.min(FX.fade, 1);
  }
  function syncBattle(nw) {
    const b = nw.battle;
    B.team = b.enemy_team.slice();
    if (!B.enemy || b.enemy.name !== B.enemy.name) B.enemy = mkEnemy(b.enemy, b.kind, b.enemy_index);
    else {
      Object.assign(B.enemy, { eidx: b.enemy_index, hp: b.enemy.hp_steps / b.enemy.hp_steps_max, status: b.enemy.status, level: b.enemy.level });
      if (b.enemy.hp_steps > 0) B.enemy.visible = true;
    }
    if (B.trainer) B.trainer.visible = false;
    B.hero.visible = false;
    const m = nw.party[b.player_index];
    if (!m) return;
    if (!B.player || B.player.idx !== b.player_index || B.player.name !== m.name) {
      B.player = mkPlayer(nw, b.player_index, null);
    } else {
      Object.assign(B.player, { hp: m.hp, max_hp: m.max_hp, level: m.level, exp: m.exp_ratio, status: m.status });
    }
    B.player.visible = m.hp > 0 && b.state !== 'force_switch';
    // 相手が 次を出す前の 入れ替え確認中は、相手の 場は 空
    if (b.state === 'offer_switch' && b.enemy.hp_steps <= 0) B.enemy.visible = false;
  }

  // ================= フィールド =================
  function setArea(st) {
    areaView = st.area;
    P.x = st.player.x * 16; P.y = st.player.y * 16; P.facing = st.player.facing; P.frame = 0;
  }
  function snapP() { if (!N) return; P.x = N.player.x * 16; P.y = N.player.y * 16; P.facing = N.player.facing; P.frame = 0; }
  function showBanner(name) { FX.banner = { text: name, t0: T }; }
  async function changeArea(st) {
    Snd.se('door');
    await tween(220, t => { FX.fade = Math.max(FX.fade, t); });
    setArea(st);
    if (scene !== 'battle') scene = 'field';
    Snd.play('field');
    await sleep(80);
    await tween(260, t => { FX.fade = 1 - t; });
    FX.fade = 0;
    showBanner(st.area.name);
  }
  const objAt = (x, y) => (areaView ? areaView.objects.find(o => o.x === x && o.y === y) : null);
  const DEFAULT_GATES = 'RT~';  // サーバが 関門の文字を 送らない 古い版の時だけ 使う
  function canWalk(x, y, dir) {
    const a = areaView;
    if (!a || y < 0 || y >= a.map.length || x < 0 || x >= a.map[0].length) return false;
    if ((a.blocked || []).some(([bx, by]) => bx === x && by === y)) return false;  // 建物の壁
    const o = objAt(x, y);
    if (o && o.kind !== 'exit') return false;
    if (o && o.closed) return false;  // 条件を 満たしていない出口（サーバと同じ判定。歩き出してから 戻さない）
    if (o && o.building && dir !== 'up') return false;  // 建物は 正面（下から上へ）だけ 入れる
    const ch = a.map[y][x];
    if (ch === '#' || ch === 'D') return false;  // 'D' は カウンター（サーバの passable と同じ）
    if ((a.gates || DEFAULT_GATES).includes(ch)) return a.unlocked.includes(ch);
    return true;
  }
  function walkAnim(tx, ty, dir) {
    const x0 = P.x, y0 = P.y, x1 = tx * 16, y1 = ty * 16;
    P.stepN++;
    const pose = dir === 'up' || dir === 'down' ? (P.stepN % 2 ? 1 : 3) : 1;
    return tween(180, t => { P.x = x0 + (x1 - x0) * t; P.y = y0 + (y1 - y0) * t; P.frame = t < 0.65 ? pose : 0; });
  }
  const freeField = () => scene === 'field' && !busy && N && !N.battle && !N.prompt && ui.sub === 'main' && !MSG.pages;
  async function stepMove(dir) {
    if (!freeField()) return false;
    P.facing = dir;
    const [dx, dy] = DIRS[dir];
    const tx = N.player.x + dx, ty = N.player.y + dy;
    const ok = canWalk(tx, ty, dir);
    const walkP = ok ? walkAnim(tx, ty, dir) : Promise.resolve();
    const old = N;
    let res;
    try { res = await api({ op: 'move', direction: dir }); } catch (e) { await walkP; snapP(); return false; }
    await walkP;
    const raw = res.messages;
    const blocked = raw.some(m => /進めない|ふさいで|広がっている|今は 先へ/.test(m)) || raw.some(m => /^目の前に .+がある/.test(m));
    if (blocked) Snd.se('bump');
    const shown = raw.map(cleanMsg).filter(m => m && !isNoise(m));
    if (!shown.length && !res.error && !res.state.battle && res.state.area.id === areaView.id) {
      N = res.state;
      areaView = N.area;  // 出口の 開き閉じ（closed）も サーバの最新に そろえる
      if (N.player.x * 16 !== P.x || N.player.y * 16 !== P.y) snapP();
      P.facing = dir;
      // 歩数・朝昼夜・HP は 歩くたびに 変わるので、とけい／なかまの ページだけ 描き直す（メモ・コインは 触らない）
      const pg = gadgetPages()[ui.gpage || 0];
      if (ui.sub === 'main' && pg && (pg[0] === 'clock' || pg[0] === 'mons')) renderPanel();
      return ok && !blocked;
    }
    setBusy(true);
    await present(res, old);
    setBusy(false);
    return false;
  }
  let holdDir = null;
  async function walkLoop(d) {
    if (walking) return;
    walking = true;
    while (holdDir === d && freeField()) {
      const r = await stepMove(d);
      if (!r) break;
    }
    walking = false;
    if (holdDir && holdDir !== d && freeField()) walkLoop(holdDir);
  }
  function facingObj() {
    const [dx, dy] = DIRS[P.facing];
    const fx = N.player.x + dx, fy = N.player.y + dy;
    const a = areaView;
    let o = objAt(fx, fy);
    if (!o && a.interior && a.map[fy] && a.map[fy][fx] === 'D') o = objAt(fx + dx, fy + dy); // カウンター越し
    return o;
  }
  function fieldA() {
    if (!freeField()) return;
    const o = facingObj();
    if (!o || o.kind === 'exit') return;
    if (!['tablet', 'box', 'item', 'static'].includes(o.kind) && !o.sign) npcFace[`${o.x},${o.y}`] = { dir: OPP[P.facing], until: T + 5000 };
    Snd.se('cursor');
    act({ op: 'interact' });
  }

  function tileCh(a, x, y, exits) {
    if (y < 0 || y >= a.map.length || x < 0 || x >= a.map[0].length) return '#';
    const ch = a.map[y][x];
    if (exits.has(x + ',' + y) && !a.cave) return a.interior ? 'm' : 'p';
    if (ch !== '~' && (a.gates || DEFAULT_GATES).includes(ch) && a.unlocked.includes(ch)) return a.cave ? ':' : '.';
    return ch;
  }
  function drawField() {
    const a = areaView;
    if (!a) return;
    const mh = a.map.length, mw = a.map[0].length;
    let cx = P.x + 8 - W / 2, cy = P.y + 8 - H / 2 + 8;
    cx = mw * 16 <= W ? (mw * 16 - W) / 2 : clamp(cx, 0, mw * 16 - W);
    cy = mh * 16 <= H ? (mh * 16 - H) / 2 : clamp(cy, 0, mh * 16 - H);
    cx = Math.round(cx); cy = Math.round(cy);
    const env = a.interior ? 'indoor' : a.cave ? 'cave' : 'field';
    const exits = new Set(a.objects.filter(o => o.kind === 'exit' && !o.building).map(o => o.x + ',' + o.y));
    const gf = Math.floor(T / 450), wf = Math.floor(T / 260);
    for (let ty = Math.floor(cy / 16); ty <= Math.floor((cy + H) / 16); ty++) {
      for (let tx = Math.floor(cx / 16); tx <= Math.floor((cx + W) / 16); tx++) {
        if (a.interior && (ty < 0 || ty >= mh || tx < 0 || tx >= mw)) {
          g.fillStyle = '#000'; g.fillRect(tx * 16 - cx, ty * 16 - cy, 16, 16); continue;
        }
        const ch = tileCh(a, tx, ty, exits);
        const v = ((tx * 31 + ty * 17) >>> 0) & 0xffff;
        g.drawImage(Art.tile(ch, env, v, ch === ',' ? gf : ch === '~' ? wf : 0), tx * 16 - cx, ty * 16 - cy);
      }
    }
    // 人・建物は y 順に
    const ents = [];
    for (const o of a.objects) {
      if (o.kind === 'exit' && !o.building) continue;
      const sx = o.x * 16 - cx, sy = o.y * 16 - cy;
      if (o.building) {
        const c = Art.building(o.building);
        ents.push({ y: o.y + 0.5, draw: () => g.drawImage(c, sx + 8 - c.width / 2, sy + 16 - c.height + 3) });
      } else if (o.kind === 'tablet') {
        ents.push({ y: o.y, draw: () => g.drawImage(Art.tablet(), sx, sy - 4) });
      } else if (o.kind === 'box') {
        ents.push({ y: o.y, draw: () => g.drawImage(Art.box(), sx, sy - 4) });
      } else if (o.kind === 'item') {
        ents.push({ y: o.y, draw: () => g.drawImage(Art.sparkle(Math.floor(T / 420) % 2), sx, sy - 4) });
      } else if (o.kind === 'static') {
        const bob = Math.round(Math.sin(T / 380));
        ents.push({ y: o.y, draw: () => { shadow(sx + 8, sy + 15); g.drawImage(monSprite(o.species, false, false), sx - 8, sy - 16 + bob, 32, 32); } });
      } else if (o.sign) {
        ents.push({ y: o.y, draw: () => g.drawImage(Art.signpost(), sx, sy - 4) });
      } else {
        const key = `${o.x},${o.y}`;
        const style = Art.styleFor(o.trainer || o.person || o.label + o.x + o.y);
        let dir = 'down';
        const f = npcFace[key];
        if (f && f.until > T) dir = f.dir;
        else if (o.kind === 'npc') dir = ['down', 'left', 'down', 'right', 'up', 'down'][Art.hash(key + Math.floor(T / 2600)) % 6];
        ents.push({ y: o.y, draw: () => { shadow(sx + 8, sy + 15); g.drawImage(Art.person(style, dir, 0), sx, sy - 5); } });
      }
    }
    const px = Math.round(P.x) - cx, py = Math.round(P.y) - cy;
    ents.push({ y: P.y / 16 + 0.1, draw: () => { shadow(px + 8, py + 15); g.drawImage(Art.person(Art.HERO, P.facing, P.frame), px, py - 5); } });
    ents.sort((p, q) => p.y - q.y).forEach(e => e.draw());
    // 草むらに立つと足元が隠れる
    const ptx = Math.round(P.x / 16), pty = Math.round(P.y / 16);
    if (tileCh(a, ptx, pty, exits) === ',' && Math.abs(P.x - ptx * 16) < 4 && Math.abs(P.y - pty * 16) < 4) {
      g.drawImage(Art.tile(',', env, ((ptx * 31 + pty * 17) >>> 0) & 0xffff, gf), 0, 9, 16, 7, ptx * 16 - cx, pty * 16 - cy + 9, 16, 7);
    }
    // 時間帯と天気
    const ph = N && N.phase;
    if (!a.cave && !a.interior && ph === '夜') { g.fillStyle = 'rgba(12,20,70,.40)'; g.fillRect(0, 0, W, H); }
    if (!a.cave && !a.interior && ph === '朝') { g.fillStyle = 'rgba(255,190,120,.10)'; g.fillRect(0, 0, W, H); }
    if (a.cave) {
      const gr = g.createRadialGradient(px + 8, py + 6, 30, px + 8, py + 6, 170);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.55)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    if (a.weather === 'fog') drawFog();
  }
  function shadow(x, y) { g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(x, y, 6, 2.5, 0, 0, Math.PI * 2); g.fill(); }
  function drawFog() {
    g.fillStyle = 'rgba(225,230,238,.16)'; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 7; k++) {
      const x = ((T * 0.008 * (k % 3 + 1) + k * 83) % 400) - 70;
      g.fillStyle = 'rgba(235,240,245,.22)';
      g.beginPath(); g.ellipse(x, 18 + k * 26, 70, 14, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // 右上に いまいる 場所の名前を 常に出す（場所が 変わった時は 右から すべり込む）
  function drawBanner() {
    const name = areaView && areaView.name;
    if (!name) return;
    const e = FX.banner ? T - FX.banner.t0 : 1e9;
    const k = ease(clamp(e / 280, 0, 1));
    g.font = `11px ${FONT}`;
    const w = Math.max(56, g.measureText(name).width + 16);
    const x = W - 4 - w + (1 - k) * (w + 8);
    rr(x, 4, w, 17, 3, 'rgba(58,36,20,.82)', '#f4e4c0', 1);
    text(name, x + w / 2, 16, { align: 'center', color: '#fff6dc', size: 11 });
  }

  // ================= 戦闘の描画 =================
  function hpBar(x, y, w, r) {
    rr(x - 1, y - 1, w + 2, 6, 2, '#2c3242');
    g.fillStyle = '#4a5060'; g.fillRect(x, y, w, 4);
    const col = r > 0.5 ? '#48d060' : r > 0.2 ? '#f0c030' : '#f05038';
    const pw = Math.max(0, Math.round(w * clamp(r, 0, 1)));
    g.fillStyle = col; g.fillRect(x, y, pw, 4);
    g.fillStyle = 'rgba(255,255,255,.45)'; g.fillRect(x, y, pw, 1);
  }
  function statusTag(s, x, y) {
    if (!s) return;
    g.font = `8px ${FONT}`;
    const w = g.measureText(s).width + 6;
    rr(x, y - 7, w, 9, 2, '#c05050');
    text(s, x + 3, y, { size: 8, color: '#fff' });
  }
  function drawMon(o, x, y, size, back) {
    if (!o || !o.visible) return;
    if (o.blink && Math.floor(T / 70) % 2) return;
    const c = monSprite(o.sid, back, o.shiny);
    const s = o.scale, dw = size * s, dh = size * s;
    const bob = !busy && !back ? Math.round(Math.sin(T / 380)) : 0;
    const dx = Math.round(x + o.dx + (size - dw) / 2), dy = Math.round(y + o.dy + (size - dh) + bob + o.sink * size);
    g.save();
    if (o.sink > 0) { g.beginPath(); g.rect(x - 30, 0, size + 60, y + size - 2); g.clip(); }
    g.drawImage(c, dx, dy, dw, dh);
    if (o.white > 0) { g.globalAlpha = o.white; g.drawImage(silhouette(c, '#ffffff'), dx, dy, dw, dh); }
    g.restore();
  }
  function drawBattle() {
    if (!B) return;
    const a = N && N.area, night = N && N.phase === '夜';
    const gr = g.createLinearGradient(0, 0, 0, H);
    if (a && a.cave) { gr.addColorStop(0, '#3a2c22'); gr.addColorStop(0.55, '#6a5440'); gr.addColorStop(1, '#4a3a2c'); }
    else if (night) { gr.addColorStop(0, '#141c40'); gr.addColorStop(0.5, '#34406a'); gr.addColorStop(0.52, '#2c4a38'); gr.addColorStop(1, '#1e3428'); }
    else { gr.addColorStop(0, '#8cc8f0'); gr.addColorStop(0.5, '#d4ecf4'); gr.addColorStop(0.52, '#a8d890'); gr.addColorStop(1, '#78b860'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (!(a && a.cave)) { // 遠景
      g.fillStyle = night ? 'rgba(30,50,40,.8)' : 'rgba(110,170,110,.55)';
      g.beginPath(); g.moveTo(0, 98);
      for (let x = 0; x <= W; x += 16) g.lineTo(x, 92 - 8 * Math.sin(x / 30) - 4 * Math.sin(x / 11));
      g.lineTo(W, 100); g.lineTo(0, 100); g.fill();
    }
    // 足場
    const plat = (x, y, rx, ry) => {
      g.fillStyle = a && a.cave ? '#8a7258' : '#9ad07a'; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = a && a.cave ? '#a88c6c' : '#bce49a'; g.beginPath(); g.ellipse(x, y - 2, rx - 6, ry - 3, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    };
    plat(188, 84, 48, 11);
    plat(66, 146, 60, 13);
    if (B.trainer && B.trainer.visible) {
      const bc = Art.boss && Art.boss(B.trainer.id);  // 道場主・ライバルは 専用の 立ち絵
      if (bc) g.drawImage(bc, 156 + B.trainer.dx, 6, 64, 80);
      else g.drawImage(Art.person(B.trainer.style, 'down', 0), 164 + B.trainer.dx, 25, 48, 60);
    }
    drawMon(B.enemy, 156, 22, 64, false);
    if (B.hero.visible) g.drawImage(Art.person(Art.HERO, 'up', 0), 40 + B.hero.dx, 88, 48, 60);
    drawMon(B.player, 24, 68, 80, true);
    if (B.ball) {
      const c = Art.ball(0, B.ball.kind);
      g.save(); g.translate(B.ball.x, B.ball.y); g.rotate(B.ball.rot);
      if (B.ball.dim) g.globalAlpha = 0.75;
      g.drawImage(c, -6, -6); g.restore();
    }
    drawParticles();
    // 相手の枠
    const e = B.enemy;
    if (e && (e.visible || B.kind === 'wild')) {
      rr(4, 6, 122, 32, 4, 'rgba(250,250,244,.96)', '#34404e', 1.5);
      text(e.name, 10, 19, { size: 11 });
      text(`Lv${e.level}`, 120, 19, { size: 10, align: 'right' });
      const es = e.status === 'ひんし' && e.hp > 0 ? null : e.status;  // HP が 減り切るまで ひんし は 出さない
      statusTag(es, 10, 33);
      if (!es) text('HP', 36, 34, { size: 8, color: '#e07a20' });  // 3文字の状態（ひんし・やけど 等）と 重ならないように
      hpBar(48, 28, 72, e.hp);
    }
    if (B.kind !== 'wild' && B.team.length > 1) {
      B.team.forEach((alive, i) => {
        g.fillStyle = alive ? '#f04848' : '#8a8a90';
        g.beginPath(); g.arc(12 + i * 9, 44, 3, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#2a2a30'; g.lineWidth = 1; g.stroke();
      });
    }
    // 自分の枠
    const p = B.player;
    if (p && p.visible) {
      rr(130, 100, 122, 42, 4, 'rgba(250,250,244,.96)', '#34404e', 1.5);
      text(p.name, 136, 113, { size: 11 });
      text(`Lv${p.level}`, 246, 113, { size: 10, align: 'right' });
      text('HP', 162, 124, { size: 8, color: '#e07a20' });
      hpBar(174, 118, 72, p.hp / Math.max(1, p.max_hp));
      text(`${Math.max(0, Math.round(p.hp))}/${p.max_hp}`, 246, 134, { size: 10, align: 'right' });
      statusTag(p.status === 'ひんし' && p.hp > 0 ? null : p.status, 136, 133);
      g.fillStyle = '#2c3242'; g.fillRect(136, 137, 110, 3);
      g.fillStyle = '#48a8f0'; g.fillRect(136, 137, Math.round(110 * clamp(p.exp || 0, 0, 1)), 3);
    }
    const w = N && N.battle && N.battle.weather;
    if (w) drawWeather(String(w));
  }
  function drawWeather(w) {
    if (/sand|砂/.test(w)) {
      g.fillStyle = 'rgba(210,180,110,.18)'; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(230,200,140,.8)';
      for (let k = 0; k < 50; k++) g.fillRect(((k * 53 + T * 0.25) % 280) - 12, (k * 37 + T * 0.03) % 150, 3, 1);
    } else if (/snow|hail|雪|霰/.test(w)) {
      g.fillStyle = '#ffffff';
      for (let k = 0; k < 40; k++) g.fillRect((k * 47 + Math.sin(T / 600 + k) * 6 + 256) % 256, (k * 29 + T * 0.04) % 150, 2, 2);
    } else if (/rain|雨/.test(w)) {
      g.strokeStyle = 'rgba(180,200,255,.6)'; g.lineWidth = 1;
      for (let k = 0; k < 40; k++) { const x = (k * 41 + T * 0.05) % 256, y = (k * 23 + T * 0.4) % 150; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 2, y + 6); g.stroke(); }
    } else if (/fog|霧/.test(w)) drawFog();
    else if (/sun|晴/.test(w)) { g.fillStyle = 'rgba(255,220,120,.12)'; g.fillRect(0, 0, W, H); }
  }
  function drawParticles() {
    for (const p of particles) {
      const k = 1 - p.life / p.max;
      g.globalAlpha = clamp(k, 0, 1);
      g.fillStyle = p.color;
      if (p.kind === 'star') {
        const s = p.size + 1;
        g.fillRect(p.x - s, p.y, s * 2 + 1, 1); g.fillRect(p.x, p.y - s, 1, s * 2 + 1);
      } else g.fillRect(p.x, p.y, p.size, p.size);
    }
    g.globalAlpha = 1;
  }

  // ================= その他の場面 =================
  const STARS = Array.from({ length: 46 }, (_, i) => { const r = Art.rng(i * 977 + 13); return { x: r() * W, y: r() * 110, s: r() < 0.2 ? 2 : 1, p: r() * 6 }; });
  function drawTitle() {
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#0e1634'); gr.addColorStop(0.55, '#2a4a8a'); gr.addColorStop(1, '#7aa8d8');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (const s of STARS) { g.globalAlpha = 0.5 + 0.5 * Math.sin(T / 500 + s.p); g.fillStyle = '#fff'; g.fillRect(s.x, s.y, s.s, s.s); }
    g.globalAlpha = 1;
    g.fillStyle = '#1e3a4a';
    g.beginPath(); g.moveTo(0, 150);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, 132 - 14 * Math.sin(x / 40) - 6 * Math.sin(x / 13));
    g.lineTo(W, H); g.lineTo(0, H); g.fill();
    g.fillStyle = '#2a5a3a'; g.fillRect(0, 160, W, 32);
    g.fillStyle = '#3a7a4a'; g.fillRect(0, 160, W, 2);
    // ロゴ
    const bob = Math.sin(T / 700) * 2;
    text('モンスター', 128, 52 + bob, { size: 30, align: 'center', color: '#ffd84a', outline: '#3a1a08', lw: 5 });
    text('ＲＰＧ', 128, 88 + bob, { size: 30, align: 'center', color: '#ff6a4a', outline: '#3a1a08', lw: 5 });
    text('むすんで 育てて 旅に出よう', 128, 108, { size: 10, align: 'center', color: '#dce8ff', outline: '#10183a', lw: 3 });
    for (const p of parade) {
      const y = 158 - 44 + Math.abs(Math.sin(T / 180 + p.ph)) * -3;
      g.drawImage(monSprite(p.sid, false, false), Math.round(p.x), Math.round(y), 44, 44);
    }
    if (Math.floor(T / 600) % 2) text('▼ 下の画面を タッチ', 128, 184, { size: 10, align: 'center', color: '#fff', outline: '#10183a', lw: 3 });
  }
  function drawStarter() {
    const gr = g.createLinearGradient(0, 0, 0, 100);
    gr.addColorStop(0, '#f4e8cc'); gr.addColorStop(1, '#dcc8a0');
    g.fillStyle = gr; g.fillRect(0, 0, W, 100);
    for (let y = 100; y < H; y += 16) for (let x = 0; x < W; x += 16) { g.fillStyle = ((x + y) / 16) % 2 ? '#c8a878' : '#b8986a'; g.fillRect(x, y, 16, 16); }
    // 本棚と窓
    for (const bx of [8, 200]) {
      rr(bx, 18, 48, 66, 2, '#7a4a28');
      for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) { g.fillStyle = ['#c84848', '#4870c8', '#48a060', '#d8b040'][(k + r) % 4]; g.fillRect(bx + 4 + k * 7, 24 + r * 20, 5, 14); }
    }
    rr(96, 16, 64, 36, 2, '#8ac8f0', '#6a4a30', 3);
    g.fillStyle = '#6a4a30'; g.fillRect(127, 16, 2, 36);
    text('博士の 研究所', 128, 72, { size: 11, align: 'center', color: '#5a3a1a' });
    rr(18, 104, 220, 28, 6, '#8a5a38', '#5a3a20', 2);
    const sp = N && N.prompt && N.prompt.species || [];
    sp.forEach((sid, i) => {
      if (ST.chosen !== null && ST.chosen !== i) return;
      const x = ST.chosen !== null ? 128 : 52 + i * 76;
      const sel = ST.chosen !== null || i === ST.sel;
      g.fillStyle = sel ? '#ffe070' : '#d8d0c0'; g.beginPath(); g.ellipse(x, 116, 22, 7, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#6a5a40'; g.lineWidth = 1; g.stroke();
      const jump = sel ? Math.abs(Math.sin(T / 200)) * -5 : 0;
      g.drawImage(monSprite(sid, false, false), x - 28, 62 + jump, 56, 56);
    });
    drawParticles();
  }
  function drawProf() {  // 博士の 導入: 明るい 無地の 背景に 1人（1匹）ずつ 出す
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#fbf6e8'); gr.addColorStop(1, '#cfdcec');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(60,70,110,.16)'; g.beginPath(); g.ellipse(128, 137, 34, 7, 0, 0, Math.PI * 2); g.fill();
    const d = introData();
    if (!d || !PF.show) return;
    const k = clamp((T - PF.t0) / 280, 0, 1), dx = Math.round((1 - k) * 60);
    g.globalAlpha = k;
    if (PF.show === 'monster' && profMon(d)) {
      const hop = Math.abs(Math.sin(T / 260)) * -3;
      g.drawImage(monSprite(d.monster, false, false), 96 + dx, 74 + hop, 64, 64);
    } else {
      const c = PF.show === 'player' ? Art.person(Art.HERO, 'down', 0)
        : PF.show === 'rival' ? Art.boss('rival_1') || Art.person(Art.styleFor('rival'), 'down', 0)
        : Art.person(Art.styleFor('lab'), 'down', 0);
      g.drawImage(c, 96 + dx, 58, 64, 80);
    }
    g.globalAlpha = 1;
  }
  function enterEvolve(nw) {
    const p = nw.prompt, m = nw.party[p.party];
    EV = { party: p.party, from: p.species, into: p.into || p.species, cur: p.species, phase: 'wait', t0: 0, shiny: m && m.shiny };
    scene = 'evolve';
    Snd.play(null);
  }
  function drawEvolve() {
    const gr = g.createRadialGradient(128, 70, 10, 128, 70, 200);
    gr.addColorStop(0, '#4a3a7a'); gr.addColorStop(1, '#0a0818');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.save(); g.translate(128, 72);
    for (let k = 0; k < 12; k++) {
      g.rotate(Math.PI / 6);
      g.fillStyle = `rgba(255,255,255,${EV && EV.phase === 'anim' ? 0.09 : 0.04})`;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(200, Math.sin(T / 900) * 20 - 14); g.lineTo(200, Math.sin(T / 900) * 20 + 14); g.fill();
    }
    g.restore();
    if (!EV) return;
    let sid = EV.cur, white = false;
    if (EV.phase === 'anim') {
      const e = performance.now() - EV.t0, t = clamp(e / 3200, 0, 1);
      const period = 520 - 470 * t;
      sid = Math.floor(e / period) % 2 ? EV.into : EV.from;
      white = true;
      if (Math.random() < 0.3) burst(128 + (Math.random() - 0.5) * 120, 72 + (Math.random() - 0.5) * 90, '#ffffff', 1, 0.3, 'star');
    }
    const c = monSprite(sid, false, EV.shiny);
    g.drawImage(white ? silhouette(c, '#ffffff') : c, 80, 22, 96, 96);
    drawParticles();
  }

  // ================= メインループ =================
  let last = performance.now();
  function update(dt) {
    T += dt;
    if (MSG.pages) MSG.shown = Math.min(pageLen(), MSG.shown + dt * 0.06);
    for (const p of particles) { p.life += dt; p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vy += 0.02 * dt / 16; }
    particles = particles.filter(p => p.life < p.max);
    for (const p of parade) { p.x += dt * 0.022; if (p.x > W + 10) { p.x = -60 - Math.random() * 40; p.sid = randomSid(); } }
  }
  function draw() {
    g.setTransform(SC, 0, 0, SC, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (scene === 'title') drawTitle();
    else if (scene === 'field') drawField();
    else if (scene === 'battle') drawBattle();
    else if (scene === 'starter') drawStarter();
    else if (scene === 'evolve') drawEvolve();
    else if (scene === 'prof') drawProf();
    else text('よみこみ中…', 128, 100, { align: 'center', color: '#fff' });
    if (FX.wipe > 0) {
      g.fillStyle = '#000';
      for (let k = 0; k < 12; k++) {
        const h = 16, w = W * FX.wipe;
        g.fillRect(k % 2 ? W - w : 0, k * h, w, h);
      }
    }
    if (scene === 'field') drawBanner();
    if (FX.fade > 0) { g.fillStyle = `rgba(0,0,0,${clamp(FX.fade, 0, 1)})`; g.fillRect(0, 0, W, H); }
    if (FX.flash > 0) { g.globalAlpha = clamp(FX.flash, 0, 1); g.fillStyle = FX.flashColor; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    if (scene !== 'title' && scene !== 'boot') drawMsg();
  }
  function frame(now) {
    const dt = Math.min(50, now - last);
    last = now;
    update(dt); draw();
    raf(frame);
  }

  // ================= 下画面 =================
  let selIdx = -1;
  function partyBtn(m, i, action, disabled, extra = '') {
    const r = m.hp / Math.max(1, m.max_hp);
    const col = r > 0.5 ? '#48d060' : r > 0.2 ? '#f0c030' : '#f05038';
    return `<button class="btn" data-a="${action}" data-i="${i}" ${disabled ? 'disabled' : ''}>
      <img src="${icon(m.species, m.shiny)}" alt="">
      <div class="mini-stat"><div class="l1"><span>${esc(m.name)}${extra}</span><span>Lv${m.level}</span></div>
      <div class="bar"><i style="width:${Math.round(r * 100)}%;background:${col}"></i></div>
      <div class="l1 note"><span>${m.status ? esc(m.status) : (m.hp <= 0 ? 'ひんし' : '')}</span><span>${m.hp}/${m.max_hp}</span></div></div></button>`;
  }
  const backBtn = (label = 'もどる') => `<button class="btn back" data-a="back">${label}</button>`;
  const pane = (inner, cls = '') => `<div class="pane ${cls}">${inner}</div>`;

  function renderPanel() {
    let html;
    if (scene === 'title' || scene === 'boot') html = titlePanel();
    else if (busy) html = `<div class="tapzone" data-a="adv"><div class="dot">▼</div><div class="note">タップで つぎへ</div></div>`;
    else if (scene === 'prof') html = profPanel();  // はじめからの 導入中は 前の記録の 戦闘・会話を 出さない
    else if (N.battle) html = battlePanel();
    else if (N.prompt) html = promptPanel();
    else html = fieldPanel();
    const pin = panel.querySelector('#pname');
    if (pin) ui.nameDraft = pin.value;  // 描き直しても 入力途中の 名前を 消さない
    panel.innerHTML = html;
    const pin2 = panel.querySelector('#pname');
    if (pin2 && !busy) { try { pin2.focus({ preventScroll: true }); const n = pin2.value.length; pin2.setSelectionRange(n, n); } catch (e) { /* 古いブラウザ */ } }
    selIdx = -1;
    setupMemo();
    // メニューを開いたら最初からカーソルを出す（十字キー＋A だけで遊べるように）。同じメニューなら前の位置を覚えておく
    // どのメニューも 前回選んだ項目に カーソルを合わせる（技・ムスビカゴを A 連打で 続けて出せるように）
    if (!busy && scene !== 'field' && scene !== 'starter' || (scene === 'field' && !busy && (N.battle || N.prompt || ui.sub !== 'main'))) {
      const key = menuKey();
      const list = menuButtons();
      const same = key === CURSOR.key;
      CURSOR.key = key;
      if (list.length) {
        const find = id => id ? list.findIndex(b => btnId(b) === id) : -1;
        let idx = same ? find(CURSOR.sel) : -1;  // 同じメニューの 描き直しなら 今の位置のまま
        if (idx < 0) idx = find(CURSOR.mem[key]);
        if (idx < 0) idx = list.findIndex(b => b.dataset.def);
        if (idx < 0) idx = Math.max(0, list.findIndex(b => !b.classList.contains('back') && !b.classList.contains('tab')));
        selIdx = idx;
        markSel(list);
      }
    } else CURSOR.key = '';
  }
  // カーソル記憶: メニューごとに 最後に選んだ ボタンを 覚える（もどる・個数の増減・ポケット切替は 覚えない）
  const CURSOR = { key: '', sel: null, mem: {} };
  const NOMEM = new Set(['back', 'adv', 'pocket', 'qm', 'qp', 'sound', 'boxtab']);
  const btnId = b => ['a', 'i', 'id', 's', 'p'].map(k => b.dataset[k] == null ? '' : b.dataset[k]).join('|');
  function menuKey() {
    const b = N && N.battle, pr = N && N.prompt;
    let k = `${scene}|${b ? 'b:' + b.kind + ':' + b.state : ''}|${pr ? pr.kind + ':' + (pr.kind === 'shop' || pr.kind === 'box' ? '' : pr.text || '') : ''}|${ui.sub}`;
    if (ui.sub === 'bag') k += '|' + (ui.pocket || 0);
    if (pr && pr.kind === 'box') k += '|' + (ui.boxTab || 0);
    if (b && (ui.sub === 'fight' || ui.sub === 'mdet')) { const me = N.party[b.player_index]; k += '|' + b.player_index + ':' + (me ? me.name : ''); }
    return k;
  }
  function rememberBtn(b) { if (b && CURSOR.key && !NOMEM.has(b.dataset.a)) CURSOR.mem[CURSOR.key] = btnId(b); }
  // バッグの ポケットも 場面ごとに覚える（野生戦は 最初 ムスビカゴ）
  const POCKMEM = {};
  // ショップで 一度に買える数: 払える数まで（大事なものは 1個だけ）
  const shopMax = it => it.kind === 'key' ? 1 : Math.max(1, Math.min(99, Math.floor(N.money / Math.max(1, it.price))));

  // 名前の入力（タイトルの「はじめる」「はじめから」「つづきから」と、トレーナーカードの「なまえを かえる」で共通）
  function namePane() {
    const q = { card: 'あたらしい なまえを 入れてね（8文字まで）', rival: 'ライバルの あたらしい なまえを 入れてね（8文字まで）',
      prof_rival: 'ライバルの なまえを 入れてね（8文字まで）' }[ui.nameNext] || 'あなたの なまえを 入れてね（8文字まで）';
    const sub = ui.nameNext === 'cont' ? '<div class="note">いまの 記録には まだ なまえが ありません</div>' : '';
    return pane(`<div class="sheet" style="font-size:var(--fs)">${q}${sub}</div>
      <input id="pname" class="name-in" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="なまえ" value="${esc(ui.nameDraft || '')}">
      ${ui.nameErr ? `<div class="note name-err">${esc(ui.nameErr)}</div>` : ''}
      <div class="grid g2"><button class="btn big fight cmd" data-a="namego">きめる</button>${backBtn(ui.nameNext === 'cont' ? 'あとで' : 'もどる')}</div>`,
      scene === 'title' || scene === 'boot' ? 'title-bg' : '');
  }
  function openName(next, draft) {
    Snd.se('ok');
    ui.nameNext = next; ui.nameDraft = draft || ''; ui.nameErr = '';
    ui.sub = 'name';
    renderPanel();
  }

  function titlePanel() {
    if (!N || !DEX) return pane('<div class="note">よみこみ中…</div>', 'center title-bg');
    if (ui.sub === 'name') return namePane();
    const has = N.party.length > 0;
    if (ui.sub === 'new1' || ui.sub === 'new2') {
      const q = ui.sub === 'new1' ? 'いまの 冒険の 記録を 消して はじめから 遊びますか？' : 'ほんとうに 消しますか？ もとには 戻せません。';
      return pane(`<div class="sheet" style="font-size:var(--fs)">${q}</div><div class="grid g2">
        <button class="btn big fight cmd" data-a="newyes">はい</button><button class="btn big run cmd" data-a="back">いいえ</button></div>`, 'title-bg');
    }
    if (!has) {
      return pane(`<div style="flex:1"></div><button class="btn big fight cmd" data-a="start">はじめる</button>
        <div class="note" style="text-align:center">毎回の 操作は ${window.MRPG_LOCAL ? 'この 端末' : 'PC'} に 自動で 記録されます</div><div style="flex:1"></div>`, 'title-bg');
    }
    const lead = N.party[0];
    return pane(`<button class="btn" data-a="cont" style="flex:1.4"><img src="${icon(lead.species, lead.shiny)}" alt="">
        <div class="mini-stat"><div class="l1"><b style="font-weight:normal;font-size:calc(var(--fs)*1.2)">つづきから</b><span>${esc(N.area.name)}</span></div>
        <div class="l1 note"><span>なまえ　${N.player_name ? esc(N.player_name) : '未設定'}</span></div>
        <div class="l1 note"><span>${esc(lead.name)} Lv${lead.level}${N.party.length > 1 ? ` ほか${N.party.length - 1}匹` : ''}</span><span>メダル ${N.medals.length}</span></div>
        <div class="l1 note"><span>図鑑 ${N.dex.caught}/${N.dex.seen}</span><span>${N.money}円</span></div></div></button>
      <button class="btn big" data-a="new" style="flex:0.8">はじめから</button>`, 'title-bg');
  }

  const STAT_LABEL = { atk: 'こうげき', def: 'ぼうぎょ', spa: 'とくこう', spd: 'とくぼう', spe: 'すばやさ' };
  function statLine(m) {
    if (!m.stats) return '';
    const nat = m.nature || {};
    const cells = Object.keys(STAT_LABEL).map(k => {
      const mark = nat.up === k ? '<b style="color:#d04030">↑</b>' : nat.down === k ? '<b style="color:#3060c0">↓</b>' : '';
      return `<span style="white-space:nowrap">${STAT_LABEL[k]} ${m.stats[k]}${mark}</span>`;
    }).join(' ');
    return `<div class="note" style="display:flex;flex-wrap:wrap;gap:0 .6em;line-height:1.35">
      <span style="white-space:nowrap">せいかく <b style="font-weight:normal;color:#28303c">${esc(nat.name || '？')}</b></span>${cells}</div>`;
  }

  // バッグはポケットごとに分ける（十字キーの左右かタブで切り替え）
  const POCKETS = [
    { name: 'かいふく', kinds: ['heal', 'cure', 'revive'] },
    { name: 'ムスビカゴ', kinds: ['capture'] },
    { name: 'わざの巻物', kinds: ['scroll'] },
    { name: 'そだてる', kinds: ['evolution', 'level_up'] },
    { name: 'たいせつなもの', kinds: ['key'] },
  ];
  function bagPane(usable, action, notes, headR) {
    const p = ui.pocket = (ui.pocket || 0) % POCKETS.length;
    POCKMEM[N.battle ? 'b:' + N.battle.kind : 'f'] = p;
    const tabs = POCKETS.map((pk, i) => `<button class="btn tab ${i === p ? 'cur' : ''}" data-a="pocket" data-p="${i}">${pk.name}</button>`).join('');
    const items = N.items.filter(it => POCKETS[p].kinds.includes(it.kind)).map(it =>
      `<button class="btn" data-a="${action}" data-id="${esc(it.id)}" ${usable(it) ? '' : 'disabled'}>
        <span class="grow">${esc(it.name)}<br><span class="note">${esc(it.desc)}</span></span><span class="sub">${it.id === 'wakeai_suzu' ? (N.wakeai_on ? 'ON' : 'OFF') : '×' + it.count}</span></button>`).join('');
    return pane(`<div class="head"><b>バッグ　◀ ${POCKETS[p].name} ▶</b><span>${headR}</span></div>
      <div class="tabs">${tabs}</div>
      <div class="list">${items || '<div class="note">このポケットは からっぽ</div>'}</div>
      ${notes[p] ? `<div class="note">${notes[p]}</div>` : ''}${backBtn()}`);
  }
  const dexOrder = () => Object.keys(DEX.species).sort((a, b) => (DEX.species[a].no || 999) - (DEX.species[b].no || 999));

  function fieldPanel() {
    const me = N.party;
    switch (ui.sub) {
      case 'party':
        return pane(`<div class="head"><b>モンスター</b><span>ボックス ${N.box_count}匹</span></div>
          <div class="list">${me.map((m, i) => partyBtn(m, i, 'mon', false)).join('') || '<div class="note">まだ 仲間が いない</div>'}</div>${backBtn()}`);
      case 'mon': {
        const m = me[ui.i];
        if (!m) { ui.sub = 'party'; return fieldPanel(); }
        const moves = m.moves.map(mv => `<div class="btn move" style="background:linear-gradient(180deg,${Art.rgb(Art.light(Art.typeColor(mv.type), 0.1))},${Art.rgb(Art.dark(Art.typeColor(mv.type), 0.25))})">
          <span>${esc(mv.name)}</span><div class="row"><span>${esc(mv.type)}</span><span>PP ${mv.pp}/${mv.max_pp}</span></div></div>`).join('');
        return pane(`<div class="row2" style="align-items:center"><img src="${icon(m.species, m.shiny)}" style="flex:0 0 auto;width:calc(var(--fs)*3.4);image-rendering:pixelated" alt="">
          <div class="mini-stat"><div class="l1"><b style="font-weight:normal">${esc(m.name)}</b><span>Lv${m.level}</span></div>
          <div>${typeTags(m.types)} ${m.status ? `<span class="tag" style="background:#c05050">${esc(m.status)}</span>` : ''}</div>
          <div class="bar"><i style="width:${Math.round(100 * m.hp / Math.max(1, m.max_hp))}%"></i></div>
          <div class="l1 note"><span>HP ${m.hp}/${m.max_hp}</span><span>つぎのLvまで</span></div>
          <div class="bar exp"><i style="width:${Math.round(100 * (m.exp_ratio || 0))}%"></i></div></div></div>
          ${statLine(m)}
          <div class="note">もちもの: ${m.held ? esc(m.held.name) : 'なし'}</div>
          <div class="grid g2">${moves}</div>
          <div class="row2">${ui.i > 0 ? '<button class="btn big" data-a="lead">先頭にする</button>' : ''}<button class="btn" data-a="hold">持たせる</button>${m.held ? '<button class="btn" data-a="unhold">あずかる</button>' : ''}${backBtn()}</div>`);
      }
      case 'holdPick': {
        const m = me[ui.i];
        if (!m) { ui.sub = 'party'; return fieldPanel(); }
        const evo = N.items.filter(it => it.kind === 'evolution');
        const list = evo.map(it => `<button class="btn" data-a="holdpick" data-id="${esc(it.id)}"><span>${esc(it.name)}</span><span>×${it.count}</span></button>`).join('');
        return pane(`<div class="head"><b>${esc(m.name)}に 持たせる</b></div>
          <div class="note">持たせられるのは 進化の道具だけ</div>
          <div class="list">${list || '<div class="note">持たせられる 道具が ない</div>'}</div>${backBtn()}`);
      }
      case 'bag':
        return bagPane(it => (['heal', 'cure', 'revive', 'scroll', 'evolution', 'level_up'].includes(it.kind) && me.length > 0) || (it.id === 'tabichizu' && N.world) || it.id === 'wakeai_suzu', 'item',
          ['', 'ムスビカゴは 野生の モンスターとの 戦闘中に 使う', '巻物は ここで 仲間に 技を 覚えさせる', '追憶の栞は ここで 仲間に 使う／進化の道具は 手持ちの 画面から 持たせる', 'たびの地図は 選ぶと 広げられる／わけあいの鈴は 選ぶと ON・OFF'], `${N.money}円`);
      case 'dex': {
        const seen = new Set(N.dex.seen_ids || []), caught = new Set(N.dex.caught_ids || []);
        const rows = dexOrder().map(sid => {
          const s = DEX.species[sid], no = `No.${String(s.no || 0).padStart(3, '0')}`;
          if (!seen.has(sid)) return `<button class="btn dexrow" disabled><span class="dexno">${no}</span><span class="grow">？？？？？</span></button>`;
          return `<button class="btn dexrow" data-a="dexe" data-id="${sid}"><span class="dexno">${no}</span>
            <img src="${icon(sid)}" alt=""><span class="grow">${esc(s.name)}</span><span class="dexmark ${caught.has(sid) ? 'on' : ''}">${caught.has(sid) ? '●' : '○'}</span></button>`;
        }).join('');
        return pane(`<div class="head"><b>ずかん</b><span>見た ${N.dex.seen}　捕まえた ${N.dex.caught}</span></div>
          <div class="list">${rows}</div>${backBtn()}`);
      }
      case 'dexE': {
        const sid = ui.dexId, s = DEX.species[sid];
        if (!s) { ui.sub = 'dex'; return fieldPanel(); }
        const got = (N.dex.caught_ids || []).includes(sid);
        const text = got ? esc((N.dex.entries || {})[sid] || '') : 'まだ 捕まえていないので くわしい 記録が ない。';
        const hab = (N.dex.habitats || {})[sid] || [];
        const habLine = `<div class="note" style="margin-top:4px">すみか: ${hab.length ? hab.map(esc).join('・') : '不明'}</div>`;
        return pane(`<div class="head"><b>No.${String(s.no || 0).padStart(3, '0')}　${esc(s.name)}</b><span>${got ? '捕まえた' : '見た'}</span></div>
          <div class="row2" style="align-items:center;flex:1;min-height:0">
            <img src="${icon(sid)}" alt="" style="width:calc(var(--fs)*5.5);image-rendering:pixelated;flex:0 0 auto">
            <div class="sheet" style="flex:1;align-self:stretch;overflow:auto"><div>${typeTags(s.types)}</div>
            ${habLine}<div style="margin-top:4px;line-height:1.5">${text}</div></div></div>${backBtn()}`);
      }
      case 'card': {
        const medals = Array.from({ length: N.medal_total || N.medals.length }, (_, i) => `<div class="medal ${i < N.medals.length ? '' : 'off'}" title="${esc(N.medals[i] || '')}"></div>`).join('');
        const lead = me[0];
        return pane(`<div class="head"><b>トレーナーカード</b><span>${esc(N.area.name)}</span></div>
          <div class="sheet tcard">${lead ? `<img src="${icon(lead.species, lead.shiny)}" alt="" style="float:right;width:calc(var(--fs)*3);image-rendering:pixelated">` : ''}
          <div>なまえ　${N.player_name ? esc(N.player_name) : '未設定'}</div>
          <div>ライバル　${esc(N.rival_name || '')}</div>
          <div>おこづかい　${N.money}円</div><div>ずかん　${N.dex.caught}匹</div><div>ボックス　${N.box_count}匹</div>
          <div class="note">${esc(N.phase)}</div><div style="clear:both"></div>
          <div class="note" style="margin-top:4px">メダル ${N.medals.length}/${N.medal_total || N.medals.length}</div><div class="medals" style="margin:4px 0 0">${medals}</div></div>
          <div class="grid g2 foot"><button class="btn" data-a="rename">なまえを かえる</button><button class="btn" data-a="rerival">ライバルの なまえ</button>${backBtn()}</div>`);
      }
      case 'name': {
        return namePane();
      }
      case 'config':
        return pane(`<div class="head"><b>せってい</b></div>
          <div class="list"><button class="btn big" data-a="sound">音　${Snd.muted ? 'OFF' : 'ON'}</button></div>${backBtn()}`);
      case 'bagT': {
        const it = N.items.find(x => x.id === ui.item);
        if (!it) { ui.sub = 'bag'; return fieldPanel(); }
        return pane(`<div class="head"><b>${esc(it.name)}</b><span>${it.kind === 'scroll' ? 'だれに 覚えさせる？' : 'だれに 使う？'}</span></div>
          <div class="list">${me.map((m, i) => partyBtn(m, i, 'useitem', false)).join('')}</div>${backBtn()}`);
      }
      case 'report':
        return pane(`<div class="head"><b>レポート</b><span>${esc(N.area.name)}</span></div>
          <div class="sheet"><div>${esc(N.area.name)}　メダル ${N.medals.length}　ずかん ${N.dex.caught}</div>
          <div class="note">冒険は 操作のたびに 自動で レポートに 書きこまれています</div></div>
          <div style="flex:1"></div><button class="btn big" data-a="totitle" style="flex:0 0 auto">タイトルへ もどる</button>${backBtn()}`);
      case 'map':
        if (!N.world) { ui.sub = 'bag'; return fieldPanel(); }
        return pane(`<div class="head"><b>たびの地図</b><span>いま ${esc(N.area.name)}</span></div>
          <div class="sheet wmap">${worldSvg(N.world)}</div>
          <div class="note">■ 街　● 道・洞窟　黄色が いま いる所</div>${backBtn()}`);
      case 'menu':
        // 並びはDSの携帯ゲームのメニューに合わせる（ずかん→モンスター→バッグ→カード→レポート→せってい）
        return pane(`<div class="head"><b>メニュー</b><span>${esc(N.area.name)}</span></div>
          <div class="grid g2 menu">
            <button class="btn cmd run" data-a="sub" data-s="dex">ずかん</button>
            <button class="btn cmd mon" data-a="sub" data-s="party">モンスター</button>
            <button class="btn cmd bag" data-a="sub" data-s="bag">バッグ</button>
            <button class="btn cmd card" data-a="sub" data-s="card">カード</button>
            <button class="btn cmd rep" data-a="sub" data-s="report">レポート</button>
            <button class="btn cmd cfg" data-a="sub" data-s="config">せってい</button>
          </div>${backBtn('とじる')}`);
      default:
        return gadgetPane();
    }
  }

  // たびの地図（屋外の つながりだけ。行ったことのない所は ？？？）
  function worldSvg(w) {
    const cs = w.cells || [], at = {};
    cs.forEach(c => { at[c.id] = c; });
    const c0 = cs.length ? Math.min(...cs.map(c => c.col)) : 0, r0 = cs.length ? Math.min(...cs.map(c => c.row)) : 0;
    const CW = 66, CH = 40, X = c => (c.col - c0) * CW + CW / 2, Y = c => (c.row - r0) * CH + CH / 2;
    const cols = Math.max(1, ...cs.map(c => c.col - c0 + 1)), rows = Math.max(1, ...cs.map(c => c.row - r0 + 1));
    const lines = (w.edges || []).map(([a, b]) => at[a] && at[b] && (at[a].visited || at[b].visited)
      ? `<line x1="${X(at[a])}" y1="${Y(at[a])}" x2="${X(at[b])}" y2="${Y(at[b])}" stroke="#7a8a9a" stroke-width="3" stroke-linecap="round"/>` : '').join('');
    const boxes = cs.map(c => {
      const fill = c.here ? '#ffd84a' : !c.visited ? '#c8d0d8' : c.town ? '#f0b070' : '#a8d898';
      return `<rect x="${X(c) - 29}" y="${Y(c) - 12}" width="58" height="24" rx="${c.visited && c.town ? 3 : 11}" fill="${fill}" stroke="${c.here ? '#b08a10' : '#4a5a6a'}" stroke-width="${c.here ? 2.5 : 1.2}"/>
        <text x="${X(c)}" y="${Y(c) + 3.5}" font-size="9.5" text-anchor="middle" fill="${c.visited ? '#1c2030' : '#6a7480'}" font-family="DotGothic16, sans-serif">${esc(c.name)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${cols * CW} ${rows * CH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="たびの地図">${lines}${boxes}</svg>`;
  }

  // たびの手帳: 下画面の ふだんの表示。ページを 切り替えて 使う小さな道具（メニューは ☰ から）
  const MEMO = { strokes: [] };
  function gadgetPages() {
    const pg = [['clock', 'とけい'], ['mons', 'なかま'], ['memo', 'メモ'], ['coin', 'コイン']];
    if (N.world) pg.push(['map', 'ちず']);
    return pg;
  }
  function gadgetPane() {
    const pages = gadgetPages();
    const gi = ui.gpage = Math.min(ui.gpage || 0, pages.length - 1);
    const tabs = pages.map(([, nm], i) => `<button class="btn tab ${i === gi ? 'cur' : ''}" data-a="gpage" data-p="${i}">${nm}</button>`).join('');
    const warn = N.warning ? `<div class="note" style="color:#b04030">${esc(N.warning)}</div>` : '';
    let body = '';
    switch (pages[gi][0]) {
      case 'clock': {
        const ck = N.clock || { phases: ['朝', '昼', '夜'], index: 0, left: 0, per: 1 };
        const nx = ck.phases[(ck.index + 1) % ck.phases.length];
        const phs = ck.phases.map((p, i) => `<span class="ph ${i === ck.index ? 'cur' : ''} ${p === '夜' ? 'night' : ''}">${esc(p)}</span>`).join('');
        body = `<div class="phases">${phs}<span class="big" style="margin-left:auto">${esc(ck.phases[ck.index])}</span></div>
          <div class="note">${esc(nx)}まで あと ${ck.left}歩</div>
          <div class="bar exp"><i style="width:${Math.round(100 * (ck.per - ck.left) / Math.max(1, ck.per))}%"></i></div>
          <div class="note" style="margin-top:2px">あるいた 歩数　${N.steps || 0}歩</div>
          <div class="note">メダル ${N.medals.length}/${N.medal_total || N.medals.length}　Lv${N.obey_cap || '？'}までの 子が したがう</div>
          <div class="note">${N.money}円　ずかん ${N.dex.caught}/${N.dex.seen}</div>`;
        break;
      }
      case 'mons':
        body = `<div class="gmons">${N.party.map((m, i) => {
          const r = m.hp / Math.max(1, m.max_hp), col = r > 0.5 ? '#48d060' : r > 0.2 ? '#f0c030' : '#f05038';
          return `<button class="btn" data-a="mon" data-i="${i}"><img src="${icon(m.species, m.shiny)}" alt="">
            <div class="mini-stat"><div class="l1"><span>${esc(m.name)}</span><span>${m.level}</span></div>
            <div class="bar"><i style="width:${Math.round(r * 100)}%;background:${col}"></i></div>
            <div class="l1"><span>${m.status ? esc(m.status) : m.hp <= 0 ? 'ひんし' : ''}</span><span>${m.hp}/${m.max_hp}</span></div></div></button>`;
        }).join('') || '<div class="note">まだ 仲間が いない</div>'}</div>`;
        break;
      case 'memo':
        body = `<canvas id="memo"></canvas><button class="btn memo-clr" data-a="memoclr">けす</button>`;
        break;
      case 'coin': {
        const cn = ui.coin || { face: '', n: 0, run: 0 };
        body = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
          <button class="coin ${cn.face === 'うら' ? 'ura' : ''} ${ui.coinAnim ? 'flip' : ''}" data-a="coin">${cn.face ? esc(cn.face) : 'タップ'}</button>
          <div class="note">${cn.n ? `${cn.n}回め　${cn.run}回 つづけて ${esc(cn.face)}` : 'コインを 投げて おもて・うらを 決める'}</div></div>`;
        ui.coinAnim = false;
        break;
      }
      case 'map':
        body = `<div class="wmap">${worldSvg(N.world)}</div>`;
        break;
    }
    return pane(`<div class="head"><b>${esc(N.area.name)}</b><span>たびの手帳</span></div>
      <div class="tabs" style="grid-template-columns:repeat(${pages.length},1fr)">${tabs}</div>
      <div class="sheet gadget">${body}</div>
      <div class="row2"><button class="btn cmd cfg" data-a="menu" style="min-height:calc(var(--fs)*1.9)">☰ メニュー</button>
      <button class="btn cmd fight" data-a="talk" style="min-height:calc(var(--fs)*1.9)">しらべる</button></div>${warn}`);
  }
  // メモ帳: 指で 描ける（この画面を 開いている間だけ。描いた線は 旅の間 残る）
  function setupMemo() {
    const cvm = panel.querySelector('#memo');
    if (!cvm) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), r = cvm.getBoundingClientRect();
    cvm.width = Math.max(1, Math.round(r.width * dpr)); cvm.height = Math.max(1, Math.round(r.height * dpr));
    const x = cvm.getContext('2d');
    x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#2a3040'; x.lineWidth = 2.5 * dpr;
    const pt = e => { const b = cvm.getBoundingClientRect(); return [(e.clientX - b.left) / Math.max(1, b.width), (e.clientY - b.top) / Math.max(1, b.height)]; };
    const line = (a, b) => { x.beginPath(); x.moveTo(a[0] * cvm.width, a[1] * cvm.height); x.lineTo(b[0] * cvm.width, b[1] * cvm.height); x.stroke(); };
    MEMO.strokes.forEach(s => { for (let i = 1; i < s.length; i++) line(s[i - 1], s[i]); if (s.length === 1) line(s[0], s[0]); });
    let cur = null;
    cvm.addEventListener('pointerdown', e => { e.preventDefault(); cvm.setPointerCapture(e.pointerId); cur = [pt(e)]; MEMO.strokes.push(cur); line(cur[0], cur[0]); });
    cvm.addEventListener('pointermove', e => { if (!cur) return; const p = pt(e); line(cur[cur.length - 1], p); cur.push(p); });
    const end = () => { cur = null; if (MEMO.strokes.length > 400) MEMO.strokes.splice(0, MEMO.strokes.length - 400); };
    cvm.addEventListener('pointerup', end); cvm.addEventListener('pointercancel', end);
  }
  function toggleMenu() {
    Snd.init();
    if (scene !== 'field' || busy || !N || N.battle || N.prompt || MSG.pages) return;
    if (ui.sub === 'main') { Snd.se('ok'); ui.sub = 'menu'; renderPanel(); }
    else { Snd.se('cursor'); ui.sub = 'main'; renderPanel(); }  // メニューの奥（モンスター・バッグ・ずかん等）からでも ☰ で閉じる
  }

  function moveDetail(mv) {
    if (!mv) return '';
    const c = Art.typeColor(mv.type);
    return `<div class="l1"><b>${esc(mv.name)}</b><span class="tchip" style="background:${Art.rgb(Art.dark(c, 0.15))}">${esc(mv.type)}</span></div>
      <div class="l1 note"><span>分類 ${esc(mv.cat || '—')}</span><span>威力 ${mv.power == null ? '—' : mv.power}</span>
      <span>命中 ${mv.acc == null ? '—' : mv.acc}</span><span>PP ${mv.pp}/${mv.max_pp}</span></div>
      <div class="note">${esc(mv.desc || '')}</div>`;
  }
  function battlePanel() {
    const b = N.battle, me = N.party[b.player_index];
    if (b.state === 'force_switch') {
      // 野生戦で 倒れた時は「次を出す」か「逃げる」を選べる（逃げるのは 必ず成功）
      const run = b.kind === 'wild' ? `<button class="btn cmd run" data-a="brun" style="flex:0 0 auto">逃げる</button>` : '';
      return pane(`<div class="head"><b>次に出す モンスター</b></div>
        <div class="list">${N.party.map((m, i) => partyBtn(m, i, 'bswitch', m.hp <= 0 || i === b.player_index)).join('')}</div>${run}`);
    }
    if (b.state === 'offer_switch') {
      // 入れ替え戦: 相手が 次を出す前に こちらだけ 交代できる
      if (ui.sub === 'oswitch') {
        return pane(`<div class="head"><b>入れ替える モンスター</b></div>
          <div class="list">${N.party.map((m, i) => partyBtn(m, i, 'bswitch', m.hp <= 0 || i === b.player_index, i === b.player_index ? '（戦闘中）' : '')).join('')}</div>${backBtn()}`);
      }
      return pane(`<div class="head"><b>${esc(me.name)}</b><span>Lv${me.level}　HP ${me.hp}/${me.max_hp}</span></div>
        <div class="grid g2">
          <button class="btn big cmd mon" data-a="sub" data-s="oswitch">入れ替える</button>
          <button class="btn big cmd fight" data-a="bkeep" data-def="1">そのまま 戦う</button>
        </div>`);
    }
    if (b.state !== 'choose') return pane('<div class="note">……</div>', 'center');
    switch (ui.sub) {
      case 'fight': {
        const moves = me.moves.map((mv, i) => {
          const c = Art.typeColor(mv.type);
          return `<button class="btn move" data-a="bmove" data-i="${i}" ${mv.pp <= 0 ? 'disabled' : ''}
            style="background:linear-gradient(180deg,${Art.rgb(Art.light(c, 0.12))},${Art.rgb(Art.dark(c, 0.25))});box-shadow:0 0 0 2px ${Art.rgb(Art.dark(c, 0.55))},0 3px 0 2px ${Art.rgb(Art.dark(c, 0.7))}">
            <span>${esc(mv.name)}</span><div class="row"><span>${esc(mv.type)}</span><span>PP ${mv.pp}/${mv.max_pp}</span></div></button>`;
        }).join('');
        return pane(`<div class="grid g2">${moves}</div><div class="grid g2 foot">
          <button class="btn" data-a="sub" data-s="mdet">くわしく</button>${backBtn()}</div>`);
      }
      case 'mdet': {
        // 技の くわしい説明（威力・命中・PP・説明。1回目で表示、同じ技を もう一度で 使う）
        const mi = Math.min(Math.max(0, ui.mi || 0), me.moves.length - 1);
        const list = me.moves.map((mv, i) => `<button class="btn" data-a="mdsel" data-i="${i}" ${i === mi ? 'data-def="1"' : ''}>
          <span>${esc(mv.name)}</span><span class="note">PP ${mv.pp}/${mv.max_pp}</span></button>`).join('');
        return pane(`<div class="sheet mdet" id="mdetSheet">${moveDetail(me.moves[mi])}</div>
          <div class="grid g2">${list}</div>${backBtn()}`);
      }
      case 'bag': {
        const wild = b.kind === 'wild';
        return bagPane(it => (it.kind === 'capture' && wild) || ['heal', 'cure', 'revive'].includes(it.kind), 'bitem',
          ['', wild ? '' : 'トレーナー戦では 捕まえられない', '巻物は 戦闘中には 使えない', 'この道具は 戦闘中には 使えない', ''], '');
      }
      case 'bagT': {
        const it = N.items.find(x => x.id === ui.item);
        return pane(`<div class="head"><b>${esc(it ? it.name : '')}</b><span>だれに 使う？</span></div>
          <div class="list">${N.party.map((m, i) => partyBtn(m, i, 'buse', false)).join('')}</div>${backBtn()}`);
      }
      case 'party':
        return pane(`<div class="head"><b>交代する モンスター</b></div>
          <div class="list">${N.party.map((m, i) => partyBtn(m, i, 'bswitch', m.hp <= 0 || i === b.player_index, i === b.player_index ? '（戦闘中）' : '')).join('')}</div>${backBtn()}`);
      default:
        return pane(`<div class="head"><b>${esc(me.name)}</b><span>Lv${me.level}　HP ${me.hp}/${me.max_hp}</span></div>
          <div class="grid g2">
            <button class="btn cmd fight" data-a="sub" data-s="fight">たたかう</button>
            <button class="btn cmd bag" data-a="sub" data-s="bag">バッグ</button>
            <button class="btn cmd mon" data-a="sub" data-s="party">モンスター</button>
            <button class="btn cmd run" data-a="brun" ${b.kind === 'wild' ? '' : 'disabled'}>にげる</button>
          </div>`);
    }
  }

  function promptPanel() {
    const p = N.prompt;
    if (p.kind === 'starter') {
      const cards = p.species.map((sid, i) => {
        const inf = monInfo(sid);
        return `<button class="card ${i === ST.sel ? 'sel' : ''}" data-a="stsel" data-i="${i}"><img src="${icon(sid)}" alt=""><span>${esc(inf.name)}</span><span>${typeTags(inf.types)}</span></button>`;
      }).join('');
      return pane(`<div class="head"><b>相棒を 選ぼう</b><span>えらべるのは 1匹だけ</span></div>
        <div class="cards">${cards}</div><button class="btn big fight cmd" data-a="stok">この子に する！</button>`);
    }
    if (p.kind === 'shop') {
      if (ui.sub === 'qty') {
        const it = p.items[ui.i];
        const max = shopMax(it);
        ui.n = clamp(ui.n || 1, 1, max);
        const afford = it.price * ui.n <= N.money;
        return pane(`<div class="head"><b>${esc(it.name)}</b><span>持っている数 ${it.have}</span></div>
          <div class="note">${esc(it.desc)}</div>
          <div class="qty"><button class="btn" data-a="qm">－</button><span>×${ui.n}</span><button class="btn" data-a="qp">＋</button></div>
          <div class="head"><span>${it.price}円 × ${ui.n}</span><b>合計 ${it.price * ui.n}円（所持 ${N.money}円）</b></div>
          <div class="row2"><button class="btn big fight cmd" data-a="buy" data-def="1" ${afford ? '' : 'disabled'}>買う</button>${backBtn()}</div>`);
      }
      // 品物は id で覚える（大事なものを買って 一覧が縮んでも 別の品に カーソルが移らない）
      const list = p.items.map(it => `<button class="btn" data-a="shopi" data-id="${esc(it.id)}" ${it.price > N.money ? 'disabled' : ''}>
        <span class="grow">${esc(it.name)}</span><span class="sub">${it.price}円　持${it.have}</span></button>`).join('');
      const bonus = p.bonus ? `<div class="note">ムスビカゴの なかまを 一度に ${p.bonus.per}個 買うと ${esc(p.bonus.name)}を 1個 おまけ</div>` : '';
      return pane(`<div class="head"><b>ショップ</b><span>所持金 ${N.money}円</span></div>
        <div class="list">${list}</div>${bonus}<button class="btn back" data-a="popt" data-i="${p.items.length}">お店を 出る</button>`);
    }
    if (p.kind === 'box') {
      // あずかり箱: 手持ち／箱を タブで切り替える（左右キーでも）。手持ちが 6匹の時は 入れ替え相手を選ぶ
      const box = p.box || [], party = N.party;
      if (ui.sub === 'boxsw') {
        const inn = box[ui.bi];
        if (!inn) { ui.sub = 'main'; return promptPanel(); }
        return pane(`<div class="head"><b>${esc(inn.name)}と 入れ替え</b><span>だれを 預ける？</span></div>
          <div class="list">${party.map((m, i) => partyBtn(m, i, 'boxswap', false)).join('')}</div>${backBtn()}`);
      }
      const t = ui.boxTab = ui.boxTab ? 1 : 0;
      const tabs = ['手持ち', 'あずかり箱'].map((nm, i) => `<button class="btn tab ${i === t ? 'cur' : ''}" data-a="boxtab" data-p="${i}">${nm}</button>`).join('');
      const list = t === 0
        ? party.map((m, i) => partyBtn(m, i, 'boxdep', party.length <= 1)).join('')
        : box.map((m, i) => partyBtn(m, i, 'boxpick', false)).join('') || '<div class="note">あずかり箱は からっぽ</div>';
      const note = t === 0 ? '預けた モンスターは 元気に なる' : party.length >= 6 ? '手持ちが 6匹なので 選ぶと 入れ替えに なる' : '選ぶと 手持ちに 加わる';
      return pane(`<div class="head"><b>あずかり箱</b><span>手持ち ${party.length}/6　箱 ${box.length}匹</span></div>
        <div class="tabs" style="grid-template-columns:repeat(2,1fr)">${tabs}</div>
        <div class="list">${list}</div><div class="note">${note}</div>
        <button class="btn back" data-a="popt" data-i="0">閉じる</button>`);
    }
    if (p.kind === 'evolve') {
      return pane(`<div style="flex:1"></div><button class="btn big fight cmd" data-a="evo" data-i="0">進化させる</button>
        <button class="btn big" data-a="evo" data-i="1">やめさせる</button><div style="flex:1"></div>`, 'title-bg');
    }
    const lastBack = ['learn_move', 'trade', 'gift_choose'].includes(p.kind);
    const opts = p.options.map((o, i) => `<button class="btn ${i === p.options.length - 1 && lastBack ? 'back' : ''}" data-a="popt" data-i="${i}">${esc(o)}</button>`).join('');
    const head = { learn_move: '技を 覚える', trade: '交換', gift_choose: 'もらう' }[p.kind] || 'えらぶ';
    return pane(`<div class="head"><b>${head}</b></div><div class="list">${opts}</div>`);
  }

  // ---- 下画面の操作 ----
  const ACTIONS = {
    adv: () => advance(),
    back: () => {
      Snd.se('cursor');
      const up = { mon: 'party', bagT: 'bag', dexE: 'dex', qty: 'shop', new1: 'main', new2: 'main', mdet: 'fight', oswitch: 'main', boxsw: 'main', map: 'bag', menu: 'main' };
      if (ui.sub === 'name') {  // 名前入力: 「あとで」は そのまま 冒険へ。カードから 来たら カードへ
        const next = ui.nameNext;
        ui.nameErr = ''; ui.nameDraft = ''; ui.nameNext = '';
        if (next === 'cont') { enterGame(false); return; }
        ui.sub = next === 'card' || next === 'rival' ? 'card' : 'main';  // 博士の 導入から 来たら 名前の 候補へ 戻る
        renderPanel();
        return;
      }
      let to = up[ui.sub] || 'main';
      const inField = scene === 'field' && N && !N.battle && !N.prompt;
      if (inField && ['party', 'bag', 'dex', 'card', 'report', 'config'].includes(ui.sub)) to = 'menu';  // メニューから 開いた画面は メニューへ 戻る
      if (inField && ui.sub === 'mon' && ui.monBack) to = ui.monBack;  // 手帳の なかまから 開いたら 手帳へ
      ui.sub = to;
      renderPanel();
    },
    sub: d => {
      Snd.se('ok'); ui.sub = d.s;
      if (d.s === 'mdet') ui.mdShown = true;
      if (d.s === 'bag') { const c = N.battle ? 'b:' + N.battle.kind : 'f'; ui.pocket = c in POCKMEM ? POCKMEM[c] : N.battle && N.battle.kind === 'wild' ? 1 : 0; }
      renderPanel();
    },
    talk: () => {
      const o = facingObj();
      if (!o || o.kind === 'exit') { Snd.se('bump'); say('目の前には 何もない。 調べたい 方向を 向いてから 押してね'); return; }
      fieldA();
    },
    mon: d => { Snd.se('ok'); ui.monBack = ui.sub === 'main' ? 'main' : ''; ui.sub = 'mon'; ui.i = +d.i; renderPanel(); },
    menu: () => toggleMenu(),
    gpage: d => { Snd.se('cursor'); ui.gpage = +d.p; renderPanel(); },
    memoclr: () => { Snd.se('cursor'); MEMO.strokes = []; renderPanel(); },
    coin: () => {
      const face = Math.random() < 0.5 ? 'おもて' : 'うら', c = ui.coin || { face: '', n: 0, run: 0 };
      ui.coin = { face, n: c.n + 1, run: c.face === face ? c.run + 1 : 1 };
      ui.coinAnim = true; Snd.se('ok'); renderPanel();
    },
    pocket: d => { Snd.se('cursor'); ui.pocket = +d.p; renderPanel(); },
    dexe: d => { Snd.se('ok'); ui.sub = 'dexE'; ui.dexId = d.id; renderPanel(); },
    lead: () => {
      const order = [ui.i, ...N.party.map((_, i) => i).filter(i => i !== ui.i)];
      ui.sub = 'party';
      act({ op: 'order', order });
    },
    hold: () => { Snd.se('ok'); ui.sub = 'holdPick'; renderPanel(); },
    holdpick: d => { ui.sub = 'mon'; act({ op: 'hold', item: d.id, target: ui.i }); },
    unhold: () => { ui.sub = 'mon'; act({ op: 'hold', item: null, target: ui.i }); },
    item: d => {
      Snd.se('ok');
      if (d.id === 'wakeai_suzu') { ui.sub = 'bag'; act({ op: 'item', item: d.id, target: 0 }); return; }
      ui.sub = d.id === 'tabichizu' ? 'map' : 'bagT'; ui.item = d.id; renderPanel();
    },
    useitem: d => { ui.sub = 'bag'; act({ op: 'item', item: ui.item, target: +d.i }); },
    sound: () => { Snd.setMute(!Snd.muted); updateSoundBtn(); Snd.se('ok'); renderPanel(); },
    totitle: () => { Snd.se('ok'); ui.sub = 'main'; goTitle(); },
    // 戦闘
    bmove: d => { ui.sub = 'main'; ui.mi = +d.i; act({ op: 'battle', action: { kind: 'move', index: +d.i } }); },
    bitem: d => {
      const it = N.items.find(x => x.id === d.id);
      if (!it) return;
      if (it.kind === 'capture') { ui.sub = 'main'; if (B) B.ballKind = it.id === 'iwaimusubi' ? 'iwai' : ''; act({ op: 'battle', action: { kind: 'capture', item: it.id } }); return; }
      Snd.se('ok'); ui.sub = 'bagT'; ui.item = it.id; renderPanel();
    },
    buse: d => { ui.sub = 'main'; act({ op: 'battle', action: { kind: 'item', item: ui.item, target: +d.i } }); },
    bswitch: d => { ui.sub = 'main'; act({ op: 'battle', action: { kind: 'switch', index: +d.i } }); },
    brun: () => { ui.sub = 'main'; act({ op: 'battle', action: { kind: 'run' } }); },
    bkeep: () => { ui.sub = 'main'; act({ op: 'battle', action: { kind: 'keep' } }); },
    mdsel: (d, b) => {
      const i = +d.i, me = N.battle && N.party[N.battle.player_index], mv = me && me.moves[i];
      if (!mv) return;
      if (ui.mi === i && ui.mdShown) {  // 同じ技を もう一度 → 使う
        if (mv.pp <= 0) { Snd.se('bump'); return; }
        // 次に「たたかう」を開いた時も この技に カーソル（くわしく ではなく）
        ui.sub = 'fight'; CURSOR.mem[menuKey()] = `bmove|${i}|||`;
        ui.sub = 'main'; ui.mdShown = false;
        act({ op: 'battle', action: { kind: 'move', index: i } });
        return;
      }
      // タップした技に カーソルも合わせる（続けて A を押すと その技を使う）
      const list = menuButtons(), k = b ? list.indexOf(b) : -1;
      if (k >= 0) { selIdx = k; markSel(list); }
      ui.mi = i; ui.mdShown = true; Snd.se('cursor');
      const sh = panel.querySelector('#mdetSheet');
      if (sh) sh.innerHTML = moveDetail(mv);
    },
    // 選択肢
    stsel: d => { ST.sel = +d.i; Snd.se('cursor'); Snd.cry(N.prompt.species[ST.sel]); renderPanel(); },
    stok: () => { ST.chosen = ST.sel; Snd.se('ok'); act({ op: 'prompt', index: ST.sel }); },
    shopi: d => {
      const i = ((N.prompt && N.prompt.items) || []).findIndex(it => it.id === d.id);
      if (i < 0) return;
      Snd.se('ok'); ui.sub = 'qty'; ui.i = i; ui.n = 1; renderPanel();
    },
    qm: () => { ui.n = Math.max(1, (ui.n || 1) - 1); Snd.se('cursor'); renderPanel(); },
    qp: () => {  // 払える数まで（買うボタンが消えてカーソルが飛ばないように）
      const it = N.prompt && N.prompt.items && N.prompt.items[ui.i];
      const max = it ? shopMax(it) : 99;
      if ((ui.n || 1) >= max) { Snd.se('bump'); return; }
      ui.n = (ui.n || 1) + 1; Snd.se('cursor'); renderPanel();
    },
    buy: () => { const i = ui.i, n = ui.n; ui.sub = 'shop'; Snd.se('coin'); act({ op: 'prompt', index: i, count: n }); },
    popt: d => { ui.sub = 'main'; if (N.prompt && N.prompt.kind === 'box') ui.boxTab = 0; act({ op: 'prompt', index: +d.i }); },
    // あずかり箱
    boxtab: d => { Snd.se('cursor'); ui.boxTab = +d.p; renderPanel(); },
    boxdep: d => { ui.sub = 'main'; act({ op: 'box', action: 'deposit', party: +d.i }); },
    boxpick: d => {
      if (N.party.length >= 6) { Snd.se('ok'); ui.sub = 'boxsw'; ui.bi = +d.i; renderPanel(); return; }
      ui.sub = 'main'; act({ op: 'box', action: 'withdraw', box: +d.i });
    },
    boxswap: d => { const bi = ui.bi; ui.sub = 'main'; act({ op: 'box', action: 'swap', party: +d.i, box: bi }); },
    evo: d => {
      const yes = +d.i === 0;
      act({ op: 'prompt', index: +d.i }, yes ? {
        during: async () => { EV.phase = 'anim'; EV.t0 = performance.now(); Snd.se('encounter'); await sleep(3300); },
        after: async res => {
          if (res.messages.some(m => /進化した/.test(m))) {
            await tween(300, t => { FX.flash = t; });
            EV.cur = EV.into; EV.phase = 'done';
            burst(128, 70, '#ffffff', 30, 2, 'star');
            await tween(500, t => { FX.flash = 1 - t; });
            Snd.cry(EV.cur);
          } else EV.phase = 'wait';
        },
      } : {});
    },
    // タイトル
    start: () => {
      if (!N.intro_seen && introData()) runProf('start');
      else if (!N.player_name) openName('start');
      else enterGame(!N.intro_seen);
    },
    cont: () => { if (!N.player_name) openName('cont'); else enterGame(false); },
    new: () => { Snd.se('ok'); ui.sub = 'new1'; renderPanel(); },
    newyes: () => {
      if (ui.sub === 'new1') { Snd.se('ok'); ui.sub = 'new2'; renderPanel(); return; }
      if (introData()) runProf('new');  // 記録を 消すのは 博士に 名前を 伝え終えてから
      else openName('new');  // 記録を 消すのは 名前を 決めてから（サーバーが 名前を 確かめてから 作り直す）
    },
    rename: () => openName('card', N.player_name || ''),
    rerival: () => openName('rival', N.rival_name || ''),
    pfself: () => { if (PF.ask) openName('prof_' + PF.ask); },
    pfpick: d => { const l = profPresets(); if (PF.ask && l[+d.i] != null) pfSubmit(l[+d.i]); },
    namego: async () => {
      if (busy || ui.sub !== 'name') return;
      const pin = panel.querySelector('#pname');
      const name = pin ? pin.value : (ui.nameDraft || '');
      if (pin) pin.blur();  // iPhone の キーボードを 閉じる
      const next = ui.nameNext;
      if (next === 'prof_player' || next === 'prof_rival') { pfSubmit(name); return; }
      setBusy(true);
      let res;
      try { res = await api(next === 'new' ? { op: 'new', name } : { op: next === 'rival' ? 'set_rival' : 'set_name', name }); } catch (e) { setBusy(false); return; }
      N = res.state;
      if (res.error) {  // タイトルでは メッセージ窓が 出ないので、入力欄の 下に 理由を 出す
        Snd.se('buzz'); ui.nameErr = res.error; ui.nameDraft = name;
        setBusy(false);
        return;
      }
      ui.nameErr = ''; ui.nameDraft = ''; ui.nameNext = '';
      if (next === 'card' || next === 'rival') { Snd.se('ok'); ui.sub = 'card'; setBusy(false); return; }
      busy = false; ui.sub = 'main';
      if (next === 'new') enterGame(true);
      else if (next === 'start') enterGame(!N.intro_seen);
      else enterGame(false);
    },
  };
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    Snd.init();
    const fn = ACTIONS[b.dataset.a];
    if (fn && !busy) rememberBtn(b);
    if (fn && (!busy || b.dataset.a === 'adv')) fn(b.dataset, b);
  });

  // ================= 場面の出入り =================
  // ---- 博士の 導入（台詞・博士の名前・名前の候補は data/intro.json で 変える）----
  const PF = { show: null, t0: 0, ask: null, hint: '', resolve: null };
  const introData = () => { const d = DEX && DEX.intro; return d && Array.isArray(d.script) && d.script.length ? d : null; };
  const profMon = d => !!(d.monster && DEX.species && DEX.species[d.monster]);
  // {prof} {player} {rival} を 1回で 置き換える（名前に {rival} と 書かれていても 二重に 置き換えない）
  const fillIntro = (s, v) => String(s).replace(/\{(prof|player|rival)\}/g, (m, k) => v[k] || m);
  const profPresets = () => { const d = introData() || {}; return (PF.ask === 'rival' ? d.rival_presets : d.player_presets) || []; };
  function profPanel() {
    if (ui.sub === 'name') return namePane();
    if (!PF.ask) return `<div class="tapzone" data-a="adv"><div class="dot">▼</div><div class="note">タップで つぎへ</div></div>`;
    return pane(`<div class="head"><b>${PF.ask === 'rival' ? 'ライバルの なまえ' : 'あなたの なまえ'}</b></div><div class="list">
      <button class="btn big" data-a="pfself">じぶんで きめる</button>
      ${profPresets().map((n, i) => `<button class="btn big" data-a="pfpick" data-i="${i}">${esc(n)}</button>`).join('')}</div>`);
  }
  async function pfSubmit(name) {  // 聞いた 名前を サーバーで 確かめてから 次の 台詞へ（記録は まだ 変えない）
    if (busy || !PF.resolve) return;
    const kind = PF.ask;
    setBusy(true);
    let res;
    try { res = await api({ op: 'check_name', name }); } catch (e) { setBusy(false); return; }
    if (res.error) {
      Snd.se('buzz');
      Object.assign(ui, { sub: 'name', nameNext: 'prof_' + kind, nameErr: res.error, nameDraft: String(name) });
      setBusy(false);
      return;
    }
    Snd.se('ok');
    Object.assign(ui, { sub: 'main', nameNext: '', nameErr: '', nameDraft: '' });
    const r = PF.resolve; PF.resolve = null;
    r(String(name).normalize('NFC').trim());
  }
  async function runProf(mode) {  // mode: 'new'＝はじめから（最後に 記録を 作り直す）／'start'＝まだ 相棒の いない 記録
    const d = introData();
    Snd.init(); Snd.se('ok');
    setBusy(true);
    await tween(300, t => { FX.fade = t; });
    scene = 'prof'; ui.sub = 'main';
    Object.assign(PF, { show: null, ask: null, hint: '', resolve: null });
    renderPanel();
    await tween(320, t => { FX.fade = 1 - t; });
    FX.fade = 0;
    const v = { prof: d.prof_name || '博士', player: '', rival: '' };
    for (const st of d.script) {
      if (st.show && st.show !== PF.show) {
        PF.show = st.show; PF.t0 = T;
        if (st.show === 'monster' && profMon(d)) Snd.cry(d.monster);
      }
      if (st.say) await say(fillIntro(st.say, v));
      if (st.ask) {
        PF.hint = st.say ? fillIntro(st.say, v) : '';
        PF.ask = st.ask;
        v[st.ask] = await new Promise(res => { PF.resolve = res; setBusy(false); });
        PF.ask = null; PF.hint = '';
      }
    }
    let res;
    try {
      if (mode === 'new') res = await api({ op: 'new', name: v.player, rival: v.rival });
      else {
        res = await api({ op: 'set_name', name: v.player });
        if (!res.error) res = await api({ op: 'set_rival', name: v.rival });
      }
    } catch (e) { goTitle(); return; }
    N = res.state;
    if (res.error) { Snd.se('buzz'); await say(res.error); goTitle(); return; }
    busy = false;
    enterGame(true, true);
  }

  const INTRO = [
    'ようこそ！ ここから きみの モンスターとの 旅が はじまる。',
    'まずは 左上の 青い屋根の 研究所へ。 博士から 相棒の モンスターを もらおう。',
    '建物には 扉に 向かって 歩けば 入れる。 人や 石碑は 向き合って A ボタンで 話せる。',
    '下の画面は たびの手帳。 ☰ メニューで ずかん・モンスター・バッグを 開ける。 冒険は 毎回 自動で 記録される。',
  ];
  async function enterGame(intro, afterProf) {
    Snd.init(); Snd.se('ok');
    setBusy(true);
    await tween(300, t => { FX.fade = t; });
    ui.sub = 'main';
    setArea(N);
    if (N.battle) {
      initBattle(N, null);
      B.enemy.visible = true; B.hero.visible = false; if (B.trainer) B.trainer.visible = false;
      if (B.player) B.player.visible = B.player.hp > 0;
      // 入れ替え確認の途中で 再開した時は、倒れた相手を 立たせない（syncBattle と同じ）
      if (N.battle.state === 'offer_switch' && N.battle.enemy.hp_steps <= 0) B.enemy.visible = false;
      scene = 'battle'; Snd.play('battle');
    } else if (N.prompt && N.prompt.kind === 'evolve') enterEvolve(N);
    else if (N.prompt && N.prompt.kind === 'starter') { scene = 'starter'; Snd.play('field'); }
    else { scene = 'field'; Snd.play('field'); }
    renderPanel();
    await tween(320, t => { FX.fade = 1 - t; });
    FX.fade = 0;
    if (scene === 'field') showBanner(N.area.name);
    if (intro) {
      for (const line of afterProf ? INTRO.slice(1) : INTRO) await say(line);  // 博士の 後は 最初の「ようこそ」を 省く
      try { N = (await api({ op: 'intro_seen' })).state; } catch (e) { /* 次回も出るだけ */ }
    }
    setBusy(false);
  }
  async function goTitle() {
    setBusy(true);
    await tween(300, t => { FX.fade = t; });
    scene = 'title'; B = null; EV = null;
    Snd.play('title');
    renderPanel();
    await tween(300, t => { FX.fade = 1 - t; });
    FX.fade = 0;
    setBusy(false);
  }
  const randomSid = () => {
    const ids = Object.keys(DEX.species).filter(s => DEX.species[s].stage === 0);
    return ids[Math.floor(Math.random() * ids.length)];
  };

  // ================= ボタン・キー =================
  const btnA = $('#btnA'), btnB = $('#btnB'), dpad = $('#dpad'), btnSound = $('#btnSound'), btnMenu = $('#btnMenu');
  function updateSoundBtn() { btnSound.classList.toggle('off', Snd.muted); }
  function menuButtons() { return [...panel.querySelectorAll('[data-a]:not([disabled])')].filter(b => b.dataset.a !== 'adv'); }
  function markSel(list) {
    const sel = list[selIdx];
    CURSOR.sel = sel ? btnId(sel) : null;
    rememberBtn(sel);
    list.forEach((b, i) => b.classList.toggle('sel', i === selIdx));
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    // 技の くわしい画面では カーソルの技の説明を出す（A で その技を使う）
    if (sel && ui.sub === 'mdet' && sel.dataset.a === 'mdsel' && N.battle) {
      const mv = (N.party[N.battle.player_index] || { moves: [] }).moves[+sel.dataset.i];
      const sh = panel.querySelector('#mdetSheet');
      if (mv && sh) { ui.mi = +sel.dataset.i; ui.mdShown = true; sh.innerHTML = moveDetail(mv); }
    }
  }
  function navSel(d) {
    const list = menuButtons();
    if (!list.length) return;
    if (selIdx < 0 || selIdx >= list.length) { selIdx = 0; markSel(list); Snd.se('cursor'); return; }
    const r0 = list[selIdx].getBoundingClientRect();
    const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    const [dx, dy] = DIRS[d];
    let best = -1, bestScore = Infinity;
    list.forEach((b, i) => {
      if (i === selIdx) return;
      const r = b.getBoundingClientRect();
      const vx = r.left + r.width / 2 - c0.x, vy = r.top + r.height / 2 - c0.y;
      const along = vx * dx + vy * dy;
      if (along <= 2) return;
      const score = along + 2 * Math.abs(vx * dy - vy * dx);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) { selIdx = best; markSel(list); Snd.se('cursor'); }
  }
  function pressA() {
    Snd.init();
    if (MSG.pages) { advance(); return; }
    if (busy) return;
    if (freeField()) { fieldA(); return; }
    if (scene === 'starter') { const ok = panel.querySelector('[data-a="stok"]'); if (ok) ok.click(); return; }
    const list = menuButtons();
    if (selIdx >= 0 && list[selIdx]) list[selIdx].click();
    else if (list.length) { selIdx = 0; markSel(list); Snd.se('cursor'); }
  }
  function pressB() {
    Snd.init();
    if (MSG.pages) { advance(); return; }
    if (busy) return;
    const back = panel.querySelector('[data-a="back"]') || panel.querySelector('.btn.back:not([disabled])');  // 「お店を 出る」も B で
    if (back) back.click();
  }
  function dirDown(d) {
    Snd.init();
    if (freeField() || (walking && scene === 'field')) { holdDir = d; walkLoop(d); return; }
    if (scene === 'starter' && !busy && !MSG.pages && (d === 'left' || d === 'right')) {
      const n = (N.prompt && N.prompt.species || []).length || 3;
      ST.sel = (ST.sel + (d === 'right' ? 1 : n - 1)) % n;
      Snd.se('cursor'); renderPanel(); return;
    }
    // 個数を選ぶ画面では 左右で個数を増減（カーソルは「買う」のまま）
    if (ui.sub === 'qty' && !busy && !MSG.pages && (d === 'left' || d === 'right')) {
      const b = panel.querySelector(`[data-a="${d === 'right' ? 'qp' : 'qm'}"]`);
      if (b) { b.click(); return; }
    }
    // あずかり箱では 左右で 手持ち／箱を 切り替える
    if (N && N.prompt && N.prompt.kind === 'box' && ui.sub === 'main' && scene === 'field' && !busy && !MSG.pages && (d === 'left' || d === 'right')) {
      ui.boxTab = ui.boxTab ? 0 : 1;
      Snd.se('cursor'); renderPanel(); return;
    }
    // バッグでは 左右でポケットを切り替える
    if (ui.sub === 'bag' && !busy && !MSG.pages && (d === 'left' || d === 'right')) {
      ui.pocket = ((ui.pocket || 0) + (d === 'right' ? 1 : POCKETS.length - 1)) % POCKETS.length;
      Snd.se('cursor'); renderPanel(); return;
    }
    if (!busy && !MSG.pages) navSel(d);
  }
  function dirUp(d) { if (holdDir === d) holdDir = null; }
  const press = (el, fn) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.classList.add('on'); fn(); });
    const up = () => el.classList.remove('on');
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', up);
  };
  press(btnA, pressA);
  press(btnB, pressB);
  if (btnMenu) btnMenu.addEventListener('click', () => toggleMenu());
  btnSound.addEventListener('click', () => { Snd.init(); Snd.setMute(!Snd.muted); updateSoundBtn(); if (!Snd.muted) Snd.se('ok'); if (ui.sub === 'config') renderPanel(); });
  // 十字キーは指を滑らせても方向が変わる
  let padDir = null;
  const dirFromPoint = e => {
    const r = dpad.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(x, y) < 8) return padDir;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
  };
  const setPad = d => {
    if (d === padDir) return;
    if (padDir) { dirUp(padDir); dpad.querySelector(`[data-dir="${padDir}"]`).classList.remove('on'); }
    padDir = d;
    if (d) { dpad.querySelector(`[data-dir="${d}"]`).classList.add('on'); dirDown(d); }
  };
  dpad.addEventListener('pointerdown', e => { e.preventDefault(); dpad.setPointerCapture(e.pointerId); setPad(dirFromPoint(e)); });
  dpad.addEventListener('pointermove', e => { if (padDir) setPad(dirFromPoint(e)); });
  const padEnd = () => setPad(null);
  dpad.addEventListener('pointerup', padEnd); dpad.addEventListener('pointercancel', padEnd);
  cv.addEventListener('pointerdown', e => { e.preventDefault(); Snd.init(); if (MSG.pages) advance(); });

  const KEYDIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
  window.addEventListener('keydown', e => {
    // 名前の入力中は 文字キーを ゲーム操作に 取らない。Enter で 決定（日本語の 変換確定の Enter は 除く）、Esc で 入力欄から 抜ける
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!e.repeat && ACTIONS.namego) ACTIONS.namego(); }
      else if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
      return;
    }
    const d = KEYDIR[e.key];
    if (d) { e.preventDefault(); if (!e.repeat) dirDown(d); else if (!freeField() && !busy) navSel(d); return; }
    if (e.repeat) return;
    if (e.key === 'z' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pressA(); }
    if (e.key === 'x' || e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); pressB(); }
    if (e.key === 'm' || e.key === 'q') { e.preventDefault(); toggleMenu(); }
  });
  window.addEventListener('keyup', e => { const d = KEYDIR[e.key]; if (d) dirUp(d); });  // 入力中でも 離した方向は 止める（歩きっぱなし防止）
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault());

  // ================= 起動 =================
  async function boot() {
    updateSoundBtn();
    renderPanel();
    raf(frame);
    try { if (document.fonts) await Promise.race([document.fonts.load(`12px "DotGothic16"`), sleep(1500)]); } catch (e) { /* 代替フォント */ }
    const [dex, st] = await Promise.all([getJSON('/api/dex'), getJSON('/api/state')]);
    DEX = dex;
    for (const [sid, s] of Object.entries(DEX.species)) if (!NAME2SID[s.name]) NAME2SID[s.name] = sid;
    N = st.state;
    loadImages();
    parade = Array.from({ length: 4 }, (_, i) => ({ sid: randomSid(), x: -60 - i * 70, ph: i }));
    scene = 'title';
    Snd.play('title');
    renderPanel();
  }
  boot();
})();

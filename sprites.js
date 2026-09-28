// ドット絵はすべてコードで生成する（外部素材なし）。
// フィールド: 16px タイル／人物 16x20 ／ モンスター 64x64（種族ごとに固定シードで生成・左右対称）
'use strict';

const Art = (() => {
  // ---- 色 ----
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const light = (c, t) => mix(c, [255, 255, 255], t);
  const dark = (c, t) => mix(c, [0, 0, 0], t);
  const hueShift = (c, deg) => {
    let [r, g, b] = c.map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    h = (h + deg / 360 + 1) % 1;
    const f = (p, q, t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  };

  const TYPE = {
    '火': ['#e8603c', '#ffc23d'], '水': ['#3d8fe8', '#bfe6ff'], '樹': ['#4caf50', '#d6ee7a'],
    '雷': ['#f5c518', '#fff6b0'], '岩': ['#a08058', '#dccaa0'], '風': ['#6cc8be', '#eafff9'],
    '氷': ['#8fd8f0', '#ffffff'], '獣': ['#c8905a', '#f4e0bc'], '霊': ['#8a6ad0', '#dccfff'],
    '金': ['#9aa6b2', '#eef2f6'], '毒': ['#a050c0', '#e6a8f4'], '虫': ['#98c030', '#f4e46a'],
    '光': ['#ffe070', '#ffffff'], '闇': ['#4a3a6a', '#d04868'], '音': ['#f080b0', '#fff0f6'],
    '夢': ['#c090f0', '#ffd6f4'], '武': ['#d04830', '#f4d8a8'], '古': ['#8c8468', '#cfe4a4'],
    '霧': ['#b0bcc6', '#ffffff'], '晶': ['#50d8e0', '#e8ffff'],
  };
  const typeColor = t => hex((TYPE[t] || ['#999999'])[0]);

  // ---- 乱数（種族IDから決まる） ----
  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    return [c, x];
  }

  // ラベル付きマスク → 陰影・縁取り付きの画像
  // labels: 0=空 1=体 2=腹 3=差し色 4=白目 5=瞳 6=濃い細部 7=差し色2
  function shade(mask, W, H, pal, opt = {}) {
    const [c, x] = canvas(W, H);
    const img = x.createImageData(W, H);
    const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H) ? 0 : mask[j * W + i];
    // 高さ方向の範囲（下ほど暗く）
    let top = H, bot = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (mask[j * W + i]) { top = Math.min(top, j); bot = Math.max(bot, j); }
    const put = (i, j, col, a = 255) => {
      const k = (j * W + i) * 4;
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = a;
    };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const v = mask[j * W + i];
        if (!v) {
          // 縁取り（隣が塗られていれば、その色の暗い版）
          const n = at(i - 1, j) || at(i + 1, j) || at(i, j - 1) || at(i, j + 1);
          if (n) put(i, j, dark(pal[n] || pal[1], opt.outline ?? 0.62));
          continue;
        }
        let col = pal[v];
        if (v === 4 || v === 5) { put(i, j, col); continue; }
        // 光は左上から
        const tl = !at(i - 1, j - 1) || !at(i, j - 1);
        const br = !at(i + 1, j + 1) || !at(i, j + 1) || !at(i + 1, j);
        const br2 = !at(i + 2, j + 2) || !at(i, j + 2);
        if (tl) col = light(col, 0.32);
        else if (br) col = dark(col, 0.3);
        else if (br2 && (i + j) % 2 === 0) col = dark(col, 0.16);
        const g = (j - top) / Math.max(1, bot - top);
        if (g > 0.72 && !tl && (i + j) % 2 === 0) col = dark(col, 0.1);
        // 領域の境目に細い線
        if (v !== at(i, j - 1) && at(i, j - 1) && at(i, j - 1) !== 4 && at(i, j - 1) !== 5 && v !== 6) col = dark(col, 0.22);
        put(i, j, col);
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  // ---- モンスター ----
  const FEATURES = {
    '火': ['flame', 'tailFlame'], '水': ['fins', 'crest'], '樹': ['leaf', 'leaf2'], '雷': ['ears', 'bolt'],
    '岩': ['horns', 'plates'], '風': ['wings', 'tuft'], '氷': ['spikes', 'fins'], '獣': ['ears', 'tail'],
    '霊': ['ghost', 'wisp'], '金': ['horns', 'plates'], '毒': ['spots', 'drip'], '虫': ['antennae', 'wings'],
    '光': ['halo', 'orb'], '闇': ['spikes', 'horns'], '音': ['ears', 'notes'], '夢': ['ghost', 'leaf'],
    '武': ['fists', 'band'], '古': ['plates', 'rune'], '霧': ['ghost', 'wisp'], '晶': ['spikes', 'crystal'],
  };

  const cache = new Map();

  function monsterMask(line, stage, types) {
    const W = 64, H = 64, M = new Uint8Array(W * H);
    const R = rng(hash(line));
    const r = (a, b) => a + R() * (b - a);
    const set = (x, y, v) => {
      x = Math.round(x); y = Math.round(y);
      if (y < 0 || y >= H) return;
      for (const xx of [x, W - 1 - x]) if (xx >= 0 && xx < W) M[y * W + xx] = v;
    };
    const ell = (cx, cy, rx, ry, v, only) => {
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
        for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (d <= 1 && x >= 0 && x < W && y >= 0 && y < H && (!only || M[y * W + x] === only)) set(x, y, v);
        }
    };
    const tri = (ax, ay, bx, by, cx, cy, v) => {
      const minx = Math.floor(Math.min(ax, bx, cx)), maxx = Math.ceil(Math.max(ax, bx, cx));
      const miny = Math.floor(Math.min(ay, by, cy)), maxy = Math.ceil(Math.max(ay, by, cy));
      const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) set(x, y, v);
      }
    };
    const k = stage >= 2 ? 1.26 : stage >= 1 ? 1.14 : 1; // 進化するたびに一回り大きく
    const t1 = types[0], t2 = types[1] || types[0];
    const feats = new Set([...(FEATURES[t1] || []).slice(0, R() < 0.5 ? 1 : 2)]);
    if (stage >= 1) (FEATURES[t2] || []).forEach(f => feats.add(f));
    const ghost = feats.has('ghost');
    const blob = !ghost && R() < 0.3; // 頭と体が一体の丸い体型
    const cx = 32;
    const bodyW = r(11, 15) * k, bodyH = r(10, 14) * k;
    const bodyY = 60 - bodyH - (ghost ? 4 : 5);
    const headR = (blob ? r(13, 16) : r(9, 12)) * k;
    const headY = blob ? bodyY - 2 : bodyY - bodyH * 0.55 - headR * 0.55;
    const headX = cx;

    // 背面のパーツ
    if (feats.has('wings')) {
      const wy = bodyY - bodyH * 0.3, span = r(14, 20) * k;
      ell(cx - bodyW - span * 0.45, wy - 4, span * 0.55, r(8, 12) * k, 3);
      ell(cx - bodyW - span * 0.2, wy + 6, span * 0.4, r(5, 7) * k, 3);
    }
    if (feats.has('tail') || feats.has('tailFlame')) {
      tri(cx - bodyW + 2, bodyY + 4, cx - bodyW - r(8, 13) * k, bodyY - r(8, 16), cx - bodyW + 6, bodyY - 2, feats.has('tailFlame') ? 3 : 1);
    }
    if (feats.has('halo')) ell(headX, headY - headR - 3, headR * 0.8, 3, 7);
    if (feats.has('spikes') || feats.has('crystal')) {
      const n = stage >= 1 ? 3 : 2;
      for (let s = 0; s < n; s++) {
        const bx = cx - bodyW * 0.6 - s * 3, by = bodyY - bodyH * 0.4 + s * 5;
        tri(bx, by, bx - r(6, 11) * k, by - r(8, 14) * k, bx + 5, by - 1, feats.has('crystal') ? 7 : 3);
      }
    }
    if (feats.has('fins')) tri(cx - bodyW + 2, bodyY - 3, cx - bodyW - r(7, 11) * k, bodyY + 4, cx - bodyW + 3, bodyY + 7, 3);

    // 体
    if (ghost) {
      ell(cx, bodyY - 1, bodyW, bodyH * 0.9, 1);
      // すそが揺れる
      for (let x = cx - bodyW; x <= cx; x++) {
        const wave = Math.round(3 + 2 * Math.sin((x - cx) * 0.9));
        for (let y = bodyY; y < bodyY + bodyH * 0.6 + wave; y++) set(x, y, 1);
      }
    } else {
      ell(cx, bodyY, bodyW, bodyH, 1);
      // 足
      const fy = 60 - 4, fx = cx - bodyW * r(0.45, 0.65);
      ell(fx, fy, r(3.5, 5) * k, 3.2, 1);
    }
    // 腕
    if (feats.has('fists')) ell(cx - bodyW - 2, bodyY - 1, 5 * k, 5 * k, 3);
    else if (!ghost && R() < 0.7) ell(cx - bodyW + 1, bodyY - bodyH * 0.1, r(3, 4.5), r(4, 6), 1);
    // 腹
    ell(cx, bodyY + bodyH * 0.2, bodyW * r(0.45, 0.62), bodyH * r(0.5, 0.65), 2, 1);
    if (feats.has('plates')) for (let s = 0; s < 3; s++) ell(cx - bodyW * 0.55, bodyY - bodyH * 0.3 + s * 4, 3, 1.4, 3, 1);
    if (feats.has('band')) for (let x = cx - bodyW; x <= cx; x++) for (let y = Math.round(bodyY - 1); y <= bodyY + 1; y++) if (M[y * W + x]) set(x, y, 3);

    // 頭
    if (!blob) ell(headX, headY, headR * r(1.0, 1.15), headR, 1);
    if (feats.has('ears')) {
      const ex = headX - headR * 0.6, ey = headY - headR * 0.55;
      tri(ex - 4, ey + 3, ex - r(3, 7) * k, ey - r(9, 15) * k, ex + 4, ey - 1, 1);
      tri(ex - 2, ey + 1, ex - r(3, 6) * k + 1, ey - r(6, 10) * k, ex + 2, ey, 3);
    }
    if (feats.has('horns')) tri(headX - headR * 0.35 - 2, headY - headR * 0.7, headX - headR * 0.5 - r(2, 6), headY - headR - r(6, 11) * k, headX - headR * 0.35 + 2, headY - headR * 0.8, 7);
    if (feats.has('flame')) {
      tri(headX - 5, headY - headR * 0.7, headX - r(1, 4), headY - headR - r(8, 13) * k, headX + 1, headY - headR * 0.8, 3);
      tri(headX - 3, headY - headR * 0.8, headX - 1, headY - headR - r(4, 7) * k, headX, headY - headR * 0.8, 7);
    }
    if (feats.has('leaf') || feats.has('leaf2')) {
      ell(headX - 5, headY - headR - 3, 5 * k, 2.5, 3);
      if (feats.has('leaf2')) ell(headX - 1, headY - headR - 6, 1.2, 4, 6);
    }
    if (feats.has('crest') || feats.has('tuft')) tri(headX - 3, headY - headR + 1, headX, headY - headR - r(6, 10) * k, headX + 1, headY - headR + 1, 3);
    if (feats.has('antennae')) {
      for (let s = 0; s < 9 * k; s++) set(headX - 4 - s * 0.5, headY - headR - s, 6);
      ell(headX - 4 - 4.5 * k, headY - headR - 9 * k, 2, 2, 3);
    }
    if (feats.has('bolt')) tri(cx - bodyW - 2, bodyY - 8, cx - bodyW - 8, bodyY - 1, cx - bodyW - 1, bodyY - 2, 7);
    if (feats.has('spots')) for (let s = 0; s < 4; s++) ell(cx - r(2, bodyW - 2), bodyY + r(-bodyH * 0.6, bodyH * 0.4), 1.6, 1.6, 7, 1);
    if (feats.has('wisp')) ell(cx - bodyW - 6, bodyY - bodyH - 2, 2.5, 3.5, 7);
    if (feats.has('orb')) ell(cx - bodyW - 5, bodyY + 2, 3, 3, 7);
    if (feats.has('notes')) { ell(cx - bodyW - 7, headY + 2, 2, 1.6, 6); for (let s = 0; s < 6; s++) set(cx - bodyW - 5.5, headY + 1 - s, 6); }
    if (feats.has('rune')) for (let s = 0; s < 5; s++) set(cx - 1, bodyY - 2 + s, 7);
    if (feats.has('drip')) ell(cx - bodyW * 0.7, bodyY + bodyH * 0.7, 1.5, 2.5, 7);
    // 頬
    if (R() < 0.45) ell(headX - headR * 0.62, headY + headR * 0.3, 2, 1.4, 7, 1);

    // 目と口
    const eyeStyle = ['霊', '闇', '武', '毒'].includes(t1) ? 'sharp' : (R() < 0.5 ? 'round' : 'big');
    const ex = headX - headR * r(0.32, 0.45), ey = headY + (blob ? -headR * 0.15 : headR * 0.05);
    if (eyeStyle === 'sharp') {
      tri(ex - 3, ey - 2, ex + 2, ey, ex - 3, ey + 2, 4);
      set(ex - 1, ey, 5); set(ex - 2, ey, 5);
    } else {
      const er = eyeStyle === 'big' ? 3.2 : 2.4;
      ell(ex, ey, er * 0.85, er, 4);
      ell(ex + 0.4, ey + 0.5, er * 0.5, er * 0.7, 5);
      set(ex - 0.6, ey - 1, 4);
    }
    const my = ey + (blob ? headR * 0.4 : headR * 0.45);
    for (let x = cx - 2; x <= cx; x++) set(x, my + (x === cx - 2 ? -1 : 0), 6);
    return { M, W, H };
  }

  function palette(types, shiny) {
    let base = typeColor(types[0]);
    let acc = types[1] ? typeColor(types[1]) : hex((TYPE[types[0]] || ['', '#ffffff'])[1]);
    if (types[1] && Math.abs(base[0] - acc[0]) + Math.abs(base[1] - acc[1]) + Math.abs(base[2] - acc[2]) < 60) acc = light(acc, 0.5);
    let belly = light(hex((TYPE[types[0]] || ['', '#ffffff'])[1]), 0.15);
    let acc2 = light(acc, 0.35);
    if (types[0] === '闇') { acc = hex('#d04868'); acc2 = hex('#ff90a8'); }
    if (shiny) { base = hueShift(base, 150); acc = hueShift(acc, 150); acc2 = hueShift(acc2, 150); belly = hueShift(belly, 90); }
    return [null, base, belly, acc, [255, 255, 255], [28, 24, 40], dark(base, 0.55), acc2];
  }

  // line: 進化の系統の根の種族ID（同じ系統は形が似る）、stage: 0/1/2
  function monster(species, info, back = false, shiny = false) {
    const key = `${species}|${back}|${shiny}`;
    if (cache.has(key)) return cache.get(key);
    const { M, W, H } = monsterMask(info.line, info.stage, info.types);
    if (back) {
      for (let i = 0; i < M.length; i++) if (M[i] === 4 || M[i] === 5 || M[i] === 2) M[i] = 1;
      for (let i = 0; i < M.length; i++) if (M[i] === 6 && Math.floor(i / W) > 20) M[i] = 1;
    }
    const img = shade(M, W, H, palette(info.types, shiny));
    cache.set(key, img);
    return img;
  }

  // ---- 人物（16x20）----
  function person(style, dir, frame) {
    const key = `p|${JSON.stringify(style)}|${dir}|${frame}`;
    if (cache.has(key)) return cache.get(key);
    const W = 16, H = 20, M = new Uint8Array(W * H);
    const set = (x, y, v) => { if (x >= 0 && x < W && y >= 0 && y < H) M[y * W + x] = v; };
    const rect = (x, y, w, h, v) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, v); };
    // 1=髪 2=肌 3=服 4=ズボン 5=靴 6=帽子 7=目
    const side = dir === 'left' || dir === 'right';
    const step = frame % 2 === 1;
    // 脚
    if (side) {
      rect(6, 15, 3, 3, 4); rect(8, 15, 3, 3, 4);
      if (step) { rect(5, 17, 3, 2, 5); rect(9, 16, 3, 2, 5); } else { rect(6, 17, 5, 2, 5); }
    } else {
      const l = step ? 1 : 0;
      rect(5, 15, 3, 3 - l, 4); rect(8, 15, 3, 3, 4);
      rect(5, 18 - l, 3, 1, 5); rect(8, 18, 3, 1, 5);
      if (frame === 3) { rect(5, 15, 3, 3, 4); rect(8, 15, 3, 2, 4); rect(5, 18, 3, 1, 5); rect(8, 17, 3, 1, 5); M[18 * W + 8] = M[18 * W + 9] = M[18 * W + 10] = 0; }
    }
    // 体と腕
    if (side) { rect(5, 10, 6, 6, 3); rect(step ? 5 : 7, 11, 2, 4, 3); set(step ? 5 : 7, 14, 2); }
    else { rect(4, 10, 8, 6, 3); rect(3, 11, 1, 3, 3); rect(12, 11, 1, 3, 3); set(3, 14, 2); set(12, 14, 2); }
    // 頭
    rect(4, 2, 8, 8, 1); rect(3, 3, 10, 6, 1);
    if (dir === 'down') { rect(4, 5, 8, 5, 2); rect(3, 5, 1, 2, 1); rect(12, 5, 1, 2, 1); set(5, 7, 7); set(10, 7, 7); set(5, 6, 7); set(10, 6, 7); }
    if (side) { rect(7, 5, 6, 5, 2); set(11, 6, 7); set(11, 7, 7); set(3, 9, 1); }
    if (style.cap) {
      rect(3, 1, 10, 4, 6);
      if (dir === 'down') rect(3, 4, 10, 1, 6);
      if (side) rect(9, 4, 5, 1, 6);
    }
    if (style.long && dir !== 'down') rect(3, 8, 10, 3, 1);
    if (style.long && dir === 'down') { rect(3, 7, 1, 4, 1); rect(12, 7, 1, 4, 1); }
    if (dir === 'left') for (let j = 0; j < H; j++) for (let i = 0; i < W / 2; i++) {
      const a = M[j * W + i]; M[j * W + i] = M[j * W + W - 1 - i]; M[j * W + W - 1 - i] = a;
    }
    const pal = [null, hex(style.hair), hex(style.skin || '#f6d0a8'), hex(style.shirt), hex(style.pants),
      [60, 44, 40], hex(style.cap || style.hair), [30, 26, 40]];
    const img = shade(M, W, H, pal, { outline: 0.7 });
    cache.set(key, img);
    return img;
  }

  const PEOPLE = [
    { hair: '#6a4a30', shirt: '#4a9a5a', pants: '#445566' },
    { hair: '#2a2a3a', shirt: '#d8c050', pants: '#6a4a3a', long: true },
    { hair: '#b0b0b0', shirt: '#8a6ad0', pants: '#40404a' },
    { hair: '#c86a3a', shirt: '#e8e8f0', pants: '#3a6a9a', long: true },
    { hair: '#3a2a20', shirt: '#c04848', pants: '#303040', cap: '#4a6ab0' },
    { hair: '#f0d070', shirt: '#50a0d0', pants: '#6a6a70' },
    { hair: '#503a60', shirt: '#6a8a40', pants: '#4a3a30', cap: '#8a6a40' },
  ];
  const HERO = { hair: '#2a2030', shirt: '#d84848', pants: '#2a3a6a', cap: '#f0f0f0' };
  const NAMED = {
    rival_1: { hair: '#e0a030', shirt: '#3a5ad0', pants: '#2a2a34' }, // ライバルのカナタ
    rival: { hair: '#e0a030', shirt: '#3a5ad0', pants: '#2a2a34' },
    lab: { hair: '#d8d8d8', shirt: '#f4f4f8', pants: '#5a5a66' }, // 博士（白衣）
    heal: { hair: '#8a3a4a', shirt: '#f0a0b0', pants: '#f4f0f0', long: true },
    shop: { hair: '#4a3a2a', shirt: '#3a8ac8', pants: '#e8e0d0' },
  };
  const styleFor = key => NAMED[key] || PEOPLE[hash(key) % PEOPLE.length];

  // ---- ボストレーナー立ち絵（32x40、頭から足まで。バトル用の一枚絵）----
  // ラベル: 0=空 1=髪 2=肌 3=服(主色) 4=白目 5=瞳 6=濃い細部(靴/眉/口) 7=差し色 8=服(副色/ズボン) 9=差し色2(装飾)
  const BOSS_IDS = ['rival_1', 'boss_ishi', 'boss_mori', 'boss_minato'];
  const BOSS_SPEC = {
    // ライバルのカナタ：元気な少年。スパイキーな紺髪、スポーティなジャケット、マフラー
    rival_1: { skin: '#f4c49c', hair: '#232c4a', main: '#2a8a86', sub: '#eef0f0', accent: '#e0503a', accent2: '#b03024', dark: '#20222c', build: 'lean', hairStyle: 'spiky', pose: 'fistUp', extra: 'scarf' },
    // 石の道場主イワネ：大柄で頑丈な年配男性。灰茶の作務衣、鉢巻、石のお守り
    boss_ishi: { skin: '#c8a074', hair: '#6a6258', main: '#665a4a', sub: '#463c30', accent: '#9c3830', accent2: '#8a9a84', dark: '#241e16', build: 'heavy', hairStyle: 'short', pose: 'crossed', extra: 'amulet' },
    // 森の道場主コノハ：落ち着いた若い女性。長い緑髪と葉飾り、緑と土色の衣、小枝
    boss_mori: { skin: '#f0d8b8', hair: '#3a7a48', main: '#4a7a4c', sub: '#8a6a44', accent: '#c8e070', accent2: '#6a4a30', dark: '#22301a', build: 'slim', hairStyle: 'long', pose: 'branch', extra: 'leaf' },
    // 港の道場主ナギサ：活発な女性船乗り。短い波形のアクア髪、セーラー風の紺の上着、ロープ
    boss_minato: { skin: '#e8b888', hair: '#3ea8b4', main: '#243a68', sub: '#f4f4f0', accent: '#d8a030', accent2: '#3a4a58', dark: '#182030', build: 'lean', hairStyle: 'wavy', pose: 'hipRope', extra: 'collar' },
  };

  function bossMask(id) {
    const spec = BOSS_SPEC[id];
    const W = 32, H = 40, M = new Uint8Array(W * H);
    const cx = 16;
    const set = (x, y, v) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && x < W && y >= 0 && y < H) M[y * W + x] = v; };
    const rect = (x, y, w, h, v) => { const x0 = Math.round(x), y0 = Math.round(y); for (let j = y0; j < y0 + h; j++) for (let i = x0; i < x0 + w; i++) set(i, j, v); };
    const ell = (ex, ey, rx, ry, v) => {
      for (let y = Math.floor(ey - ry); y <= ey + ry; y++) for (let x = Math.floor(ex - rx); x <= ex + rx; x++) {
        if (((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 <= 1) set(x, y, v);
      }
    };
    // 台形（トルソー・脚・長い髪など、上下で幅が変わる帯）
    const trap = (tx, y0, y1, rx0, rx1, v) => {
      for (let y = Math.round(y0); y <= Math.round(y1); y++) {
        const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
        const rx = rx0 + (rx1 - rx0) * t;
        for (let x = Math.round(tx - rx); x <= Math.round(tx + rx); x++) set(x, y, v);
      }
    };
    const tri = (ax, ay, bx, by, cx2, cy2, v) => {
      const minx = Math.floor(Math.min(ax, bx, cx2)), maxx = Math.ceil(Math.max(ax, bx, cx2));
      const miny = Math.floor(Math.min(ay, by, cy2)), maxy = Math.ceil(Math.max(ay, by, cy2));
      const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx2, cy2), d3 = s(x, y, cx2, cy2, ax, ay);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) set(x, y, v);
      }
    };

    const heavy = spec.build === 'heavy', slim = spec.build === 'slim';
    const headRx = heavy ? 7.2 : slim ? 6.4 : 6.6, headRy = 7.3, headCy = 9;
    const shoulderY = heavy ? 18.5 : slim ? 17.5 : 18;
    const waistY = heavy ? 30 : 29;
    const torsoRxTop = heavy ? 12.5 : slim ? 9 : 9.5;
    const torsoRxBot = heavy ? 11.5 : slim ? 12 : 8.5;
    const legBot = 36, footY = 37;

    // 髪の土台 → 顔（肌） → 首・胴・脚・足
    ell(cx, headCy + 0.4, headRx + 1, headRy + 0.6, 1);
    ell(cx, headCy + 1.1, headRx - 0.6, headRy - 1.2, 2);
    rect(cx - 2, headCy + headRy - 2, 4, 4, 2);
    trap(cx, shoulderY, waistY, torsoRxTop, torsoRxBot, 3);
    trap(cx - 4.5, waistY, legBot, 3.6, 2.8, 8);
    trap(cx + 4.5, waistY, legBot, 3.6, 2.8, 8);
    rect(cx - 7.5, footY, 5, 2, 6); rect(cx + 2.5, footY, 5, 2, 6);
    // 服の縁の細部（帯・線）
    if (spec.pose === 'crossed') rect(cx - torsoRxTop + 2, waistY - 3, torsoRxTop * 2 - 4, 1, 8);
    else rect(cx - torsoRxTop + 1, shoulderY + 3, torsoRxTop * 2 - 2, 1, 8);

    // 髪型
    if (spec.hairStyle === 'spiky') {
      for (const dx of [-5, -1.5, 2, 5.5]) tri(cx + dx - 1.6, headCy - headRy + 1.5, cx + dx + 1.6, headCy - headRy + 1.5, cx + dx + (dx > 0 ? 1 : -1), headCy - headRy - 5, 1);
    } else if (spec.hairStyle === 'long') {
      trap(cx - headRx - 1.3, headCy, waistY + 4, 1.6, 2.4, 1);
      trap(cx + headRx + 1.3, headCy, waistY + 4, 1.6, 2.4, 1);
    } else if (spec.hairStyle === 'wavy') {
      for (const dx of [-headRx, -headRx * 0.35, headRx * 0.35, headRx]) ell(cx + dx, headCy + headRy - 2.2, 1.7, 1.3, 1);
    } else { // short
      rect(cx - headRx + 1, headCy - headRy, headRx * 2 - 2, 2, 1);
    }

    // 腕（ポーズごと）
    const armY = shoulderY + 1;
    if (spec.pose === 'crossed') {
      rect(cx - torsoRxTop + 1, armY + 2, torsoRxTop * 2 - 2, 3, 3);
      rect(cx - torsoRxTop + 1, armY + 6, torsoRxTop * 2 - 2, 3, 3);
      ell(cx - torsoRxTop + 2, armY + 3.5, 2, 1.8, 2);
      ell(cx + torsoRxTop - 2, armY + 7.5, 2, 1.8, 2);
    } else if (spec.pose === 'fistUp') {
      trap(cx - torsoRxTop - 1, armY, waistY, 2, 1.7, 3);
      ell(cx - torsoRxTop - 1, waistY + 1, 1.8, 1.6, 2);
      ell(cx + torsoRxTop + 0.5, armY + 3, 2.4, 3, 3);
      rect(cx + torsoRxTop - 1, armY - 8, 3, 8, 3);
      ell(cx + torsoRxTop + 0.5, armY - 9, 2.2, 2, 2);
    } else if (spec.pose === 'branch') {
      trap(cx - torsoRxTop - 1, armY, waistY - 1, 2.6, 3, 3);
      ell(cx - torsoRxTop - 0.5, waistY - 1, 2, 1.8, 3);
      rect(cx + 1, armY + 4, 3, 7, 3);
      ell(cx + 3, armY + 11, 1.8, 1.6, 2);
      rect(cx + 3, armY - 3, 1, 15, 9);
      ell(cx + 3, armY - 4, 2, 1.6, 7);
    } else if (spec.pose === 'hipRope') {
      rect(cx - torsoRxTop - 2, armY + 2, 3, 5, 3);
      ell(cx - torsoRxTop - 1, armY + 6, 1.8, 1.6, 2);
      trap(cx + torsoRxTop + 0.5, armY, waistY, 2.2, 1.8, 3);
      ell(cx + torsoRxTop + 0.5, waistY + 1, 2.2, 2, 7);
      ell(cx + torsoRxTop + 0.5, waistY + 1, 1, 1, 9);
    }

    // 顔（目・眉・口）
    const ey = headCy + 0.5;
    for (const s of [-1, 1]) {
      ell(cx + s * 3, ey, 1.3, 1.5, 4);
      ell(cx + s * 3 + s * 0.3, ey + 0.4, 0.7, 0.9, 5);
      rect(cx + s * 3 - 1, ey - 2.2, 2, 1, 6);
    }
    if (spec.pose === 'fistUp') { rect(cx - 1, headCy + 4, 3, 1, 6); rect(cx + 1, headCy + 3.4, 1, 1, 6); }
    else if (heavy) rect(cx - 2, headCy + 4.3, 4, 1, 6);
    else rect(cx - 1.5, headCy + 4, 3, 1, 6);

    // 装飾（キャラごとの特徴）
    if (spec.extra === 'scarf') {
      rect(cx - 3, shoulderY - 1, 6, 2, 7);
      tri(cx + 3, shoulderY, cx + 6, shoulderY + 6, cx + 2, shoulderY + 3, 7);
    } else if (spec.extra === 'amulet') {
      rect(cx - headRx + 2, headCy - 1, headRx * 2 - 4, 2, 7);
      rect(cx + headRx - 3, headCy - 1, 1, 3, 7);
      rect(cx, shoulderY, 1, 4, 6);
      ell(cx, shoulderY + 5, 1.8, 2, 9);
    } else if (spec.extra === 'leaf') {
      tri(cx - headRx + 1, headCy - headRy + 1, cx - headRx - 3, headCy - headRy - 2, cx - headRx + 3, headCy - headRy - 1, 7);
    } else if (spec.extra === 'collar') {
      tri(cx - 5, shoulderY - 1, cx + 5, shoulderY - 1, cx, shoulderY + 6, 8);
      rect(cx - 1, shoulderY + 3, 2, 2, 7);
    }

    return { M, W, H };
  }

  // ボストレーナーの立ち絵（32x40）。バトル画面では 64x80 相当で描画される想定。
  // 未知の id には null を返す。結果は person() 同様に内部キャッシュされる。
  function boss(id) {
    const spec = BOSS_SPEC[id];
    if (!spec) return null;
    const key = `boss|${id}`;
    if (cache.has(key)) return cache.get(key);
    const { M, W, H } = bossMask(id);
    const pal = [null, hex(spec.hair), hex(spec.skin), hex(spec.main), [255, 255, 255], [30, 26, 40],
      hex(spec.dark), hex(spec.accent), hex(spec.sub), hex(spec.accent2)];
    const img = shade(M, W, H, pal, { outline: 0.72 });
    cache.set(key, img);
    return img;
  }

  // ---- タイル（16px）----
  const tileCache = new Map();
  function tile(ch, env, v, frame) {
    const key = `${ch}|${env}|${v}|${frame}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const [c, x] = canvas(16, 16);
    const R = rng(hash(key));
    const px = (i, j, col) => { x.fillStyle = col; x.fillRect(i, j, 1, 1); };
    const fill = col => { x.fillStyle = col; x.fillRect(0, 0, 16, 16); };
    const speckle = (cols, n) => { for (let k = 0; k < n; k++) px((R() * 16) | 0, (R() * 16) | 0, cols[(R() * cols.length) | 0]); };
    const cave = env === 'cave';
    if (env === 'indoor') { indoorTile(x, ch, v, px, R); tileCache.set(key, c); return c; }
    const ground = () => {
      if (cave) { fill('#6a5a4a'); speckle(['#5a4a3c', '#7a6a58', '#806e5a'], 18); return; }
      fill('#78c060'); speckle(['#68b050', '#88d070', '#70b858'], 20);
      if (v % 7 === 0) { px(4, 5, '#f8f0f8'); px(5, 4, '#f8f0f8'); px(5, 6, '#f8f0f8'); px(6, 5, '#f8f0f8'); px(5, 5, '#f0d040'); }
      if (v % 11 === 3) { px(10, 11, '#f86080'); px(11, 10, '#f86080'); px(11, 12, '#f86080'); px(12, 11, '#f86080'); px(11, 11, '#fff0a0'); }
      if (v % 5 === 1) { px(3, 12, '#58a040'); px(4, 11, '#58a040'); px(5, 12, '#58a040'); }
    };
    switch (ch) {
      case '.': ground(); break;
      case 'p': // 出入口の土の道
        fill('#d8c088'); speckle(['#c8b078', '#e4d09c', '#bca070'], 14); break;
      case ':': fill('#6a5a4a'); speckle(['#5a4a3c', '#7a6a58', '#806e5a', '#4e4034'], 22); break;
      case ',': { // 草むら（揺れる）
        ground();
        const sway = frame % 2;
        for (let k = 0; k < 4; k++) {
          const bx = (k % 2) * 8 + 1, by = Math.floor(k / 2) * 8 + 2;
          x.fillStyle = '#2f7a38'; x.fillRect(bx, by + 2, 7, 5);
          x.fillStyle = '#48a048';
          x.fillRect(bx + sway, by, 1, 4); x.fillRect(bx + 3, by - 1 + sway, 1, 4); x.fillRect(bx + 5 + sway, by + 1, 1, 3);
          x.fillStyle = '#6cc860'; x.fillRect(bx + 1, by + 2, 1, 2); x.fillRect(bx + 4, by + 1, 1, 2);
          x.fillStyle = '#1e5a2a'; x.fillRect(bx, by + 6, 7, 1);
        }
        break;
      }
      case '#':
        if (cave) {
          fill('#4a3c30');
          x.fillStyle = '#5e4c3c'; x.fillRect(1, 1, 14, 10);
          x.fillStyle = '#7a6450'; x.fillRect(2, 2, 6, 3); x.fillRect(9, 5, 5, 2);
          x.fillStyle = '#3a2e24'; x.fillRect(0, 12, 16, 4); x.fillRect(8, 2, 1, 9);
          speckle(['#8a7460', '#34281e'], 6);
        } else { // 木
          ground();
          x.fillStyle = '#5a3a20'; x.fillRect(6, 11, 4, 5);
          x.fillStyle = '#7a5230'; x.fillRect(6, 11, 1, 5);
          x.fillStyle = '#1e5a30'; x.beginPath(); x.arc(8, 7, 7.5, 0, Math.PI * 2); x.fill();
          x.fillStyle = '#2e7a3e'; x.beginPath(); x.arc(7, 6, 6, 0, Math.PI * 2); x.fill();
          x.fillStyle = '#48a050'; x.beginPath(); x.arc(6, 5, 3.5, 0, Math.PI * 2); x.fill();
          x.fillStyle = '#6cc068'; x.fillRect(4, 3, 2, 1); x.fillRect(3, 4, 1, 2);
          x.fillStyle = '#16442a'; x.fillRect(3, 12, 4, 1); x.fillRect(10, 12, 3, 1);
        }
        break;
      case 'R': // 大岩
        cave ? (fill('#6a5a4a'), speckle(['#5a4a3c'], 10)) : ground();
        x.fillStyle = '#3e3a40'; x.beginPath(); x.ellipse(8, 9, 7.5, 6.5, 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#7a7480'; x.beginPath(); x.ellipse(8, 8.5, 6.5, 5.5, 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#a49eaa'; x.fillRect(4, 5, 4, 2); x.fillRect(3, 7, 2, 2);
        x.fillStyle = '#56505c'; x.fillRect(9, 9, 4, 1); x.fillRect(10, 10, 1, 3);
        break;
      case 'T': // 細い木（切れる茂み）
        ground();
        x.fillStyle = '#4a3020'; x.fillRect(7, 11, 2, 5);
        x.fillStyle = '#1e4a26'; x.beginPath(); x.moveTo(8, 1); x.lineTo(14, 12); x.lineTo(2, 12); x.fill();
        x.fillStyle = '#3a8a3e'; x.beginPath(); x.moveTo(8, 2); x.lineTo(12, 10); x.lineTo(4, 10); x.fill();
        x.fillStyle = '#6ac060'; x.fillRect(6, 5, 2, 1); x.fillRect(5, 7, 2, 1);
        break;
      case '~': { // 水（波がゆっくり動く）
        fill('#3a78d0');
        x.fillStyle = '#4a8ae0'; x.fillRect(0, 0, 16, 8);
        x.fillStyle = '#9ad0ff';
        const o = frame % 4;
        for (let k = 0; k < 3; k++) { const wx = (k * 6 + o * 2 + (v % 3)) % 16, wy = 3 + k * 5; x.fillRect(wx, wy, 4, 1); x.fillRect(wx + 1, wy - 1, 2, 1); }
        break;
      }
      case 'K': // 暗闇（灯りが要る）
        fill('#141018'); speckle(['#1e1a24', '#0c0a10', '#2a2432'], 16);
        x.fillStyle = '#3a3448'; x.fillRect(3, 4, 1, 1); x.fillRect(11, 9, 1, 1);
        break;
      case 'M': // 重い扉（鋲打ちの鉄扉）
        cave ? (fill('#6a5a4a'), speckle(['#5a4a3c'], 10)) : ground();
        x.fillStyle = '#3c4048'; x.fillRect(1, 1, 14, 15);
        x.fillStyle = '#6a707c'; x.fillRect(2, 2, 12, 13);
        x.fillStyle = '#4c525c'; x.fillRect(7, 2, 2, 13); x.fillRect(2, 8, 12, 1);
        x.fillStyle = '#b8bec8'; [[3, 3], [12, 3], [3, 13], [12, 13], [5, 6], [10, 6]].forEach(([i, j]) => x.fillRect(i, j, 1, 1));
        x.fillStyle = '#e0c060'; x.fillRect(9, 9, 2, 2);
        break;
      case 'E': { // 電気の柵（杭とジグザグの電線）
        cave ? (fill('#6a5a4a'), speckle(['#5a4a3c'], 10)) : ground();
        x.fillStyle = '#5a4a3a'; x.fillRect(1, 3, 2, 13); x.fillRect(13, 3, 2, 13);
        x.fillStyle = frame % 2 ? '#fff080' : '#f0d020';
        for (const wy of [5, 10]) for (let i = 3; i < 13; i++) x.fillRect(i, wy + ((i % 4) < 2 ? 0 : 1), 1, 1);
        x.fillStyle = '#c0c0c8'; x.fillRect(1, 2, 2, 1); x.fillRect(13, 2, 2, 1);
        break;
      }
      case 'W': // 崖（岩肌と段）
        fill('#8a6a48');
        x.fillStyle = '#a8845c'; x.fillRect(0, 0, 16, 3); x.fillRect(0, 7, 16, 2);
        x.fillStyle = '#5e452e'; x.fillRect(0, 3, 16, 1); x.fillRect(0, 9, 16, 1); x.fillRect(0, 15, 16, 1);
        x.fillStyle = '#6e5238'; x.fillRect(4, 4, 1, 3); x.fillRect(11, 10, 1, 4); x.fillRect(8, 1, 1, 2);
        speckle(['#9a7a54', '#704f34'], 8);
        break;
      case 'F': { // 吹雪（雪面と流れる風）
        fill('#e8f0f8'); speckle(['#d0dcec', '#ffffff', '#c4d4e8'], 22);
        x.fillStyle = '#a8c0dc';
        const o = frame % 4;
        for (let k = 0; k < 3; k++) { const wx = (k * 5 + o * 3) % 16, wy = 2 + k * 5; x.fillRect(wx, wy, 5, 1); x.fillRect((wx + 7) % 16, wy + 2, 3, 1); }
        break;
      }
      default: ground();
    }
    tileCache.set(key, c);
    return c;
  }

  // ---- 室内（床・壁・家具・玄関マット）----
  function indoorTile(x, ch, v, px, R) {
    const floor = () => {
      x.fillStyle = '#d8b884'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#c8a470'; x.fillRect(0, 7, 16, 1); x.fillRect(0, 15, 16, 1);
      x.fillRect((v % 3) * 5 + 2, 0, 1, 7); x.fillRect(((v >> 2) % 3) * 5 + 4, 8, 1, 7);
      x.fillStyle = '#e4c898'; x.fillRect(0, 0, 16, 1); x.fillRect(0, 8, 16, 1);
    };
    if (ch === '#') {
      x.fillStyle = '#f0e6d0'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#d8ccb0'; for (let i = 1; i < 16; i += 4) x.fillRect(i, 0, 1, 12);
      x.fillStyle = '#8a6a4a'; x.fillRect(0, 12, 16, 4);
      x.fillStyle = '#6a4a30'; x.fillRect(0, 15, 16, 1);
      return;
    }
    floor();
    if (ch === 'm') { // 玄関マット
      x.fillStyle = '#b04040'; x.fillRect(1, 3, 14, 10);
      x.fillStyle = '#d86060'; x.fillRect(2, 4, 12, 8);
      x.fillStyle = '#f0d060'; x.fillRect(3, 7, 10, 2);
      return;
    }
    if (ch !== 'D') return;
    const kind = v % 4;
    if (kind === 0) { // 本棚
      x.fillStyle = '#5a3a20'; x.fillRect(1, 0, 14, 15);
      x.fillStyle = '#7a5230'; x.fillRect(2, 1, 12, 13);
      x.fillStyle = '#5a3a20'; x.fillRect(2, 5, 12, 1); x.fillRect(2, 10, 12, 1);
      const cols = ['#c84848', '#4870c8', '#48a058', '#d8b040', '#8a58b8'];
      for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) { x.fillStyle = cols[(i + r + v) % 5]; x.fillRect(3 + i * 2, 2 + r * 5, 1, 3); }
    } else if (kind === 1) { // 鉢植え
      x.fillStyle = '#a05a30'; x.fillRect(4, 10, 8, 5); x.fillStyle = '#c07040'; x.fillRect(4, 10, 8, 1);
      x.fillStyle = '#2e7a3e'; x.beginPath(); x.arc(8, 7, 5.5, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#58b058'; x.fillRect(5, 4, 2, 2); x.fillRect(9, 6, 2, 2);
    } else if (kind === 2) { // 機械／棚
      x.fillStyle = '#5a6a80'; x.fillRect(1, 1, 14, 14);
      x.fillStyle = '#8a9ab0'; x.fillRect(2, 2, 12, 7);
      x.fillStyle = '#60d0f0'; x.fillRect(3, 3, 10, 5);
      x.fillStyle = (v & 16) ? '#f05050' : '#50e070'; x.fillRect(3, 11, 2, 2); x.fillStyle = '#f0d050'; x.fillRect(7, 11, 2, 2);
    } else { // カウンター・台
      x.fillStyle = '#6a4428'; x.fillRect(0, 3, 16, 12);
      x.fillStyle = '#a0703c'; x.fillRect(0, 3, 16, 4);
      x.fillStyle = '#c89050'; x.fillRect(0, 3, 16, 1);
      x.fillStyle = '#50341e'; x.fillRect(0, 14, 16, 1);
    }
  }

  // ---- 建物・置物 ----
  function building(kind) {
    const key = `b|${kind}`;
    if (cache.has(key)) return cache.get(key);
    const spec = {
      lab: { w: 48, h: 40, roof: '#5a78c8', wall: '#f0ece0', sign: 'lab' },
      heal: { w: 40, h: 34, roof: '#e05858', wall: '#fff4ec', sign: 'heal' },
      shop: { w: 40, h: 34, roof: '#4aa0d8', wall: '#fff4ec', sign: 'shop' },
      gym: { w: 56, h: 44, roof: '#8a6ab0', wall: '#e8e0d0', sign: 'gym' },
    }[kind];
    const [c, x] = canvas(spec.w, spec.h);
    const W = spec.w, H = spec.h, roofH = Math.round(H * 0.45);
    const roof = hex(spec.roof), wall = hex(spec.wall);
    // 影
    x.fillStyle = 'rgba(0,0,0,.22)'; x.fillRect(3, H - 3, W - 4, 3);
    // 壁
    x.fillStyle = rgb(dark(wall, 0.5)); x.fillRect(1, roofH - 1, W - 2, H - roofH - 1);
    x.fillStyle = rgb(wall); x.fillRect(2, roofH, W - 4, H - roofH - 3);
    x.fillStyle = rgb(dark(wall, 0.12)); x.fillRect(2, H - 7, W - 4, 4);
    // 窓
    x.fillStyle = '#3a5a80';
    for (const wx of [5, W - 13]) { x.fillRect(wx, roofH + 4, 8, 6); }
    x.fillStyle = '#9ad0f0';
    for (const wx of [5, W - 13]) { x.fillRect(wx + 1, roofH + 5, 6, 4); x.fillStyle = '#d8f0ff'; x.fillRect(wx + 1, roofH + 5, 2, 1); x.fillStyle = '#9ad0f0'; }
    // 扉（中央下、ここが調べる場所）
    const dx = W / 2 - 5;
    x.fillStyle = '#3a2a24'; x.fillRect(dx - 1, H - 15, 12, 12);
    x.fillStyle = kind === 'heal' ? '#f0a0a0' : kind === 'shop' ? '#90c8f0' : '#8a6a4a';
    x.fillRect(dx, H - 14, 10, 11);
    x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(dx + 1, H - 13, 3, 9);
    // 屋根
    x.fillStyle = rgb(dark(roof, 0.5));
    x.beginPath(); x.moveTo(-1, roofH + 1); x.lineTo(6, 0); x.lineTo(W - 6, 0); x.lineTo(W + 1, roofH + 1); x.fill();
    x.fillStyle = rgb(roof);
    x.beginPath(); x.moveTo(1, roofH - 1); x.lineTo(7, 1); x.lineTo(W - 7, 1); x.lineTo(W - 1, roofH - 1); x.fill();
    x.fillStyle = rgb(light(roof, 0.3));
    for (let y = 4; y < roofH - 1; y += 4) x.fillRect(6 - (y >> 2), y, W - 12 + (y >> 1), 1);
    x.fillStyle = rgb(light(roof, 0.5)); x.fillRect(7, 1, W - 14, 1);
    // 看板
    const sx = W / 2 - 6, sy = Math.max(2, roofH - 12);
    x.fillStyle = '#fffaf0'; x.fillRect(sx, sy, 12, 10);
    x.fillStyle = rgb(dark(roof, 0.4)); x.strokeStyle = rgb(dark(roof, 0.4)); x.lineWidth = 1; x.strokeRect(sx + 0.5, sy + 0.5, 11, 9);
    x.fillStyle = kind === 'heal' ? '#e03a3a' : rgb(dark(roof, 0.2));
    if (kind === 'heal') { x.fillRect(sx + 5, sy + 2, 2, 6); x.fillRect(sx + 3, sy + 4, 6, 2); }
    if (kind === 'shop') { x.fillRect(sx + 3, sy + 3, 6, 5); x.fillStyle = '#fffaf0'; x.fillRect(sx + 4, sy + 2, 4, 1); }
    if (kind === 'lab') { x.fillRect(sx + 5, sy + 2, 2, 3); x.beginPath(); x.moveTo(sx + 3, sy + 8); x.lineTo(sx + 9, sy + 8); x.lineTo(sx + 7, sy + 4); x.lineTo(sx + 5, sy + 4); x.fill(); }
    if (kind === 'gym') { x.beginPath(); x.arc(sx + 6, sy + 5, 3.5, 0, Math.PI * 2); x.fill(); x.fillStyle = '#ffd040'; x.fillRect(sx + 5, sy + 4, 2, 2); }
    cache.set(key, c);
    return c;
  }

  function tablet() {
    if (cache.has('tablet')) return cache.get('tablet');
    const [c, x] = canvas(16, 20);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(2, 17, 13, 3);
    x.fillStyle = '#4a4650'; x.fillRect(3, 3, 10, 15); x.fillRect(4, 2, 8, 1);
    x.fillStyle = '#8a8694'; x.fillRect(4, 3, 8, 14);
    x.fillStyle = '#aaa6b4'; x.fillRect(4, 3, 8, 2);
    x.fillStyle = '#5a5664'; for (let y = 7; y < 16; y += 3) x.fillRect(5, y, 6, 1);
    x.fillStyle = '#6aa050'; x.fillRect(3, 16, 2, 2); x.fillRect(11, 15, 2, 3);
    cache.set('tablet', c);
    return c;
  }

  // 立て札（木の板に 杭）
  function signpost() {
    if (cache.has('signpost')) return cache.get('signpost');
    const [c, x] = canvas(16, 20);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(4, 17, 9, 3);
    x.fillStyle = '#4a2c14'; x.fillRect(7, 10, 3, 8);
    x.fillStyle = '#8a5a30'; x.fillRect(8, 10, 1, 8);
    x.fillStyle = '#4a2c14'; x.fillRect(1, 2, 15, 10);
    x.fillStyle = '#b87c44'; x.fillRect(2, 3, 13, 8);
    x.fillStyle = '#d4a068'; x.fillRect(2, 3, 13, 2);
    x.fillStyle = '#6a4428'; for (let y = 6; y < 11; y += 2) x.fillRect(4, y, 9, 1);
    cache.set('signpost', c);
    return c;
  }

  // あずかり箱（休み処の中。木の箱に 結び紐）
  function box() {
    if (cache.has('box')) return cache.get('box');
    const [c, x] = canvas(16, 20);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(1, 17, 15, 3);
    x.fillStyle = '#4a2c14'; x.fillRect(1, 6, 14, 12);
    x.fillStyle = '#9a6434'; x.fillRect(2, 7, 12, 10);
    x.fillStyle = '#b87c44'; x.fillRect(2, 7, 12, 3);
    x.fillStyle = '#4a2c14'; x.fillRect(1, 10, 14, 1);
    x.fillStyle = '#6a4428'; x.fillRect(0, 4, 16, 3);
    x.fillStyle = '#c8905a'; x.fillRect(1, 4, 14, 1);
    x.fillStyle = '#d83838'; x.fillRect(7, 4, 2, 14);
    x.fillStyle = '#ffd040'; x.fillRect(6, 10, 4, 3);
    x.fillStyle = '#fff0a0'; x.fillRect(7, 11, 1, 1);
    cache.set('box', c);
    return c;
  }

  // 落ちている道具（小さな包みが きらりと光る。f=0/1 で光り方が変わる）
  function sparkle(f = 0) {
    const key = 'sparkle' + f;
    if (cache.has(key)) return cache.get(key);
    const [c, x] = canvas(16, 20);
    x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(4, 16, 9, 3);
    x.fillStyle = '#6a4428'; x.fillRect(5, 11, 7, 6);
    x.fillStyle = '#e8d8a8'; x.fillRect(6, 12, 5, 4);
    x.fillStyle = '#d83838'; x.fillRect(8, 11, 1, 6); x.fillRect(5, 13, 7, 1);
    const s = f ? 3 : 2;
    x.fillStyle = f ? '#ffffff' : '#fff0a0';
    x.fillRect(12, 7 - s, 1, s * 2 + 1); x.fillRect(12 - s, 7, s * 2 + 1, 1);
    cache.set(key, c);
    return c;
  }

  // ムスビカゴ。kind='iwai' は 白地に 紅白の結び紐（イワイムスビカゴ）
  function ball(open = 0, kind = '') {
    const key = `ball|${open}|${kind}`;
    if (cache.has(key)) return cache.get(key);
    const [c, x] = canvas(12, 12);
    const iwai = kind === 'iwai';
    x.fillStyle = iwai ? '#8a7a70' : '#3a2a1a'; x.beginPath(); x.arc(6, 6, 5.5, 0, Math.PI * 2); x.fill();
    x.fillStyle = iwai ? '#f4efe6' : '#c8a060'; x.beginPath(); x.arc(6, 6, 4.5, 0, Math.PI * 2); x.fill();
    x.fillStyle = iwai ? '#ffffff' : '#e8c890'; x.fillRect(3, 3, 3, 2);
    x.fillStyle = iwai ? '#d83838' : '#7a5a30'; x.fillRect(1, 5, 10, 1); x.fillRect(5, 1, 1, 10);
    x.fillStyle = iwai ? '#d83838' : '#f04848'; x.fillRect(5, 5, 2, 2);
    if (iwai) { x.fillStyle = '#ffffff'; x.fillRect(1, 6, 10, 1); x.fillRect(6, 1, 1, 10); }
    cache.set(key, c);
    return c;
  }

  return { monster, person, boss, BOSS_IDS, tile, building, tablet, signpost, box, sparkle, ball, styleFor, HERO, TYPE, typeColor, hex, rgb, light, dark, hash, rng, canvas };
})();

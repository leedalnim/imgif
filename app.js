// 움짤공방 — 모든 처리는 브라우저 안에서 합니다.
import { GIFEncoder, quantize, applyPalette } from './lib/gifenc.js';
import { parseGIF, decompressFrames } from './lib/gifuct.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9);

/* ---------- 설정값 ---------- */
const PREVIEW_LONG = 640;
const WORK_VIDEO = 720, WORK_PHOTO = 1080, WORK_GIF = 720;
const MAX_FRAMES = 360;
const PIXEL_BUDGET = 56e6; // 프레임 전체 픽셀 합 (메모리 보호)

const FONTS = [
  { id: 'plex', name: '기본', family: '"IBM Plex Sans KR"', weight: 700 },
  { id: 'bhs', name: '블랙한산스', family: '"Black Han Sans"', weight: 400 },
  { id: 'dohyeon', name: '도현', family: '"Do Hyeon"', weight: 400 },
  { id: 'jua', name: '주아', family: '"Jua"', weight: 400 },
  { id: 'gaegu', name: '개구', family: '"Gaegu"', weight: 700 },
  { id: 'pen', name: '손글씨', family: '"Nanum Pen Script"', weight: 400 },
  { id: 'batang', name: '바탕', family: '"Gowun Batang"', weight: 700 },
];
const FALLBACK_FONT = '"Apple SD Gothic Neo","Malgun Gothic",sans-serif';
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const COLORS = ['#ffffff', '#111111', '#ff5b3d', '#ffd23d', '#6bcf98', '#4aa3ff', '#b76bff', '#ff8fc7', '#8a5a3b'];
const EMOJIS = ['😂', '🤣', '😍', '🥹', '😭', '😎', '🥳', '😡', '🤔', '😴', '🤯', '😱', '🫠', '👍', '👏', '🙏', '💪', '🫶', '🔥', '✨', '💖', '💔', '💯', '🎉', '🎂', '🌈', '⭐', '🌙', '☀️', '⚡', '💤', '💦', '🍀', '🌸', '🐱', '🐶', '🐰', '🐻', '🐥', '🍕', '🍰', '☕', '🎮', '📸', '🎵', '❗', '❓', '➡️'];

/* ---------- 상태 ---------- */
const defaults = () => ({
  frames: [], sel: 0,
  delay: 0.1, baseDelay: 0.1, dir: 'fwd',
  ratio: 'orig', fit: 'fill', bg: 'blur', zoom: 1, panX: 0, panY: 0, rot: 0, flip: false,
  filter: 'none', adj: { bri: 0, con: 0, sat: 0, temp: 0, vig: 0 },
  layers: [], selLayer: null,
  strokes: [], pen: { color: '#ff5b3d', size: 0.02 },
  border: { w: 0, color: '#ffffff' },
  playing: true, pos: 0, tab: 'frames',
});
let S = defaults();
const out = { fmt: 'gif', long: 480, colors: 256, loop: 0, vloops: 1 };

/* ---------- 색 보정 (4x5 컬러 행렬) ---------- */
const ID = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
function mul(a, b) { // b를 먼저, 그다음 a
  const r = new Array(20);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[i * 5 + k] * b[k * 5 + j];
    if (j === 4) s += a[i * 5 + 4];
    r[i * 5 + j] = s;
  }
  return r;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const M = {
  bri: (v) => [1, 0, 0, 0, v * 90, 0, 1, 0, 0, v * 90, 0, 0, 1, 0, v * 90, 0, 0, 0, 1, 0],
  con: (v) => { const k = 1 + v, o = 128 * (1 - k); return [k, 0, 0, 0, o, 0, k, 0, 0, o, 0, 0, k, 0, o, 0, 0, 0, 1, 0]; },
  sat: (v) => { const s = 1 + v, r = 0.2126 * (1 - s), g = 0.7152 * (1 - s), b = 0.0722 * (1 - s); return [r + s, g, b, 0, 0, r, g + s, b, 0, 0, r, g, b + s, 0, 0, 0, 0, 0, 1, 0]; },
  temp: (v) => [1 + 0.1 * v, 0, 0, 0, 14 * v, 0, 1 + 0.02 * v, 0, 0, 0, 0, 0, 1 - 0.1 * v, 0, -14 * v, 0, 0, 0, 1, 0],
  sepia: (v) => mix(ID, [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0], v),
  fade: (v) => { const k = 1 - v / 255; return [k, 0, 0, 0, v, 0, k, 0, 0, v, 0, 0, k, 0, v, 0, 0, 0, 1, 0]; },
  tint: ([r, g, b]) => [1, 0, 0, 0, r, 0, 1, 0, 0, g, 0, 0, 1, 0, b, 0, 0, 0, 1, 0],
};
const PRESETS = [
  { id: 'none', name: '원본', ops: [] },
  { id: 'vivid', name: '선명', ops: [['sat', 0.35], ['con', 0.12]] },
  { id: 'warm', name: '따뜻', ops: [['temp', 0.7], ['sat', 0.08]] },
  { id: 'cool', name: '시원', ops: [['temp', -0.7], ['bri', 0.03]] },
  { id: 'film', name: '필름', ops: [['con', 0.12], ['temp', 0.2], ['sat', -0.12], ['fade', 18]] },
  { id: 'fade', name: '바랜', ops: [['con', -0.22], ['sat', -0.25], ['fade', 30]] },
  { id: 'vintage', name: '빈티지', ops: [['sepia', 0.45], ['con', -0.08], ['fade', 20], ['temp', 0.25]] },
  { id: 'sepia', name: '세피아', ops: [['sepia', 1]] },
  { id: 'mono', name: '흑백', ops: [['sat', -1]] },
  { id: 'noir', name: '누아르', ops: [['sat', -1], ['con', 0.5], ['bri', -0.05]] },
  { id: 'pink', name: '핑크', ops: [['tint', [18, -4, 12]], ['bri', 0.04], ['con', -0.06]] },
  { id: 'mint', name: '민트', ops: [['tint', [-12, 10, 6]], ['sat', -0.1]] },
];
function presetMatrix(id) {
  let m = ID;
  for (const [k, v] of (PRESETS.find((p) => p.id === id) || PRESETS[0]).ops) m = mul(M[k](v), m);
  return m;
}
function currentMatrix() {
  let m = presetMatrix(S.filter);
  const a = S.adj;
  if (a.bri) m = mul(M.bri(a.bri / 100), m);
  if (a.con) m = mul(M.con(a.con / 100), m);
  if (a.sat) m = mul(M.sat(a.sat / 100), m);
  if (a.temp) m = mul(M.temp(a.temp / 100), m);
  return m;
}
const isIdentity = (m) => m.every((v, i) => Math.abs(v - ID[i]) < 1e-4);
function applyMatrix(d, m) {
  const [a0, a1, a2, , a4, b0, b1, b2, , b4, c0, c1, c2, , c4] = m;
  for (let i = 0, n = d.length; i < n; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = a0 * r + a1 * g + a2 * b + a4;
    d[i + 1] = b0 * r + b1 * g + b2 * b + b4;
    d[i + 2] = c0 * r + c1 * g + c2 * b + c4;
  }
}

/* ---------- 프레임/시퀀스 ---------- */
function getSeq() {
  const act = S.frames.filter((f) => f.on);
  if (S.dir === 'rev') return act.slice().reverse();
  if (S.dir === 'boom') return act.concat(act.slice(1, -1).reverse());
  return act;
}
const fracOf = (i, n) => (n > 1 ? i / (n - 1) : 0);
function aspect() {
  if (S.ratio !== 'orig') { const [a, b] = S.ratio.split(':').map(Number); return a / b; }
  const f = S.frames.find((x) => x.on) || S.frames[0];
  if (!f) return 1;
  return S.rot % 180 ? f.h / f.w : f.w / f.h;
}
function sizeFor(long) {
  const A = aspect();
  let W, H;
  if (A >= 1) { W = long; H = Math.round(long / A); } else { H = long; W = Math.round(long * A); }
  W = Math.max(2, W + (W % 2)); H = Math.max(2, H + (H % 2));
  return { W, H };
}
function fitLong(w, h, long) {
  const s = Math.min(1, long / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
function usedPixels() { return S.frames.reduce((a, f) => a + f.w * f.h, 0); }
function allowedFrames(w, h) {
  return Math.max(0, Math.min(MAX_FRAMES - S.frames.length, Math.floor((PIXEL_BUDGET - usedPixels()) / (w * h))));
}
async function toBitmap(cnv) {
  if (self.createImageBitmap) { try { return await createImageBitmap(cnv); } catch (e) { /* 아래로 */ } }
  const c = document.createElement('canvas'); c.width = cnv.width; c.height = cnv.height;
  c.getContext('2d').drawImage(cnv, 0, 0);
  return c;
}
function makeThumb(src, w, h) {
  const t = document.createElement('canvas'); t.width = 112; t.height = 112;
  const x = t.getContext('2d'); const s = Math.max(112 / w, 112 / h);
  x.drawImage(src, (112 - w * s) / 2, (112 - h * s) / 2, w * s, h * s);
  return t;
}
async function makeFrame(cnv) {
  const bmp = await toBitmap(cnv);
  return { id: uid(), bmp, w: cnv.width, h: cnv.height, thumb: makeThumb(cnv, cnv.width, cnv.height), on: true };
}
function freeFrame(f) { try { f.bmp.close && f.bmp.close(); } catch (e) { /* 무시 */ } }

/* ---------- 렌더링 ---------- */
function geom(W, H, f) {
  const ew = S.rot % 180 ? f.h : f.w, eh = S.rot % 180 ? f.w : f.h;
  const base = S.fit === 'fill' ? Math.max(W / ew, H / eh) : Math.min(W / ew, H / eh);
  const sc = base * S.zoom;
  const exX = Math.abs(ew * sc - W) / 2, exY = Math.abs(eh * sc - H) / 2;
  return { sc, exX, exY, cx: W / 2 + S.panX * exX, cy: H / 2 + S.panY * exY };
}
function drawSource(ctx, W, H, f, g) {
  ctx.save();
  ctx.translate(g.cx, g.cy);
  if (S.flip) ctx.scale(-1, 1);
  ctx.rotate((S.rot * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f.bmp, (-f.w * g.sc) / 2, (-f.h * g.sc) / 2, f.w * g.sc, f.h * g.sc);
  ctx.restore();
}
const tinyA = document.createElement('canvas'), tinyB = document.createElement('canvas');
function drawBlurBg(ctx, W, H, f) {
  tinyA.width = 24; tinyA.height = Math.max(1, Math.round((24 * H) / W));
  const ta = tinyA.getContext('2d');
  const ew = S.rot % 180 ? f.h : f.w, eh = S.rot % 180 ? f.w : f.h;
  const sc = Math.max(tinyA.width / ew, tinyA.height / eh);
  ta.save(); ta.translate(tinyA.width / 2, tinyA.height / 2);
  if (S.flip) ta.scale(-1, 1);
  ta.rotate((S.rot * Math.PI) / 180);
  ta.drawImage(f.bmp, (-f.w * sc) / 2, (-f.h * sc) / 2, f.w * sc, f.h * sc);
  ta.restore();
  tinyB.width = 96; tinyB.height = Math.max(1, Math.round((96 * H) / W));
  const tb = tinyB.getContext('2d'); tb.imageSmoothingQuality = 'high';
  tb.drawImage(tinyA, 0, 0, tinyB.width, tinyB.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tinyB, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(0, 0, W, H);
}
function fontOf(L) {
  if (L.type === 'sticker') return { family: EMOJI_FONT, weight: 400 };
  const f = FONTS.find((x) => x.id === L.font) || FONTS[0];
  return { family: `${f.family},${FALLBACK_FONT}`, weight: f.weight };
}
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
const contrastOf = (hex) => (lum(hex) > 0.55 ? '#111111' : '#ffffff');
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawLayer(ctx, W, H, L, preview) {
  const base = Math.min(W, H), fs = L.size * base;
  const { family, weight } = fontOf(L);
  ctx.save();
  ctx.font = `${weight} ${fs}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = (L.text || ' ').split('\n');
  const lh = fs * (L.type === 'sticker' ? 1.05 : 1.18);
  const widths = lines.map((t) => ctx.measureText(t).width);
  const maxW = Math.max(...widths, fs * 0.3);
  const cx = L.x * W, cy = L.y * H, totalH = lh * lines.length, top = cy - totalH / 2;
  let pad = 0;
  if (L.type === 'text' && L.style === 'box') {
    pad = fs * 0.3;
    ctx.fillStyle = L.color;
    roundRect(ctx, cx - maxW / 2 - pad, top - pad * 0.55, maxW + pad * 2, totalH + pad * 1.1, fs * 0.28);
    ctx.fill();
  }
  const fill = L.type === 'text' && L.style === 'box' ? contrastOf(L.color) : L.color || '#fff';
  lines.forEach((t, i) => {
    const y = top + lh * (i + 0.5);
    if (L.type === 'text' && L.style === 'outline') {
      ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = fs * 0.17;
      ctx.strokeStyle = contrastOf(L.color); ctx.strokeText(t, cx, y);
    } else if (L.type === 'text' && L.style === 'plain') {
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = fs * 0.12; ctx.shadowOffsetY = fs * 0.04;
    }
    ctx.fillStyle = fill;
    ctx.fillText(t, cx, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  const bx = (maxW / 2 + pad + fs * 0.1) / W, by = (totalH / 2 + pad * 0.55 + fs * 0.05) / H;
  if (preview) L._box = { x0: L.x - bx, x1: L.x + bx, y0: L.y - by, y1: L.y + by };
}
function drawStrokes(ctx, W, H) {
  const base = Math.min(W, H);
  for (const s of S.strokes) {
    if (!s.pts.length) continue;
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = s.size * base; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const p = s.pts.map(([x, y]) => [x * W, y * H]);
    if (p.length === 1) {
      ctx.beginPath(); ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      const l = p[p.length - 1]; ctx.lineTo(l[0], l[1]); ctx.stroke();
    }
    ctx.restore();
  }
}
const visibleAt = (L, frac) => frac >= L.from - 1e-6 && frac <= L.to + 1e-6;

function renderFrame(ctx, W, H, f, frac, preview) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!f) return;
  const g = geom(W, H, f);
  if (S.fit === 'fit' || S.zoom < 1) {
    if (S.bg === 'blur') drawBlurBg(ctx, W, H, f);
    else { ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); }
  }
  drawSource(ctx, W, H, f, g);
  const m = currentMatrix();
  if (!isIdentity(m)) {
    const id = ctx.getImageData(0, 0, W, H);
    applyMatrix(id.data, m);
    ctx.putImageData(id, 0, 0);
  }
  if (S.adj.vig > 0) {
    const d = Math.hypot(W, H) / 2;
    const gr = ctx.createRadialGradient(W / 2, H / 2, d * 0.35, W / 2, H / 2, d);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, `rgba(0,0,0,${(S.adj.vig / 100) * 0.85})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
  if (S.border.w > 0) {
    const b = Math.max(1, Math.round(S.border.w * Math.min(W, H)));
    ctx.fillStyle = S.border.color;
    ctx.fillRect(0, 0, W, b); ctx.fillRect(0, H - b, W, b); ctx.fillRect(0, 0, b, H); ctx.fillRect(W - b, 0, b, H);
  }
  drawStrokes(ctx, W, H);
  for (const L of S.layers) {
    if (visibleAt(L, frac)) drawLayer(ctx, W, H, L, preview);
    else if (preview) L._box = null;
  }
  if (preview && S.selLayer && (S.tab === 'text' || S.tab === 'sticker')) {
    const L = S.layers.find((x) => x.id === S.selLayer);
    if (L && L._box) {
      ctx.save();
      ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = '#ff5b3d';
      ctx.strokeRect(L._box.x0 * W, L._box.y0 * H, (L._box.x1 - L._box.x0) * W, (L._box.y1 - L._box.y0) * H);
      ctx.restore();
    }
  }
}

/* ---------- 미리보기 ---------- */
const view = $('#view');
const vctx = view.getContext('2d', { willReadFrequently: true });
let dirty = true, lastStep = 0, curStripEl = null;
const markDirty = () => { dirty = true; };

function fitView() {
  const { W, H } = sizeFor(PREVIEW_LONG);
  if (view.width !== W || view.height !== H) { view.width = W; view.height = H; dirty = true; }
  const r = $('#stageInner').getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;
  const s = Math.min(r.width / W, r.height / H);
  view.style.width = `${Math.floor(W * s)}px`;
  view.style.height = `${Math.floor(H * s)}px`;
}
new ResizeObserver(() => { fitView(); markDirty(); }).observe($('#stageInner'));

function currentShown() {
  const seq = getSeq();
  if (!S.playing && S.tab === 'frames' && S.frames[S.sel]) {
    const f = S.frames[S.sel];
    const i = seq.indexOf(f);
    return { f, i: i < 0 ? 0 : i, n: seq.length, off: !f.on };
  }
  if (!seq.length) return { f: S.frames[0] || null, i: 0, n: 0 };
  S.pos %= seq.length;
  return { f: seq[S.pos], i: S.pos, n: seq.length };
}
const fmtTime = (s) => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
};
function draw() {
  const { W, H } = { W: view.width, H: view.height };
  const c = currentShown();
  renderFrame(vctx, W, H, c.f, fracOf(c.i, c.n), true);
  if (c.off) {
    vctx.fillStyle = 'rgba(0,0,0,.55)'; vctx.fillRect(0, 0, W, H);
    vctx.fillStyle = '#fff'; vctx.font = `700 ${Math.round(Math.min(W, H) * 0.07)}px "IBM Plex Sans KR",sans-serif`;
    vctx.textAlign = 'center'; vctx.textBaseline = 'middle'; vctx.fillText('빠진 프레임', W / 2, H / 2);
  }
  const total = c.n * S.delay;
  $('#tc').innerHTML = `${fmtTime(c.i * S.delay)} <small>/ ${fmtTime(total)}</small>`;
  $('#fpill').textContent = c.n ? `${c.i + 1} / ${c.n}` : '0 / 0';
  // 필름 스트립의 재생 위치 표시
  const el = c.f ? $(`#strip [data-id="${c.f.id}"]`) : null;
  if (el !== curStripEl) { curStripEl && curStripEl.classList.remove('cur'); el && el.classList.add('cur'); curStripEl = el; }
}
const editorEl = $('#editor'), trimSheetEl = $('#trimSheet');
function loop(now) {
  requestAnimationFrame(loop);
  if (trim && !trimSheetEl.hidden) trimHeadUpdate();
  if (editorEl.hidden) return;
  const seq = getSeq();
  if (S.playing && seq.length > 1) {
    const d = Math.max(20, S.delay * 1000);
    if (now - lastStep >= d) {
      S.pos = (S.pos + 1) % seq.length;
      lastStep = now - lastStep > d * 3 ? now : lastStep + d;
      dirty = true;
    }
  }
  if (dirty) { dirty = false; draw(); }
}
requestAnimationFrame(loop);

function setPlaying(p) {
  S.playing = p;
  const b = $('#playBtn');
  b.setAttribute('aria-label', p ? '일시정지' : '재생');
  b.innerHTML = `<svg class="ico fill"><use href="#${p ? 'i-pause' : 'i-play'}"/></svg>`;
  lastStep = performance.now();
  markDirty();
}
$('#playBtn').addEventListener('click', () => setPlaying(!S.playing));

/* ---------- 미리보기 터치: 위치·크기·그리기 ---------- */
const pointers = new Map();
let gesture = null;
function norm(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function hitLayer(p) {
  for (let i = S.layers.length - 1; i >= 0; i--) {
    const L = S.layers[i], b = L._box;
    if (b && p.x >= b.x0 - 0.02 && p.x <= b.x1 + 0.02 && p.y >= b.y0 - 0.02 && p.y <= b.y1 + 0.02) return L;
  }
  return null;
}
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { view.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const p = norm(e);
  if (pointers.size === 1) {
    if (S.tab === 'draw') {
      const stroke = { color: S.pen.color, size: S.pen.size, pts: [[p.x, p.y]] };
      S.strokes.push(stroke); gesture = { type: 'draw', stroke }; markDirty(); return;
    }
    const L = hitLayer(p);
    if (L) { selectLayer(L.id, true); gesture = { type: 'layer', L, last: p }; }
    else {
      if ((S.tab === 'text' || S.tab === 'sticker') && S.selLayer) { S.selLayer = null; renderLayerPanels(); markDirty(); }
      gesture = { type: 'pan', last: p };
    }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    if (gesture && gesture.type === 'draw' && gesture.stroke.pts.length < 3) S.strokes.pop();
    const target = gesture && gesture.type === 'layer' ? gesture.L : null;
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, target, start: target ? target.size : S.zoom };
  }
});
view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const p = norm(e);
  if (gesture.type === 'draw') {
    const last = gesture.stroke.pts[gesture.stroke.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.003) gesture.stroke.pts.push([clamp(p.x, 0, 1), clamp(p.y, 0, 1)]);
  } else if (gesture.type === 'layer') {
    const L = gesture.L;
    L.x = clamp(L.x + p.x - gesture.last.x, 0, 1); L.y = clamp(L.y + p.y - gesture.last.y, 0, 1);
    gesture.last = p;
  } else if (gesture.type === 'pan') {
    const c = currentShown();
    if (c.f) {
      const g = geom(view.width, view.height, c.f);
      if (g.exX > 1) S.panX = clamp(S.panX + ((p.x - gesture.last.x) * view.width) / g.exX, -1, 1);
      if (g.exY > 1) S.panY = clamp(S.panY + ((p.y - gesture.last.y) * view.height) / g.exY, -1, 1);
    }
    gesture.last = p;
  } else if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist;
    if (gesture.target) gesture.target.size = clamp(gesture.start * ratio, 0.03, 0.9);
    else { S.zoom = clamp(gesture.start * ratio, 0.5, 4); syncCanvasPane(); }
  }
  markDirty();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (gesture && (gesture.type === 'layer' || (gesture.type === 'pinch' && gesture.target))) syncLayerControls();
  if (pointers.size === 0 || (gesture && gesture.type === 'pinch')) gesture = null;
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const L = S.selLayer && (S.tab === 'text' || S.tab === 'sticker') ? S.layers.find((x) => x.id === S.selLayer) : null;
  const k = Math.exp(-e.deltaY * 0.0015);
  if (L) { L.size = clamp(L.size * k, 0.03, 0.9); syncLayerControls(); }
  else { S.zoom = clamp(S.zoom * k, 0.5, 4); syncCanvasPane(); }
  markDirty();
}, { passive: false });

/* ---------- 탭 ---------- */
const HINTS = {
  canvas: '미리보기를 끌어서 위치, 두 손가락으로 확대',
  text: '글자를 끌어서 옮기고, 두 손가락으로 크기 조절',
  sticker: '스티커를 끌어서 옮기고, 두 손가락으로 크기 조절',
  draw: '미리보기 위에 그려보세요',
};
let hintTimer;
function setTab(t) {
  S.tab = t;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.pane[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  $('#panel').scrollTop = 0;
  const h = $('#stageHint');
  if (HINTS[t] && S.frames.length) {
    h.textContent = HINTS[t]; h.hidden = false;
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { h.hidden = true; }, 2600);
  } else h.hidden = true;
  if (t === 'filter') renderFxThumbs();
  if (t === 'text' || t === 'sticker') {
    const L = S.layers.find((x) => x.id === S.selLayer);
    if (L && L.type !== (t === 'text' ? 'text' : 'sticker')) S.selLayer = null;
    renderLayerPanels();
  }
  if (t === 'frames') renderStrip();
  markDirty();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ---------- 프레임 탭 ---------- */
function renderStrip() {
  const strip = $('#strip');
  strip.textContent = '';
  S.frames.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = `fr${i === S.sel ? ' sel' : ''}${f.on ? '' : ' off'}`;
    b.dataset.id = f.id; b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === S.sel));
    b.setAttribute('aria-label', `${i + 1}번 프레임${f.on ? '' : ' (빠짐)'}`);
    b.appendChild(f.thumb);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1; b.appendChild(n);
    b.addEventListener('click', () => {
      S.sel = i; setPlaying(false); renderStrip(); syncFrameTools();
    });
    strip.appendChild(b);
  });
  curStripEl = null;
  syncFrameTools();
  const sel = strip.children[S.sel];
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  markDirty();
}
function syncFrameTools() {
  const f = S.frames[S.sel];
  const t = $('#frToggle');
  t.querySelector('span').textContent = f && !f.on ? '다시 넣기' : '빼기';
  ['#frToggle', '#frLeft', '#frRight', '#frDup', '#frDel'].forEach((id) => { $(id).disabled = !f; });
  $('#frLeft').disabled = !f || S.sel === 0;
  $('#frRight').disabled = !f || S.sel === S.frames.length - 1;
}
function framesChanged() {
  S.sel = clamp(S.sel, 0, Math.max(0, S.frames.length - 1));
  fitView(); renderStrip(); syncInfo(); syncSpeedPane(); markDirty();
}
$('#frToggle').addEventListener('click', () => {
  const f = S.frames[S.sel]; if (!f) return;
  if (f.on && S.frames.filter((x) => x.on).length === 1) return toast('최소 한 프레임은 남겨야 해요');
  f.on = !f.on; framesChanged();
});
$('#frLeft').addEventListener('click', () => {
  const i = S.sel; if (i < 1) return;
  [S.frames[i - 1], S.frames[i]] = [S.frames[i], S.frames[i - 1]]; S.sel = i - 1; framesChanged();
});
$('#frRight').addEventListener('click', () => {
  const i = S.sel; if (i >= S.frames.length - 1) return;
  [S.frames[i + 1], S.frames[i]] = [S.frames[i], S.frames[i + 1]]; S.sel = i + 1; framesChanged();
});
$('#frDup').addEventListener('click', async () => {
  const f = S.frames[S.sel]; if (!f) return;
  if (allowedFrames(f.w, f.h) < 1) return toast('프레임이 너무 많아서 더 넣을 수 없어요');
  const c = document.createElement('canvas'); c.width = f.w; c.height = f.h; c.getContext('2d').drawImage(f.bmp, 0, 0);
  const nf = await makeFrame(c);
  S.frames.splice(S.sel + 1, 0, nf); S.sel += 1; framesChanged();
});
$('#frDel').addEventListener('click', () => {
  const f = S.frames[S.sel]; if (!f) return;
  if (S.frames.length === 1) return toast('마지막 프레임은 지울 수 없어요');
  freeFrame(f); S.frames.splice(S.sel, 1); framesChanged();
});

/* ---------- 속도 탭 ---------- */
const spd = $('#spd');
// 슬라이더는 오른쪽(🐇)으로 갈수록 빠르게: 값이 클수록 프레임 간격이 짧아짐 (2초 ~ 0.02초, 로그 눈금)
const delayToV = (d) => 1000 - Math.round((1000 * Math.log(d / 0.02)) / Math.log(100));
const vToDelay = (v) => 0.02 * Math.pow(100, (1000 - v) / 1000);
function speedName(m) {
  if (Math.abs(m - 1) < 0.05) return '원래 속도';
  if (m >= 3) return '아주 빠르게';
  if (m > 1) return '빠르게';
  if (m <= 1 / 3) return '아주 느리게';
  return '느리게';
}
function syncSpeedPane() {
  spd.value = delayToV(S.delay);
  const mul = (S.baseDelay || S.delay) / S.delay;
  $('#spdMul').textContent = '×' + (mul >= 10 ? mul.toFixed(0) : mul < 1 ? mul.toFixed(2).replace(/0$/, '') : mul.toFixed(1));
  $('#spdName').textContent = speedName(mul);
  $('#spdRead').textContent = S.delay.toFixed(2);
  $('#spdTotal').textContent = (getSeq().length * S.delay).toFixed(1);
  $$('#dirSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === S.dir)));
  $$('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(S.baseDelay * Number(b.dataset.speed) - S.delay) < 0.005)));
  syncInfo();
}
spd.addEventListener('input', () => { S.delay = Math.round(vToDelay(Number(spd.value)) * 100) / 100 || 0.02; syncSpeedPane(); });
$$('[data-speed]').forEach((b) => b.addEventListener('click', () => {
  S.delay = clamp(Math.round(S.baseDelay * Number(b.dataset.speed) * 100) / 100, 0.02, 2); syncSpeedPane();
}));
$$('#dirSeg button').forEach((b) => b.addEventListener('click', () => { S.dir = b.dataset.dir; S.pos = 0; syncSpeedPane(); markDirty(); }));
function syncInfo() {
  const n = getSeq().length;
  const { W, H } = sizeFor(out.long);
  $('#info').textContent = `${n}프레임 · ${(n * S.delay).toFixed(1)}초 · ${W}×${H}`;
}

/* ---------- 캔버스 탭 ---------- */
function buildSwatches(el, { blur = false, get, set }) {
  el.textContent = '';
  const items = [...(blur ? ['blur'] : []), ...COLORS];
  for (const c of items) {
    const b = document.createElement('button');
    b.className = 'sw'; b.dataset.c = c;
    if (c === 'blur') { b.style.background = 'radial-gradient(circle at 35% 35%, #ffd9c4, #8d6e86 55%, #2a2f4a)'; b.style.filter = 'blur(.4px)'; b.setAttribute('aria-label', '흐린 배경'); }
    else { b.style.background = c; b.setAttribute('aria-label', `색 ${c}`); }
    b.addEventListener('click', () => { set(c); sync(); });
    el.appendChild(b);
  }
  const lab = document.createElement('label');
  lab.className = 'sw sw-custom'; lab.setAttribute('aria-label', '다른 색 고르기');
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = '#ff5b3d';
  inp.addEventListener('input', () => { set(inp.value); sync(); });
  lab.appendChild(inp); el.appendChild(lab);
  function sync() {
    const v = get();
    $$('.sw', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === v || (!b.dataset.c && !items.includes(v)))));
    markDirty();
  }
  sync();
  return sync;
}
const syncBg = buildSwatches($('#bgSw'), { blur: true, get: () => S.bg, set: (c) => { S.bg = c; if (S.fit === 'fill' && S.zoom >= 1) { S.fit = 'fit'; syncCanvasPane(); } } });
function syncCanvasPane() {
  $$('#ratioRow .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ratio === S.ratio)));
  $$('#fitSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fit === S.fit)));
  $('#zoom').value = Math.round(S.zoom * 100);
  $('#zoomOut').textContent = `${Math.round(S.zoom * 100)}%`;
  syncBg();
}
$$('#ratioRow .chip').forEach((b) => b.addEventListener('click', () => { S.ratio = b.dataset.ratio; S.panX = S.panY = 0; syncCanvasPane(); fitView(); syncInfo(); markDirty(); }));
$$('#fitSeg button').forEach((b) => b.addEventListener('click', () => { S.fit = b.dataset.fit; S.panX = S.panY = 0; syncCanvasPane(); markDirty(); }));
$('#zoom').addEventListener('input', (e) => { S.zoom = Number(e.target.value) / 100; $('#zoomOut').textContent = `${e.target.value}%`; markDirty(); });
$('#rot').addEventListener('click', () => { S.rot = (S.rot + 90) % 360; S.panX = S.panY = 0; fitView(); syncInfo(); markDirty(); });
$('#flip').addEventListener('click', () => { S.flip = !S.flip; markDirty(); });
$('#center').addEventListener('click', () => { S.panX = S.panY = 0; S.zoom = 1; syncCanvasPane(); markDirty(); });

/* ---------- 필터 탭 ---------- */
function buildFx() {
  const row = $('#fxRow'); row.textContent = '';
  for (const p of PRESETS) {
    const b = document.createElement('button'); b.dataset.fx = p.id;
    const c = document.createElement('canvas'); c.width = 124; c.height = 124;
    b.appendChild(c); b.append(p.name);
    b.addEventListener('click', () => { S.filter = p.id; syncFilterPane(); markDirty(); });
    row.appendChild(b);
  }
}
function renderFxThumbs() {
  const c = currentShown(); const f = c.f;
  for (const b of $$('#fxRow button')) {
    const cv = b.querySelector('canvas'); const x = cv.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000'; x.fillRect(0, 0, 124, 124);
    if (!f) continue;
    const s = Math.max(124 / f.w, 124 / f.h);
    x.drawImage(f.bmp, (124 - f.w * s) / 2, (124 - f.h * s) / 2, f.w * s, f.h * s);
    const m = presetMatrix(b.dataset.fx);
    if (!isIdentity(m)) { const id = x.getImageData(0, 0, 124, 124); applyMatrix(id.data, m); x.putImageData(id, 0, 0); }
  }
}
function syncFilterPane() {
  $$('#fxRow button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fx === S.filter)));
  $$('[data-adj]').forEach((r) => { r.value = S.adj[r.dataset.adj]; r.nextElementSibling.textContent = S.adj[r.dataset.adj]; });
}
$$('[data-adj]').forEach((r) => r.addEventListener('input', () => {
  S.adj[r.dataset.adj] = Number(r.value); r.nextElementSibling.textContent = r.value; markDirty();
}));
$('#adjReset').addEventListener('click', () => { S.adj = { bri: 0, con: 0, sat: 0, temp: 0, vig: 0 }; syncFilterPane(); markDirty(); });

/* ---------- 텍스트·스티커 ---------- */
function selectLayer(id, fromCanvas) {
  S.selLayer = id;
  const L = S.layers.find((x) => x.id === id);
  if (fromCanvas && L) {
    const want = L.type === 'text' ? 'text' : 'sticker';
    if (S.tab !== want) setTab(want); else renderLayerPanels();
  } else renderLayerPanels();
  markDirty();
}
function loadFont(L) {
  if (L.type !== 'text' || !document.fonts) return;
  const f = FONTS.find((x) => x.id === L.font) || FONTS[0];
  document.fonts.load(`${f.weight} 48px ${f.family}`, L.text || '가').then(markDirty, () => {});
}
async function ensureFonts() {
  if (!document.fonts) return;
  await Promise.all(S.layers.filter((L) => L.type === 'text').map((L) => {
    const f = FONTS.find((x) => x.id === L.font) || FONTS[0];
    return document.fonts.load(`${f.weight} 48px ${f.family}`, L.text || '가').catch(() => {});
  }));
}
function rangeControls(L) {
  const wrap = document.createElement('div'); wrap.className = 'pane'; wrap.style.gap = '6px';
  const mk = (key, label) => {
    const row = document.createElement('div'); row.className = 'slider';
    row.innerHTML = `<span class="label">${label}</span><input type="range" min="0" max="1000" aria-label="표시 ${label}"><output></output>`;
    const inp = row.querySelector('input'), o = row.querySelector('output');
    const syncO = () => { const n = getSeq().length; o.textContent = `${Math.round(L[key] * Math.max(0, n - 1)) + 1}번째`; };
    inp.value = Math.round(L[key] * 1000); syncO();
    inp.addEventListener('input', () => {
      L[key] = Number(inp.value) / 1000;
      if (key === 'from' && L.from > L.to) L.to = L.from;
      if (key === 'to' && L.to < L.from) L.from = L.to;
      $$('input', wrap).forEach((x, i) => { x.value = Math.round((i ? L.to : L.from) * 1000); });
      $$('output', wrap).forEach((x, i) => { const n = getSeq().length; x.textContent = `${Math.round((i ? L.to : L.from) * Math.max(0, n - 1)) + 1}번째`; });
      markDirty();
    });
    return row;
  };
  wrap.append(mk('from', '나타남'), mk('to', '사라짐'));
  return wrap;
}
function chipRow(items, current, onPick, styleFn) {
  const row = document.createElement('div'); row.className = 'row scroll';
  for (const it of items) {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = it.name;
    b.setAttribute('aria-pressed', String(it.id === current));
    if (styleFn) styleFn(b, it);
    b.addEventListener('click', () => { $$('.chip', row).forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); onPick(it.id); });
    row.appendChild(b);
  }
  return row;
}
function sizeSlider(L) {
  const row = document.createElement('div'); row.className = 'slider';
  row.innerHTML = '<span class="label">크기</span><input type="range" min="3" max="90" data-size aria-label="크기"><output></output>';
  const inp = row.querySelector('input'), o = row.querySelector('output');
  const s = () => { inp.value = Math.round(L.size * 100); o.textContent = `${Math.round(L.size * 100)}`; };
  s(); inp.addEventListener('input', () => { L.size = Number(inp.value) / 100; o.textContent = inp.value; markDirty(); });
  row._sync = s; return row;
}
function deleteBtn(L) {
  const b = document.createElement('button'); b.className = 'chip';
  b.innerHTML = '<svg class="ico"><use href="#i-trash"/></svg>지우기';
  b.addEventListener('click', () => { S.layers = S.layers.filter((x) => x !== L); S.selLayer = null; renderLayerPanels(); markDirty(); });
  return b;
}
function renderLayerPanels() {
  // 텍스트 목록
  const list = $('#textLayers'); list.textContent = '';
  S.layers.filter((L) => L.type === 'text').forEach((L, i) => {
    const b = document.createElement('button'); b.className = 'chip';
    b.textContent = (L.text || '빈 글자').split('\n')[0].slice(0, 8) || `글자 ${i + 1}`;
    b.setAttribute('aria-pressed', String(L.id === S.selLayer));
    b.addEventListener('click', () => selectLayer(L.id));
    list.appendChild(b);
  });
  const L = S.layers.find((x) => x.id === S.selLayer);
  // 텍스트 편집
  const te = $('#textEdit'); te.textContent = '';
  if (L && L.type === 'text') {
    const ta = document.createElement('textarea'); ta.value = L.text; ta.setAttribute('aria-label', '글자 내용'); ta.rows = 2;
    ta.addEventListener('input', () => { L.text = ta.value; loadFont(L); markDirty(); const chip = $('#textLayers .chip[aria-pressed="true"]'); if (chip) chip.textContent = (L.text || '빈 글자').split('\n')[0].slice(0, 8) || '빈 글자'; });
    const fonts = chipRow(FONTS, L.font, (id) => { L.font = id; loadFont(L); markDirty(); }, (b, it) => { b.style.fontFamily = `${it.family},sans-serif`; b.style.fontWeight = it.weight; });
    fonts.classList.add('fonts');
    const sw = document.createElement('div'); sw.className = 'row';
    sw.innerHTML = '<span class="label">색</span>'; const swEl = document.createElement('div'); swEl.className = 'swatches'; sw.appendChild(swEl);
    buildSwatches(swEl, { get: () => L.color, set: (c) => { L.color = c; } });
    const st = document.createElement('div'); st.className = 'row'; st.innerHTML = '<span class="label">스타일</span>';
    const seg = document.createElement('div'); seg.className = 'seg';
    [['plain', '그림자'], ['outline', '외곽선'], ['box', '박스']].forEach(([id, name]) => {
      const b = document.createElement('button'); b.textContent = name; b.setAttribute('aria-pressed', String(L.style === id));
      b.addEventListener('click', () => { L.style = id; $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); markDirty(); });
      seg.appendChild(b);
    });
    st.appendChild(seg);
    const tools = document.createElement('div'); tools.className = 'tools'; tools.appendChild(deleteBtn(L));
    te.append(ta, fonts, sizeSlider(L), sw, st, rangeControls(L), tools);
  } else {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = S.layers.some((x) => x.type === 'text') ? '고칠 글자를 위에서 고르거나, 미리보기에서 글자를 눌러요.' : '‘글자 추가’를 눌러 움짤에 글자를 넣어요.';
    te.appendChild(e);
  }
  // 스티커 편집
  const se = $('#stickerEdit'); se.textContent = '';
  if (L && L.type === 'sticker') {
    const head = document.createElement('div'); head.className = 'row';
    head.innerHTML = `<span class="label">고른 스티커</span><span style="font-size:26px;font-family:${EMOJI_FONT}">${L.text}</span>`;
    const tools = document.createElement('div'); tools.className = 'tools'; tools.appendChild(deleteBtn(L));
    se.append(head, sizeSlider(L), rangeControls(L), tools);
  }
}
function syncLayerControls() {
  const r = $('#textEdit [data-size]') || $('#stickerEdit [data-size]');
  if (r && r.parentElement._sync) r.parentElement._sync();
}
$('#addText').addEventListener('click', () => {
  const n = S.layers.filter((x) => x.type === 'text').length;
  const L = { id: uid(), type: 'text', text: '글자를 입력하세요', font: 'plex', size: 0.1, color: '#ffffff', style: 'outline', x: 0.5, y: clamp(0.82 - n * 0.14, 0.15, 0.85), from: 0, to: 1 };
  S.layers.push(L); loadFont(L); selectLayer(L.id);
  const ta = $('#textEdit textarea'); if (ta) { ta.focus(); ta.select(); }
});
function buildEmoji() {
  const g = $('#emojiGrid');
  for (const e of EMOJIS) {
    const b = document.createElement('button'); b.textContent = e; b.setAttribute('aria-label', `${e} 스티커 넣기`);
    b.addEventListener('click', () => {
      const L = { id: uid(), type: 'sticker', text: e, size: 0.22, x: clamp(0.5 + (Math.random() - 0.5) * 0.3, 0.15, 0.85), y: clamp(0.45 + (Math.random() - 0.5) * 0.3, 0.15, 0.85), from: 0, to: 1 };
      S.layers.push(L); selectLayer(L.id);
    });
    g.appendChild(b);
  }
}

/* ---------- 그리기 / 테두리 ---------- */
buildSwatches($('#penSw'), { get: () => S.pen.color, set: (c) => { S.pen.color = c; } });
$('#penSize').addEventListener('input', (e) => { S.pen.size = Number(e.target.value) / 1000; $('#penOut').textContent = e.target.value; });
$('#penUndo').addEventListener('click', () => { S.strokes.pop(); markDirty(); });
$('#penClear').addEventListener('click', () => { S.strokes = []; markDirty(); });
const syncBd = buildSwatches($('#bdSw'), { get: () => S.border.color, set: (c) => { S.border.color = c; if (!S.border.w) { S.border.w = 0.03; syncBorder(); } } });
function syncBorder() { $('#bw').value = Math.round(S.border.w * 1000); $('#bwOut').textContent = Math.round(S.border.w * 1000); }
$('#bw').addEventListener('input', (e) => { S.border.w = Number(e.target.value) / 1000; $('#bwOut').textContent = e.target.value; markDirty(); });

function syncAll() {
  syncSpeedPane(); syncCanvasPane(); syncFilterPane(); syncBorder(); syncBd();
  $('#penSize').value = Math.round(S.pen.size * 1000); $('#penOut').textContent = Math.round(S.pen.size * 1000);
  renderLayerPanels(); syncInfo();
}

/* ---------- 화면 틀: 고정 상단 막대 + 스크롤 영역(#root) ---------- */
// 상단 막대 높이를 재서 --tbh에 넣는다. #root가 그 아래에서 시작해야 iOS가 상태바 쪽에 흐림을 그리지 않음.
const topbar = $('.topbar');
const scroller = () => document.getElementById('root');
function setTopbarH() {
  document.documentElement.style.setProperty('--tbh', Math.ceil(topbar.getBoundingClientRect().height) + 'px');
}
setTopbarH();
if (window.ResizeObserver) new ResizeObserver(setTopbarH).observe(topbar); else addEventListener('resize', setTopbarH);
// 아래에서 올라오는 창이 하나라도 열려 있으면 뒤 화면 스크롤 잠금
const sheetWraps = $$('.sheet-wrap');
const syncLock = () => document.documentElement.classList.toggle('lock', sheetWraps.some((w) => !w.hidden));
new MutationObserver(syncLock).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
function showScreen(editing) {
  $('#home').hidden = editing; $('#editor').hidden = !editing; topbar.hidden = !editing;
  document.documentElement.classList.toggle('editing', editing);
  setTopbarH(); scroller().scrollTo(0, 0);
}

/* ---------- 화면 전환 ---------- */
function openEditor() {
  showScreen(true);
  stopDemo();
  setTab(S.tab || 'frames');
  syncAll(); fitView(); setPlaying(true);
}
function goHome() {
  S.frames.forEach(freeFrame);
  S = defaults();
  showScreen(false);
  startDemo();
}
$('#goHome').addEventListener('click', () => { $('#confirmSheet').hidden = false; $('#cfNo').focus(); });
$('#cfNo').addEventListener('click', () => { $('#confirmSheet').hidden = true; });
$('#cfYes').addEventListener('click', () => { $('#confirmSheet').hidden = true; goHome(); });

function addFrames(list, delay) {
  if (!list.length) return;
  const wasEmpty = S.frames.length === 0;
  const at = wasEmpty ? 0 : S.frames.length;
  S.frames.push(...list);
  if (wasEmpty) { S.delay = S.baseDelay = clamp(Math.round(delay * 100) / 100, 0.02, 2); S.sel = 0; S.pos = 0; }
  else S.sel = at;
  if ($('#editor').hidden) openEditor();
  else { framesChanged(); syncAll(); }
}

/* ---------- 바쁨 표시 ---------- */
let cancelFlag = false;
function busy(text, sub = '') {
  cancelFlag = false;
  $('#busyText').textContent = text; $('#busySub').textContent = sub; $('#busyBar').style.width = '0%';
  $('#busy').hidden = false;
}
const busyProg = (p, sub) => { $('#busyBar').style.width = `${Math.round(p * 100)}%`; if (sub != null) $('#busySub').textContent = sub; };
const busyEnd = () => { $('#busy').hidden = true; };
$('#busyCancel').addEventListener('click', () => { cancelFlag = true; });
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- 가져오기: 사진 ---------- */
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    img.src = url;
  });
}
async function importPhotos(files, { quiet = false } = {}) {
  files = [...files].filter(Boolean);
  cancelFlag = false;
  if (!files.length) return;
  if (!quiet) busy('사진 불러오는 중', `0 / ${files.length}`);
  const list = []; let fail = 0, capped = false;
  for (let i = 0; i < files.length; i++) {
    if (cancelFlag) break;
    try {
      const img = await loadImage(files[i]);
      const { w, h } = fitLong(img.naturalWidth, img.naturalHeight, WORK_PHOTO);
      if (allowedFrames(w, h) - list.length < 1) { capped = true; break; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      list.push(await makeFrame(c));
    } catch (e) { fail++; }
    if (!quiet) busyProg((i + 1) / files.length, `${i + 1} / ${files.length}`);
  }
  if (!quiet) busyEnd();
  addFrames(list, 0.5);
  if (fail) toast(`${fail}장은 열 수 없는 형식이라 건너뛰었어요`);
  else if (capped) toast('프레임이 너무 많아서 일부만 가져왔어요');
  else if (list.length) toast(`사진 ${list.length}장을 넣었어요`);
}

/* ---------- 가져오기: GIF ---------- */
async function importGif(file) {
  if (file.type && file.type !== 'image/gif') return importPhotos([file]);
  busy('GIF 풀어보는 중');
  try {
    const buf = await file.arrayBuffer();
    const gif = parseGIF(buf);
    const raw = decompressFrames(gif, true);
    const GW = gif.lsd.width, GH = gif.lsd.height;
    const full = document.createElement('canvas'); full.width = GW; full.height = GH;
    const fx = full.getContext('2d', { willReadFrequently: true });
    const patch = document.createElement('canvas'); const px = patch.getContext('2d');
    const { w, h } = fitLong(GW, GH, WORK_GIF);
    const outC = document.createElement('canvas'); outC.width = w; outC.height = h; const ox = outC.getContext('2d');
    const n = Math.min(raw.length, allowedFrames(w, h));
    const list = []; let delaySum = 0;
    for (let i = 0; i < n; i++) {
      if (cancelFlag) break;
      const f = raw[i];
      const prev = f.disposalType === 3 ? fx.getImageData(0, 0, GW, GH) : null;
      patch.width = f.dims.width; patch.height = f.dims.height;
      px.putImageData(new ImageData(f.patch, f.dims.width, f.dims.height), 0, 0);
      fx.drawImage(patch, f.dims.left, f.dims.top);
      ox.clearRect(0, 0, w, h); ox.drawImage(full, 0, 0, w, h);
      list.push(await makeFrame(outC));
      delaySum += f.delay || 100;
      if (f.disposalType === 2) fx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
      else if (prev) fx.putImageData(prev, 0, 0);
      busyProg((i + 1) / n, `${i + 1} / ${n} 프레임`);
      if (i % 8 === 7) await sleep(0);
    }
    busyEnd();
    if (!list.length) return toast('GIF에서 프레임을 찾지 못했어요');
    addFrames(list, delaySum / list.length / 1000);
    toast(n < raw.length ? `프레임이 많아서 앞쪽 ${n}장만 가져왔어요` : `GIF ${list.length}프레임을 열었어요`);
  } catch (e) {
    busyEnd(); toast('이 GIF는 열 수 없어요. 다른 파일로 해볼까요?');
  }
}

/* ---------- 가져오기: 동영상 (구간 고르기) ---------- */
let trim = null;
const tv = $('#trimVideo');
function seekTo(v, t) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); clearTimeout(to); res(); };
    const to = setTimeout(fin, 2500);
    v.addEventListener('seeked', fin);
    v.currentTime = Math.abs(v.currentTime - t) < 0.0005 ? t + 0.001 : t;
  }).then(() => new Promise((res) => {
    if (!v.requestVideoFrameCallback) return res();
    let ok = false; let h;
    try { h = v.requestVideoFrameCallback(() => { ok = true; res(); }); } catch (e) { return res(); }
    setTimeout(() => { if (!ok) { try { v.cancelVideoFrameCallback(h); } catch (e) { /* 무시 */ } res(); } }, 45);
  }));
}
async function openTrim(file) {
  const url = URL.createObjectURL(file);
  trim = { url, dur: 0, start: 0, end: 0, fps: 15, busy: true, drag: null, abort: false };
  tv.src = url;
  $('#trimFilm').textContent = '';
  $('#trimSheet').hidden = false;
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), 15000);
      tv.onloadedmetadata = () => { clearTimeout(to); res(); };
      tv.onerror = () => { clearTimeout(to); rej(new Error('video')); };
      tv.load();
    });
  } catch (e) {
    closeTrim(); toast('이 동영상은 열 수 없어요. 다른 형식(MP4, MOV)으로 해볼까요?'); return;
  }
  let dur = tv.duration;
  if (!isFinite(dur)) { // 일부 webm
    await seekTo(tv, 1e7); dur = tv.duration; if (!isFinite(dur)) dur = tv.currentTime || 10;
  }
  trim.dur = dur; trim.end = Math.min(dur, 5);
  layoutTrim();
  // 필름 스트립 썸네일 (같은 video 요소를 쓰므로 끝날 때까지 기다릴 수 있게 promise로 보관)
  const T = trim;
  T.thumbsP = (async () => {
    const N = 8, vw = tv.videoWidth || 160, vh = tv.videoHeight || 90;
    for (let i = 0; i < N; i++) {
      const c = document.createElement('canvas'); c.width = 80; c.height = Math.max(1, Math.round((80 * vh) / vw)); $('#trimFilm').appendChild(c);
    }
    for (let i = 0; i < N && !T.abort; i++) {
      await seekTo(tv, Math.min(dur - 0.05, ((i + 0.5) / N) * dur));
      if (T.abort) break;
      const c = $('#trimFilm').children[i]; if (c) c.getContext('2d').drawImage(tv, 0, 0, c.width, c.height);
    }
  })();
  await T.thumbsP;
  if (trim !== T || T.abort) return;
  T.busy = false;
  tv.currentTime = T.start;
  tv.play().catch(() => {});
}
function closeTrim() {
  if (trim) trim.abort = true;
  tv.pause(); tv.removeAttribute('src'); tv.load();
  if (trim) URL.revokeObjectURL(trim.url);
  trim = null; $('#trimSheet').hidden = true;
}
function trimDims() { return fitLong(tv.videoWidth || 1280, tv.videoHeight || 720, WORK_VIDEO); }
function layoutTrim() {
  if (!trim || !trim.dur) return;
  const p = (t) => `${(t / trim.dur) * 100}%`;
  $('#trimSel').style.left = p(trim.start);
  $('#trimSel').style.width = `${((trim.end - trim.start) / trim.dur) * 100}%`;
  $('#hStart').style.left = p(trim.start); $('#hEnd').style.left = p(trim.end);
  $('#tStart').textContent = trim.start.toFixed(1); $('#tEnd').textContent = trim.end.toFixed(1);
  $('#tLen').textContent = (trim.end - trim.start).toFixed(1);
  $('#hStart').setAttribute('aria-valuetext', `${trim.start.toFixed(1)}초`); $('#hEnd').setAttribute('aria-valuetext', `${trim.end.toFixed(1)}초`);
  $$('#fpsSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.fps) === trim.fps)));
  const n = Math.max(1, Math.round((trim.end - trim.start) * trim.fps));
  const { w, h } = trimDims();
  const allow = allowedFrames(w, h);
  const take = Math.min(n, allow);
  const warn = $('#trimWarn');
  if (allow < 1) { warn.hidden = false; warn.textContent = '프레임이 꽉 찼어요. 프레임 탭에서 몇 장 지운 뒤 다시 해볼까요?'; }
  else if (n > allow) { warn.hidden = false; warn.textContent = `프레임이 많아서 앞쪽 ${take}장(약 ${(take / trim.fps).toFixed(1)}초)만 가져와요. 구간을 줄이거나 초당 프레임을 낮추면 다 담을 수 있어요.`; }
  else warn.hidden = true;
  $('#trimOk').textContent = `${take}장 가져오기`;
  $('#trimOk').disabled = allow < 1;
}
function trimHeadUpdate() {
  if (!trim || !trim.dur) return;
  if (!trim.busy && !trim.drag && !tv.paused && tv.currentTime >= trim.end - 0.02) tv.currentTime = trim.start;
  $('#trimHead').style.left = `${(tv.currentTime / trim.dur) * 100}%`;
}
const tEl = $('#trim');
function xToTime(e) { const r = tEl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * trim.dur; }
function setEdge(which, t) {
  if (which === 'start') trim.start = clamp(t, 0, trim.end - 0.1);
  else trim.end = clamp(t, trim.start + 0.1, trim.dur);
  if (!trim.busy) tv.currentTime = which === 'start' ? trim.start : trim.end;
  layoutTrim();
}
tEl.addEventListener('pointerdown', (e) => {
  if (!trim || !trim.dur) return;
  e.preventDefault();
  const t = xToTime(e);
  trim.drag = Math.abs(t - trim.start) <= Math.abs(t - trim.end) ? 'start' : 'end';
  if (Math.abs(t - trim.start) === Math.abs(t - trim.end)) trim.drag = t < trim.start ? 'start' : 'end';
  tv.pause(); setEdge(trim.drag, t);
  try { tEl.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
});
tEl.addEventListener('pointermove', (e) => { if (trim && trim.drag) setEdge(trim.drag, xToTime(e)); });
const trimUp = () => { if (!trim || !trim.drag) return; trim.drag = null; if (!trim.busy) { tv.currentTime = trim.start; tv.play().catch(() => {}); } };
tEl.addEventListener('pointerup', trimUp); tEl.addEventListener('pointercancel', trimUp);
[['#hStart', 'start'], ['#hEnd', 'end']].forEach(([id, which]) => {
  $(id).addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.1 : 0;
    if (!d || !trim) return; e.preventDefault(); setEdge(which, trim[which] + d);
  });
});
$$('#fpsSeg button').forEach((b) => b.addEventListener('click', () => { if (trim) { trim.fps = Number(b.dataset.fps); layoutTrim(); } }));
$('#trimCancel').addEventListener('click', () => { if (trim) trim.abort = true; closeTrim(); });
$('#trimOk').addEventListener('click', async () => {
  if (!trim) return;
  trim.abort = true; tv.pause();
  if (trim.thumbsP) await trim.thumbsP;
  trim.busy = true;
  const { start, end, fps, dur } = trim;
  const { w, h } = trimDims();
  const n = Math.min(Math.max(1, Math.round((end - start) * fps)), allowedFrames(w, h));
  busy('동영상에서 프레임 꺼내는 중', `0 / ${n}`);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const list = [];
  for (let i = 0; i < n; i++) {
    if (cancelFlag) break;
    await seekTo(tv, Math.min(start + i / fps, dur - 0.001));
    x.drawImage(tv, 0, 0, w, h);
    list.push(await makeFrame(c));
    busyProg((i + 1) / n, `${i + 1} / ${n}`);
  }
  const wasCancelled = cancelFlag;
  busyEnd(); closeTrim();
  if (wasCancelled && !list.length) return;
  addFrames(list, 1 / fps);
  toast(`${list.length}프레임을 가져왔어요`);
});

/* ---------- 파일 고르기 연결 ---------- */
const inputs = { video: $('#fileVideo'), photos: $('#filePhotos'), gif: $('#fileGif'), camera: $('#fileCamera') };
function pick(kind) { const i = inputs[kind]; i.value = ''; i.click(); }
$$('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.pick)));
$$('[data-add]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.add)));
inputs.video.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openTrim(f); });
inputs.photos.addEventListener('change', (e) => importPhotos(e.target.files));
inputs.gif.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importGif(f); });
inputs.camera.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await importPhotos([f], { quiet: true });
  if (S.frames.length) { if (S.tab !== 'frames') setTab('frames'); toast(`${S.frames.length}번째 장을 찍었어요 · ‘찍어서 추가’로 계속`); }
});
// 데스크톱: 끌어다 놓기
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const v = files.find((f) => f.type.startsWith('video/'));
  if (v) return openTrim(v);
  const g = files.find((f) => f.type === 'image/gif');
  if (g) return importGif(g);
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (imgs.length) importPhotos(imgs);
});

/* ---------- 저장 ---------- */
let claudeDownloads = null;
(async () => {
  for (let i = 0; i < 40 && !(window.claude && window.claude.use); i++) await sleep(100);
  if (window.claude && window.claude.use) { try { claudeDownloads = await window.claude.use('downloads'); } catch (e) { claudeDownloads = null; } }
})();
function pickMime() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 다음 */ }
  }
  return null;
}
const SIZES = [{ v: 320, n: '작게' }, { v: 480, n: '보통' }, { v: 640, n: '크게' }, { v: 800, n: '최대' }];
function syncExport() {
  const mime = pickMime();
  $('#fmtVideo').textContent = mime ? `동영상 ${mime.includes('mp4') ? 'MP4' : 'WebM'}` : '동영상 (지원 안 됨)';
  $('#fmtVideo').disabled = !mime;
  if (!mime && out.fmt === 'video') out.fmt = 'gif';
  $$('#fmtSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === out.fmt)));
  $$('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== out.fmt; });
  const g = $('#sizeGrid'); g.textContent = '';
  for (const s of SIZES) {
    const { W, H } = sizeFor(s.v);
    const b = document.createElement('button'); b.className = 'chip';
    b.setAttribute('aria-pressed', String(out.long === s.v));
    b.innerHTML = `${s.n} <small>${W}×${H}</small>`;
    b.addEventListener('click', () => { out.long = s.v; syncExport(); syncInfo(); });
    g.appendChild(b);
  }
  $$('#colSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.col) === out.colors)));
  $$('#loopSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.loop) === out.loop)));
  $$('#vloopSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.vloop) === out.vloops)));
  const n = getSeq().length;
  $('#exSub').textContent = `${n}프레임 · ${(n * S.delay).toFixed(1)}초 · 프레임당 ${S.delay.toFixed(2)}초`;
}
$$('#fmtSeg button').forEach((b) => b.addEventListener('click', () => { out.fmt = b.dataset.fmt; syncExport(); }));
$$('#colSeg button').forEach((b) => b.addEventListener('click', () => { out.colors = Number(b.dataset.col); syncExport(); }));
$$('#loopSeg button').forEach((b) => b.addEventListener('click', () => { out.loop = Number(b.dataset.loop); syncExport(); }));
$$('#vloopSeg button').forEach((b) => b.addEventListener('click', () => { out.vloops = Number(b.dataset.vloop); syncExport(); }));
$('#openExport').addEventListener('click', () => { if (!getSeq().length) return toast('먼저 프레임을 넣어주세요'); syncExport(); $('#exportSheet').hidden = false; });
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.sheet-wrap').hidden = true; if (b.closest('#resultSheet')) clearResult(); }));
$$('.sheet-wrap').forEach((w) => w.addEventListener('click', (e) => {
  if (e.target !== w || w.id === 'trimSheet') return;
  w.hidden = true; if (w.id === 'resultSheet') clearResult();
}));

async function exportGif() {
  const { W, H } = sizeFor(out.long);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  await ensureFonts();
  const seq = getSeq(); const enc = GIFEncoder();
  const delay = Math.max(20, Math.round(S.delay * 100) * 10);
  for (let i = 0; i < seq.length; i++) {
    if (cancelFlag) return null;
    renderFrame(ctx, W, H, seq[i], fracOf(i, seq.length), false);
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, out.colors);
    const index = applyPalette(data, palette);
    enc.writeFrame(index, W, H, { palette, delay, repeat: out.loop });
    busyProg((i + 1) / seq.length, `${i + 1} / ${seq.length} 프레임`);
    await sleep(0);
  }
  enc.finish();
  return { blob: new Blob([enc.bytes()], { type: 'image/gif' }), W, H, ext: 'gif' };
}
async function exportVideo() {
  const mime = pickMime(); if (!mime) throw new Error('novideo');
  const { W, H } = sizeFor(out.long);
  const rc = $('#recCanvas'); rc.width = W; rc.height = H; const rctx = rc.getContext('2d');
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  await ensureFonts();
  const seq = getSeq(); const d = Math.max(20, S.delay * 1000); const total = seq.length * out.vloops;
  renderFrame(wctx, W, H, seq[0], 0, false); rctx.drawImage(work, 0, 0);
  const stream = rc.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: clamp(W * H * 30 * 0.2, 1.5e6, 10e6) });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now(); let k = 0;
  for (let lp = 0; lp < out.vloops; lp++) {
    for (let i = 0; i < seq.length; i++) {
      if (cancelFlag) { rec.stop(); await stopped; stream.getTracks().forEach((t) => t.stop()); return null; }
      if (k > 0) renderFrame(wctx, W, H, seq[i], fracOf(i, seq.length), false);
      rctx.drawImage(work, 0, 0);
      const end = t0 + (k + 1) * d;
      while (performance.now() < end) { await sleep(Math.min(33, Math.max(1, end - performance.now()))); rctx.drawImage(work, 0, 0); }
      k++; busyProg(k / total, `${k} / ${total} 프레임 녹화`);
    }
  }
  rec.stop(); await stopped; stream.getTracks().forEach((t) => t.stop());
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), W, H, ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
$('#doExport').addEventListener('click', async () => {
  $('#exportSheet').hidden = true;
  const wasPlaying = S.playing; setPlaying(false);
  busy(out.fmt === 'gif' ? 'GIF 만드는 중' : '동영상 녹화하는 중');
  let res = null;
  try { res = out.fmt === 'gif' ? await exportGif() : await exportVideo(); }
  catch (e) { busyEnd(); setPlaying(wasPlaying); toast('만드는 중에 문제가 생겼어요. 크기를 줄여서 다시 해볼까요?'); return; }
  busyEnd(); setPlaying(wasPlaying);
  if (res) showResult(res);
});

let result = null;
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function clearResult() { if (result) { URL.revokeObjectURL(result.url); result = null; } $('#resMedia').textContent = ''; }
function showResult({ blob, W, H, ext }) {
  clearResult();
  const url = URL.createObjectURL(blob);
  result = { blob, url, name: `umjjal-${stamp()}.${ext}` };
  const m = $('#resMedia'); m.textContent = '';
  let el;
  if (ext === 'gif') { el = document.createElement('img'); el.alt = '만든 움짤'; }
  else { el = document.createElement('video'); el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; el.controls = true; }
  el.className = 'result-media'; el.src = url; m.appendChild(el);
  $('#resMeta').innerHTML = `<b>${fmtBytes(blob.size)}</b> · ${W}×${H} · ${ext.toUpperCase()}`;
  const acts = $('#resActions'); acts.textContent = '';
  const btn = (label, icon, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.innerHTML = `<svg class="ico"><use href="#${icon}"/></svg>${label}`; b.addEventListener('click', fn); acts.appendChild(b); return b; };
  const file = typeof File === 'function' ? new File([blob], result.name, { type: blob.type }) : null;
  const canShare = !!(file && navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })());
  let hint = '';
  if (claudeDownloads) {
    btn('기기에 저장', 'i-download', 'accent', async () => {
      try { await claudeDownloads.save({ filename: result.name, data: blob }); toast('저장했어요'); }
      catch (e) { if (e && e.code !== 'declined') toast('여기서는 저장할 수 없어요. 이미지를 길게 눌러 저장해보세요.'); }
    });
    hint = '저장이 안 되면 위 이미지를 길게 눌러 저장할 수도 있어요.';
  } else {
    if (canShare) {
      btn('사진에 저장 · 공유', 'i-share', 'accent', async () => {
        try { await navigator.share({ files: [file] }); } catch (e) { if (e && e.name !== 'AbortError') toast('공유를 열 수 없어요. ‘파일로 받기’를 써보세요.'); }
      });
      hint = ext === 'gif' ? 'iPhone은 공유 메뉴에서 ‘이미지 저장’을 누르면 사진 앱에 움직이는 그대로 저장돼요.' : '공유 메뉴에서 ‘동영상 저장’을 누르면 사진 앱에 들어가요.';
    } else hint = '이미지를 길게 눌러서 저장할 수도 있어요.';
    btn('파일로 받기', 'i-download', canShare ? '' : 'accent', () => {
      const a = document.createElement('a'); a.href = result.url; a.download = result.name; document.body.appendChild(a); a.click(); a.remove();
    });
  }
  $('#resHint').textContent = hint;
  $('#resultSheet').hidden = false;
}

/* ---------- 예시 움짤 ---------- */
const DEMO_N = 16;
function paintDemo(ctx, i, S2 = 480) {
  const t = i / DEMO_N;
  const g = ctx.createLinearGradient(0, 0, 0, S2);
  g.addColorStop(0, '#ffb98e'); g.addColorStop(0.62, '#ff6a4d'); g.addColorStop(0.62, '#2b1c1d'); g.addColorStop(1, '#171012');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S2, S2);
  // 해와 줄무늬
  ctx.fillStyle = 'rgba(255,240,220,.35)';
  ctx.beginPath(); ctx.arc(S2 * 0.74, S2 * 0.26, S2 * 0.11, 0, Math.PI * 2); ctx.fill();
  const floor = S2 * 0.62;
  const hgt = Math.abs(Math.sin(Math.PI * t));
  const r = S2 * 0.1;
  const squash = hgt < 0.12 ? 1 - (0.12 - hgt) * 2.2 : 1;
  const cy = floor - r * squash - hgt * S2 * 0.36;
  // 그림자
  ctx.fillStyle = `rgba(0,0,0,${0.45 - hgt * 0.25})`;
  ctx.beginPath(); ctx.ellipse(S2 / 2, floor + 6, r * (1.2 - hgt * 0.5), r * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  // 공
  ctx.save(); ctx.translate(S2 / 2, cy); ctx.scale(1 / squash, squash);
  const bg = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  bg.addColorStop(0, '#fffaf4'); bg.addColorStop(1, '#f0d9c8');
  ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // 바닥 선
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  for (let k = 0; k < 6; k++) ctx.fillRect(((k * 97 + i * 22) % (S2 + 80)) - 40, floor + 40 + k * 14, 46, 3);
}
let demoTimer = null, demoI = 0;
function startDemo() {
  const c = $('#demo'), x = c.getContext('2d');
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    paintDemo(x, demoI); $('#demoFrame').textContent = String(demoI + 1).padStart(2, '0');
    demoI = (demoI + 1) % DEMO_N;
  }, 60);
}
function stopDemo() { clearInterval(demoTimer); demoTimer = null; }
$('#tryDemo').addEventListener('click', async () => {
  const list = [];
  const c = document.createElement('canvas'); c.width = 480; c.height = 480; const x = c.getContext('2d');
  for (let i = 0; i < DEMO_N; i++) { paintDemo(x, i); list.push(await makeFrame(c)); }
  S.layers.push({ id: uid(), type: 'text', text: '통통!', font: 'bhs', size: 0.14, color: '#ffffff', style: 'outline', x: 0.5, y: 0.16, from: 0, to: 1 });
  S.layers.push({ id: uid(), type: 'sticker', text: '✨', size: 0.16, x: 0.24, y: 0.3, from: 0, to: 0.5 });
  loadFont(S.layers[0]);
  addFrames(list, 0.06);
});

/* ---------- 시작 ---------- */
buildFx(); buildEmoji();
startDemo();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
window.__umjjal = { get state() { return S; }, out }; // 디버그용

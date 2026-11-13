// 움짤공방 — 무음 카메라
// getUserMedia로 화면을 띄우고, 촬영은 video 프레임을 canvas에 그려 JPEG로 만든다(셔터 소리 없음).
// 동영상은 카메라 스트림을 MediaRecorder로 바로 녹화(시작·끝 소리 없음).
// app.js와는 setupCamera(hooks)로만 연결한다.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATIOS = { '4:3': 4 / 3, '1:1': 1, '16:9': 16 / 9 };
const TIMERS = [0, 3, 5, 10];
const MAX_PX = 16e6; // iOS 캔버스 한도 아래로
const GHOST_LONG = 720; // 겹쳐 보기용 이미지 크기
const PREF_KEY = 'umjjal-camera';

function loadPrefs() {
  const d = { facing: 'environment', ratio: '4:3', timer: 0, grid: false, mirror: false, mic: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (e) { return d; }
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* 사생활 보호 모드 등 */ } }

function pickRecMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 다음 */ }
  }
  return '';
}
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDur = (s) => `${pad2(Math.floor(s / 60))}:${pad2(Math.floor(s % 60))}`;
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * hooks: {
 *   toast(msg),
 *   importPhotos(files) — 사진 File 배열을 움짤 편집기로 (기존 addFrames 경로),
 *   lastFrame() — 편집기의 마지막 프레임 {src, w, h} 또는 null (스톱모션 이어 찍기 겹쳐 보기용),
 *   fallback() — 이 기기에서 카메라 API를 못 쓸 때 기본 카메라(파일 입력)로,
 *   onOpen(), onClose()
 * }
 */
export function setupCamera(hooks) {
  const root = $('#cam');
  const video = $('#camVideo'), box = $('#camBox'), vf = $('#camVf');
  const ghost = $('#camGhost'), flash = $('#camFlash');
  const P = loadPrefs();

  let stream = null, track = null, facingNow = P.facing;
  let mode = 'photo', stopmo = false, isOpen = false;
  let torchOn = false, starting = null;
  let countdown = null; // { timer, cancel }
  let rec = null; // { recorder, chunks, audio, t0, tick, thumb }
  const shots = []; // { id, kind: 'photo'|'video', blob, url, thumb, w, h, mirrored, dur, ext }
  let stopmoShots = [];
  const selected = new Set();

  /* ---------- 화면 ---------- */
  function setClass() {
    root.classList.toggle('video', mode === 'video');
    root.classList.toggle('stopmo', stopmo);
    root.classList.toggle('recording', !!rec);
    root.classList.toggle('counting', !!countdown);
  }
  function syncControls() {
    $$('#camRatio button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === P.ratio)));
    $$('#camMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
    const tb = $('#camTimer'); tb.setAttribute('aria-pressed', String(P.timer > 0));
    tb.setAttribute('aria-label', P.timer ? `타이머 ${P.timer}초` : '타이머 끔'); $('#camTimerVal').textContent = P.timer ? P.timer : '';
    $('#camGrid').setAttribute('aria-pressed', String(P.grid)); $('#camGridLines').hidden = !P.grid;
    const mb = $('#camMirror'); mb.setAttribute('aria-pressed', String(P.mirror));
    mb.hidden = !isFront(); mb.setAttribute('aria-label', `셀카 좌우 반전 저장: ${P.mirror ? '켜짐' : '꺼짐'}`);
    const mic = $('#camMic'); mic.hidden = mode !== 'video'; mic.setAttribute('aria-pressed', String(P.mic));
    mic.setAttribute('aria-label', `마이크 소리 넣기: ${P.mic ? '켜짐' : '꺼짐'}`);
    $('#camMicUse').setAttribute('href', P.mic ? '#i-mic' : '#i-mic-off');
    $('#camTorch').setAttribute('aria-pressed', String(torchOn));
    $('#camTitle').textContent = stopmo ? `스톱모션 · ${stopmoShots.length}장` : '무음 카메라';
    $('#camDone').hidden = !stopmo;
    $('#camDone').textContent = stopmoShots.length ? `완료 (${stopmoShots.length})` : '완료';
    $('#camShutter').setAttribute('aria-label', mode === 'video' ? (rec ? '녹화 끝내기' : '녹화 시작') : '사진 찍기');
    box.classList.toggle('mirror', isFront());
    syncThumb(); setClass();
  }
  function syncThumb() {
    const last = shots[shots.length - 1];
    const img = $('#camThumbImg');
    if (last) { img.src = last.thumb; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    $('#camThumbN').textContent = shots.length || '';
    $('#camThumbN').hidden = !shots.length;
  }
  function isFront() {
    const s = track && track.getSettings ? track.getSettings() : {};
    return (s.facingMode || facingNow) === 'user';
  }
  // 촬영 화면 비율: 사진은 고른 비율(휴대폰을 세우면 세로), 동영상은 카메라가 주는 그대로
  function boxAspect(area) {
    if (mode === 'video' && video.videoWidth) return video.videoWidth / video.videoHeight;
    const r = RATIOS[P.ratio] || 4 / 3;
    return area.height >= area.width ? 1 / r : r;
  }
  function layout() {
    const area = vf.getBoundingClientRect();
    if (!area.width || !area.height) return;
    const a = boxAspect(area);
    let w = area.width, h = w / a;
    if (h > area.height) { h = area.height; w = h * a; }
    box.style.width = `${Math.floor(w)}px`; box.style.height = `${Math.floor(h)}px`;
    updateRes();
  }
  function outSize() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    if (mode === 'video') return { w: vw, h: vh };
    const b = box.getBoundingClientRect(); const a = b.width / b.height;
    let sw = vw, sh = vw / a; if (sh > vh) { sh = vh; sw = vh * a; }
    let k = Math.min(1, Math.sqrt(MAX_PX / (sw * sh)));
    return { w: Math.round(sw * k), h: Math.round(sh * k), sw, sh };
  }
  function updateRes() {
    const el = $('#camRes');
    if (!track) { el.textContent = ''; return; }
    const s = track.getSettings ? track.getSettings() : {};
    const cam = s.width && s.height ? `${s.width}×${s.height}` : `${video.videoWidth}×${video.videoHeight}`;
    const o = outSize();
    el.textContent = o && mode === 'photo' ? `${cam} → ${o.w}×${o.h}` : cam;
  }

  /* ---------- 안내 화면 ---------- */
  function showMsg(kind, err) {
    const T = {
      unsupported: ['이 브라우저에서는 카메라를 쓸 수 없어요', 'Safari나 Chrome 최신 버전에서, https 주소로 열어주세요.'],
      denied: ['카메라 권한이 꺼져 있어요', '아이폰: 설정 → 앱 → Safari → 카메라를 ‘허용’으로 바꾼 뒤 다시 시도해 주세요. 주소창 왼쪽 ‘가가’ 메뉴의 웹사이트 설정에서도 바꿀 수 있어요.'],
      none: ['카메라를 찾지 못했어요', '이 기기에 카메라가 없거나 연결이 끊겼어요.'],
      busy: ['카메라를 열 수 없어요', '다른 앱이나 탭에서 카메라를 쓰고 있는지 확인해 주세요.'],
      other: ['카메라를 열지 못했어요', err && err.name ? `오류: ${err.name}` : '잠시 뒤 다시 시도해 주세요.'],
    }[kind];
    $('#camMsgT').textContent = T[0]; $('#camMsgD').textContent = T[1];
    $('#camRetry').hidden = kind === 'unsupported';
    $('#camMsg').hidden = false; box.hidden = true;
    root.classList.add('blocked');
  }
  function hideMsg() { $('#camMsg').hidden = true; box.hidden = false; root.classList.remove('blocked'); }

  /* ---------- 스트림 ---------- */
  function stopStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null; torchOn = false;
    video.srcObject = null;
    $('#camRes').textContent = '';
  }
  async function start() {
    if (starting) return starting;
    starting = (async () => {
      stopStream(); hideMsg();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showMsg('unsupported'); return false; }
      try {
        // 가능한 가장 높은 해상도를 ideal로만 요청(exact는 아이폰에서 실패할 수 있음)
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingNow }, width: { ideal: 4096 }, height: { ideal: 3072 } },
          audio: false,
        });
      } catch (e) {
        const n = e && e.name;
        showMsg(n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'denied'
          : n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError' ? 'none'
          : n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError' ? 'busy' : 'other', e);
        return false;
      }
      if (!isOpen) { stopStream(); return false; } // 기다리는 사이 닫힘
      track = stream.getVideoTracks()[0];
      // 카메라가 알려주는 최대 해상도가 더 크면 한 번 더 올려본다
      try {
        const c = track.getCapabilities && track.getCapabilities();
        const s = track.getSettings();
        if (c && c.width && c.height && c.width.max * c.height.max > (s.width || 0) * (s.height || 0)) {
          await track.applyConstraints({ width: { ideal: c.width.max }, height: { ideal: c.height.max } });
        }
      } catch (e) { /* 그대로 사용 */ }
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* muted + playsinline이라 보통 통과 */ }
      if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
      // 손전등은 지원하는 기기에서만
      let torch = false;
      try { const c = track.getCapabilities && track.getCapabilities(); torch = !!(c && c.torch); } catch (e) { /* 없음 */ }
      $('#camTorch').hidden = !torch;
      // 카메라가 하나뿐이면 전환 버튼 숨김
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        $('#camFlip').hidden = devs.filter((d) => d.kind === 'videoinput').length < 2;
      } catch (e) { /* 그대로 */ }
      syncControls(); layout();
      return true;
    })();
    try { return await starting; } finally { starting = null; }
  }

  /* ---------- 촬영 피드백 ---------- */
  function feedback() {
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    try { navigator.vibrate && navigator.vibrate(30); } catch (e) { /* 아이폰은 미지원 */ }
  }

  /* ---------- 사진 ---------- */
  async function takePhoto() {
    const o = outSize(); if (!o) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const c = document.createElement('canvas'); c.width = o.w; c.height = o.h;
    const x = c.getContext('2d');
    const mirrored = isFront() && P.mirror;
    if (mirrored) { x.translate(o.w, 0); x.scale(-1, 1); }
    x.drawImage(video, (vw - o.sw) / 2, (vh - o.sh) / 2, o.sw, o.sh, 0, 0, o.w, o.h);
    feedback();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return hooks.toast('사진을 만들지 못했어요');
    const shot = { id: Math.random().toString(36).slice(2, 9), kind: 'photo', blob, url: URL.createObjectURL(blob), w: o.w, h: o.h, mirrored, ext: 'jpg', at: new Date() };
    shot.thumb = smallThumb(c, o.w, o.h);
    shots.push(shot);
    if (stopmo) { stopmoShots.push(shot); setGhost(c, o.w, o.h, isFront() && !mirrored); }
    syncControls();
  }
  function smallThumb(src, w, h) {
    const t = document.createElement('canvas'); const S = 160; t.width = S; t.height = S;
    const k = Math.max(S / w, S / h);
    t.getContext('2d').drawImage(src, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k);
    return t.toDataURL('image/jpeg', 0.8);
  }
  // 스톱모션: 직전 사진을 반투명하게 겹쳐 보여주기
  function setGhost(src, w, h, flip) {
    if (!src) { ghost.hidden = true; return; }
    const k = Math.min(1, GHOST_LONG / Math.max(w, h));
    ghost.width = Math.round(w * k); ghost.height = Math.round(h * k);
    ghost.getContext('2d').drawImage(src, 0, 0, ghost.width, ghost.height);
    ghost.classList.toggle('flip', !!flip);
    ghost.hidden = false;
  }

  /* ---------- 동영상 ---------- */
  async function startRec() {
    const mime = pickRecMime();
    if (mime === null) return hooks.toast('이 브라우저는 동영상 녹화를 지원하지 않아요');
    let audio = null;
    if (P.mic) {
      try { audio = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch (e) { hooks.toast('마이크를 쓸 수 없어서 소리 없이 녹화해요'); }
    }
    if (!stream || !isOpen) { if (audio) audio.getTracks().forEach((t) => t.stop()); return; }
    const ms = new MediaStream([...stream.getVideoTracks(), ...(audio ? audio.getAudioTracks() : [])]);
    let recorder;
    try { recorder = new MediaRecorder(ms, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined); }
    catch (e) { try { recorder = new MediaRecorder(ms); } catch (e2) { if (audio) audio.getTracks().forEach((t) => t.stop()); return hooks.toast('녹화를 시작하지 못했어요'); } }
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const r = { recorder, chunks: [], audio, t0: performance.now(), thumb: smallThumb(c, c.width, c.height), w: c.width, h: c.height, mime: mime || '' };
    rec = r;
    // 마지막 조각은 stop 뒤에 오므로(크롬 MP4는 전부 그때 옴) rec가 아니라 r에 담는다
    recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) r.chunks.push(e.data); });
    recorder.start(1000);
    $('#camRec').hidden = false; $('#camRecT').textContent = '00:00';
    rec.tick = setInterval(() => { if (rec) $('#camRecT').textContent = fmtDur((performance.now() - rec.t0) / 1000); }, 250);
    feedback(); syncControls();
  }
  function stopRec() {
    if (!rec) return Promise.resolve();
    const r = rec; rec = null;
    clearInterval(r.tick); $('#camRec').hidden = true;
    return new Promise((resolve) => {
      r.recorder.addEventListener('stop', () => {
        if (r.audio) r.audio.getTracks().forEach((t) => t.stop());
        const type = (r.recorder.mimeType || r.mime || 'video/webm').split(';')[0];
        const blob = new Blob(r.chunks, { type });
        if (blob.size) {
          shots.push({ id: Math.random().toString(36).slice(2, 9), kind: 'video', blob, url: URL.createObjectURL(blob), thumb: r.thumb, w: r.w, h: r.h,
            dur: (performance.now() - r.t0) / 1000, ext: type.includes('mp4') ? 'mp4' : 'webm', at: new Date() });
          hooks.toast('동영상을 갤러리에 담았어요');
        }
        syncControls(); resolve();
      }, { once: true });
      try { r.recorder.stop(); } catch (e) { resolve(); }
      feedback(); syncControls();
    });
  }

  /* ---------- 셔터·타이머 ---------- */
  function cancelCountdown() {
    if (!countdown) return;
    clearInterval(countdown.timer); countdown = null;
    $('#camCount').hidden = true; setClass();
  }
  function shutter() {
    if (!track) return;
    if (rec) return stopRec();
    if (countdown) return cancelCountdown();
    const act = () => (mode === 'video' ? startRec() : takePhoto());
    if (!P.timer) return act();
    let n = P.timer; const el = $('#camCount'); el.textContent = n; el.hidden = false;
    countdown = { timer: setInterval(() => {
      n -= 1;
      if (n <= 0) { cancelCountdown(); act(); } else el.textContent = n;
    }, 1000) };
    setClass();
  }

  /* ---------- 갤러리 ---------- */
  function renderGallery() {
    const g = $('#galGrid'); g.textContent = '';
    $('#galN').textContent = shots.length;
    $('#galEmpty').hidden = shots.length > 0;
    [...shots].reverse().forEach((s) => {
      const b = document.createElement('button');
      b.className = 'gal-item'; b.type = 'button';
      b.setAttribute('aria-pressed', String(selected.has(s.id)));
      b.setAttribute('aria-label', `${s.kind === 'video' ? '동영상' : '사진'} ${s.w}×${s.h}`);
      b.innerHTML = `<img alt="" src="${s.thumb}">${s.kind === 'video' ? `<span class="dur"><svg class="ico fill"><use href="#i-play"/></svg>${fmtDur(s.dur)}</span>` : ''}<span class="chk"><svg class="ico"><use href="#i-check"/></svg></span>${s.saved ? '<span class="saved">저장됨</span>' : ''}`;
      b.addEventListener('click', () => { selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id); b.setAttribute('aria-pressed', String(selected.has(s.id))); syncGalleryActions(); });
      g.appendChild(b);
    });
    syncGalleryActions();
  }
  function syncGalleryActions() {
    for (const id of [...selected]) if (!shots.some((s) => s.id === id)) selected.delete(id);
    const n = selected.size;
    const photos = shots.filter((s) => selected.has(s.id) && s.kind === 'photo').length;
    $('#galSave').disabled = !n; $('#galDel').disabled = !n; $('#galGif').disabled = !photos;
    $('#galSave').lastChild.textContent = n ? `저장 ${n}` : '저장';
    $('#galDel').lastChild.textContent = n ? `삭제 ${n}` : '삭제';
    $('#galGif').lastChild.textContent = photos ? `움짤로 ${photos}` : '움짤로';
    $('#galAll').textContent = n && n === shots.length ? '선택 해제' : '전체 선택';
    $('#galAll').hidden = !shots.length;
  }
  const chosen = () => shots.filter((s) => selected.has(s.id));
  const toFile = (s, i) => new File([s.blob], `umjjal-cam-${stamp(s.at)}-${i + 1}.${s.ext}`, { type: s.blob.type });
  // '사진 2장 · 동영상 1개를'처럼 (조사까지)
  function countLabel(list) {
    const p = list.filter((s) => s.kind === 'photo').length, v = list.length - p;
    const t = [p && `사진 ${p}장`, v && `동영상 ${v}개`].filter(Boolean).join(' · ');
    return t + (v ? '를' : '을'); // ‘장을’ / ‘개를’
  }
  // 저장을 마친 것은 표시하고 선택을 풀어서, 아직 안 저장한 게 뭔지 보이게
  function markSaved(list, msg) {
    list.forEach((s) => { s.saved = true; });
    selected.clear(); renderGallery();
    hooks.toast(msg);
  }
  async function saveSelected() {
    const list = chosen();
    const files = list.map(toFile);
    if (!files.length) return;
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files })); } catch (e) { canShare = false; }
    if (canShare) {
      try {
        await navigator.share({ files });
        // 공유 메뉴에서 '이미지 저장' 등 어떤 동작을 끝까지 했을 때만 여기로 옴(취소하면 AbortError)
        return markSaved(list, `${countLabel(list)} 저장했어요`);
      } catch (e) { if (e && e.name === 'AbortError') return; /* 공유 실패 → 하나씩 받기 */ }
    }
    for (const f of files) {
      const u = URL.createObjectURL(f);
      const a = document.createElement('a'); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
      await sleep(400);
    }
    markSaved(list, `${countLabel(list)} 파일로 받았어요`);
  }
  function deleteSelected() {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      if (selected.has(s.id)) { URL.revokeObjectURL(s.url); shots.splice(i, 1); stopmoShots = stopmoShots.filter((x) => x !== s); }
    }
    selected.clear(); renderGallery(); syncControls();
  }
  async function sendToGif() {
    const list = chosen();
    const photos = list.filter((s) => s.kind === 'photo');
    if (!photos.length) return;
    const files = photos.map(toFile);
    selected.clear();
    await close();
    await hooks.importPhotos(files);
    if (photos.length < list.length) hooks.toast('동영상은 빼고 사진만 넣었어요');
  }
  function openGallery() { if (rec || countdown) return; renderGallery(); $('#camGal').hidden = false; }
  function closeGallery() { $('#camGal').hidden = true; }

  /* ---------- 열기·닫기 ---------- */
  async function open(opts = {}) {
    stopmo = !!opts.stopmo; stopmoShots = []; mode = 'photo';
    // 카메라 API가 없는 기기의 스톱모션은 예전처럼 기본 카메라로
    if (stopmo && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && hooks.fallback) return hooks.fallback();
    ghost.hidden = true;
    if (stopmo && opts.continueFromEditor) {
      const f = hooks.lastFrame && hooks.lastFrame();
      if (f) setGhost(f.src, f.w, f.h, false);
    }
    closeGallery();
    isOpen = true; root.hidden = false;
    document.documentElement.classList.add('cam-open');
    hooks.onOpen && hooks.onOpen();
    syncControls();
    requestAnimationFrame(layout);
    await start();
  }
  async function close() {
    if (!isOpen) return;
    cancelCountdown();
    if (rec) await stopRec();
    isOpen = false;
    stopStream();
    root.hidden = true; closeGallery();
    document.documentElement.classList.remove('cam-open');
    hooks.onClose && hooks.onClose();
  }
  async function done() {
    const files = stopmoShots.map(toFile);
    await close();
    if (files.length) await hooks.importPhotos(files);
  }

  /* ---------- 이벤트 ---------- */
  $('#camClose').addEventListener('click', () => {
    close();
    if (stopmo && stopmoShots.length) hooks.toast(`찍은 ${stopmoShots.length}장은 카메라 갤러리에 남아 있어요`);
  });
  $('#camMsgClose').addEventListener('click', () => close());
  $('#camRetry').addEventListener('click', () => start());
  $('#camShutter').addEventListener('click', shutter);
  $('#camFlip').addEventListener('click', async () => {
    if (rec || countdown) return;
    facingNow = isFront() ? 'environment' : 'user'; P.facing = facingNow; savePrefs(P);
    await start();
  });
  $('#camTorch').addEventListener('click', async () => {
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !torchOn }] }); torchOn = !torchOn; }
    catch (e) { hooks.toast('손전등을 켤 수 없어요'); }
    syncControls();
  });
  $('#camTimer').addEventListener('click', () => { P.timer = TIMERS[(TIMERS.indexOf(P.timer) + 1) % TIMERS.length]; savePrefs(P); syncControls(); hooks.toast(P.timer ? `타이머 ${P.timer}초` : '타이머 끔'); });
  $('#camGrid').addEventListener('click', () => { P.grid = !P.grid; savePrefs(P); syncControls(); });
  $('#camMirror').addEventListener('click', () => { P.mirror = !P.mirror; savePrefs(P); syncControls(); hooks.toast(P.mirror ? '셀카를 보이는 그대로(좌우 반전) 저장해요' : '셀카를 반전하지 않고 저장해요'); });
  $('#camMic').addEventListener('click', () => { P.mic = !P.mic; savePrefs(P); syncControls(); hooks.toast(P.mic ? '마이크 소리를 함께 녹화해요' : '소리 없이 녹화해요'); });
  $$('#camRatio button').forEach((b) => b.addEventListener('click', () => { if (rec) return; P.ratio = b.dataset.r; savePrefs(P); syncControls(); layout(); }));
  $$('#camMode button').forEach((b) => b.addEventListener('click', () => { if (rec || countdown) return; mode = b.dataset.m; syncControls(); layout(); }));
  $('#camThumb').addEventListener('click', openGallery);
  $('#camDone').addEventListener('click', done);
  $('#galBack').addEventListener('click', closeGallery);
  $('#galAll').addEventListener('click', () => {
    if (selected.size === shots.length) selected.clear(); else shots.forEach((s) => selected.add(s.id));
    renderGallery();
  });
  $('#galSave').addEventListener('click', saveSelected);
  $('#galDel').addEventListener('click', deleteSelected);
  $('#galGif').addEventListener('click', sendToGif);
  video.addEventListener('resize', () => { if (isOpen) layout(); });
  addEventListener('resize', () => { if (isOpen) layout(); });
  // 앱이 뒤로 가면 카메라를 놓고, 돌아오면 다시 연다
  document.addEventListener('visibilitychange', async () => {
    if (!isOpen) return;
    if (document.hidden) { cancelCountdown(); if (rec) await stopRec(); stopStream(); }
    else if (!stream) start();
  });
  // 데스크톱: 스페이스·엔터로 셔터, Esc로 닫기
  document.addEventListener('keydown', (e) => {
    if (!isOpen || !$('#camGal').hidden) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target === document.body) { e.preventDefault(); shutter(); }
    else if (e.key === 'Escape') close();
  });

  return { open, close, get isOpen() { return isOpen; }, _debug: { shots, get track() { return track; }, get rec() { return rec; } } };
}

// 몸으로 배우는 영어 — MVP 게임 엔진
// 미션 루프: 상황 제시 → 동작 수행 → 영어 발화 → 보상 (실패 없는 루프)
import { HandLandmarker, FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { PACK } from './pack-fruit-farm.js';

/* ================= 상수 · 상태 ================= */
const DEBUG = new URLSearchParams(location.search).has('debug');
const TH = {
  close: 1.10,      // openness < close → 주먹
  open: 1.45,       // openness > open → 손 펴짐
  radius: 120,      // 타겟 판정 반경 (캔버스 px)
  sim: 0.60,        // 발화 유사도 임계
  washSwipes: 6,    // 씻기 완료에 필요한 좌우 왕복 방향전환 수
  hintAfterMs: 12000,
  skipAfterMs: 25000,
  speechWindowMs: 7000,
  speechAttempts: 2,
};

const S = {
  cam: false, landmarker: null, lastVideoTime: -1,
  hand: null,            // {x,y,lm} 캔버스 좌표(미러 반영)
  openness: null,
  wasOpen: false, grabEvent: false,
  faceLandmarker: null,  // 아이 얼굴 인식 (시작 시 1회 촬영용)
  faceRaw: null,         // {cx,cy,w,h} 비디오 원본 정규화 좌표 (얼굴 크롭용)
  faceFrame: 0,          // 얼굴 인식 프레임 스로틀 카운터
  scene: null,           // 현재 시나리오 렌더 정보 {type, items:[...], basket?...}
  particles: [],
  gestureTask: null,     // 진행 중 동작 미션
  speechSkip: null,      // 진행 중 발화 미션의 skip 콜백
  report: [],            // {en,ko,emoji,gestureMs,gestureNote,speechOk,speechAttempts,speechNote}
  t0: 0,
  child: { name: '' },   // 아이 이름 (개인화)
  bunny: { mood: 'idle', cheerUntil: 0, hopUntil: 0, blinkAt: 0, blinkTil: 0 }, // 무대 위 캐릭터
  coachMsg: null,        // 현재 표시 중인 반응형 코치 문구 (중복 갱신 방지)
};
const nm = () => S.child.name;                       // 개인화 호칭 (없으면 '')

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dist2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* ================= UI 헬퍼 ================= */
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

function bubble(en, ko) {
  $('bubbleEn').textContent = en || '';
  $('bubbleKo').textContent = ko || '';
  show('bubble');
}
function hint(text) {
  if (!text) { hide('hint'); return; }
  $('hint').textContent = text; show('hint');
}
async function feedback(text, ms = 1200) {
  const el = $('feedback');
  el.textContent = text;
  el.classList.remove('hidden', 'pop');
  void el.offsetWidth; // 애니메이션 재시작
  el.classList.add('pop');
  await sleep(ms);
  el.classList.add('hidden');
}

/* ----- 진행도 슬롯 ----- */
const progressSlots = [];
function buildProgress() {
  const bar = $('progress'); bar.innerHTML = '';
  for (const sc of PACK.scenarios) {
    if (sc.verb) addSlot(bar, sc.verb.emoji, 'verb:' + sc.id);
    for (const it of sc.items) addSlot(bar, it.emoji, 'item:' + it.en);
  }
  show('progress');
}
function addSlot(bar, emoji, key) {
  const s = document.createElement('span');
  s.className = 'slot'; s.textContent = emoji; s.dataset.key = key;
  bar.appendChild(s); progressSlots.push(s);
}
function markDone(key) {
  const s = progressSlots.find(x => x.dataset.key === key);
  if (s) s.classList.add('done');
}
function addSticker(emoji) {
  const tray = $('stickers');
  show('stickers');
  const sp = document.createElement('span');
  sp.textContent = emoji; tray.appendChild(sp);
}

/* ================= 음성 합성 (캐릭터 목소리) ================= */
function speak(text, lang = 'en-US', rate = 0.9) {
  return new Promise(res => {
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = rate; u.pitch = 1.25; // 캐릭터 느낌
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    u.onend = fin; u.onerror = fin;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(fin, Math.max(3500, text.length * 110)); // onend 미발화 대비
  });
}

/* ================= 음성 인식 (프롬프트형 따라 말하기) ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const norm = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function matches(word, accept, transcripts) {
  const target = norm(word);
  for (const raw of transcripts) {
    const t = norm(raw); if (!t) continue;
    if (t.includes(target)) return raw;
    for (const acc of (accept || [])) if (t.includes(norm(acc))) return raw;
    for (const tok of t.split(' ')) {
      const sim = 1 - lev(tok, target) / Math.max(tok.length, target.length);
      if (sim >= TH.sim) return raw;
    }
  }
  return null;
}

// 1회 청취 시도: {hit} | {timeout} | {error} | {skipped}
function listenOnce(word, accept) {
  return new Promise(resolve => {
    if (!SR) return resolve({ error: 'unsupported' });
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = true; r.maxAlternatives = 5; r.continuous = false;
    const heard = [];
    let settled = false;
    const settle = v => { if (!settled) { settled = true; try { r.abort(); } catch (e) {} S.speechSkip = null; hide('mic'); resolve(v); } };
    S.speechSkip = () => settle({ skipped: true });
    const timer = setTimeout(() => settle({ timeout: true, heard }), TH.speechWindowMs);
    r.onresult = e => {
      for (const res of e.results) for (let i = 0; i < res.length; i++) heard.push(res[i].transcript);
      const hit = matches(word, accept, heard);
      if (hit) { clearTimeout(timer); settle({ hit, heard }); }
    };
    r.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') { clearTimeout(timer); settle({ error: e.error, heard }); } };
    r.onend = () => { if (!settled) { try { r.start(); } catch (e) {} } }; // 창 내 자동 재시작
    try { r.start(); show('mic'); } catch (e) { clearTimeout(timer); settle({ error: 'start-failed' }); }
  });
}

// 발화 미션: 캐릭터가 먼저 말하고(프롬프트), 아이가 따라 말한다. 실패해도 진행.
async function speechStep(word, ko, accept, promptEn, promptKo) {
  if (!SR) return { ok: false, attempts: 0, note: '음성인식 미지원 브라우저' };
  for (let attempt = 1; attempt <= TH.speechAttempts; attempt++) {
    bubble(promptEn || `Say: ${cap(word)}!`, promptKo || `따라 말해요 — "${word}" (${ko})`);
    await speak(attempt === 1 ? `${word}! Say: ${word}!` : `One more time! ${word}!`);
    const res = await listenOnce(word, accept);
    if (res.skipped) return { ok: false, attempts: attempt, note: '건너뜀' };
    if (res.hit) {
      bunnyCheer();
      await speak(`${word}! ${nm() ? nm() + ', ' : ''}great job!`);
      return { ok: true, attempts: attempt, note: `"${res.hit.trim()}"` };
    }
    if (res.error === 'unsupported' || res.error === 'not-allowed')
      return { ok: false, attempts: attempt, note: '마이크 사용 불가' };
  }
  // 실패 없는 루프 — 격려하고 진행
  setMood('worry');
  await feedback('🎵 Good try!', 900);
  await speak(`${nm() ? nm() + ', ' : ''}good try!`);
  return { ok: false, attempts: TH.speechAttempts, note: '미인식 (격려 후 진행)' };
}
const cap = s => s[0].toUpperCase() + s.slice(1);

/* ================= 카메라 + 손 추적 ================= */
async function startCam() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  S.landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO", numHands: 1,
  });
  // 얼굴 인식 — 실패해도 손 인식만으로 진행 (코스튬 없이 degrade)
  try {
    S.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO", numFaces: 1,
    });
  } catch (e) { S.faceLandmarker = null; }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720 }, audio: false });
  video.srcObject = stream; await video.play();
  S.cam = true;
  requestAnimationFrame(tick);
}

function tick() {
  if (!S.cam) return;
  if (video.currentTime !== S.lastVideoTime) {
    S.lastVideoTime = video.currentTime;
    const now = performance.now();
    updateHand(S.landmarker.detectForVideo(video, now));
    // 얼굴 인식은 '촬영 전'에만 동작 (촬영 후엔 손 인식만 → 부하↓, 실시간 아님)
    if (S.faceLandmarker && !S.child.faceImg && (S.faceFrame++ & 1) === 0)
      updateFace(S.faceLandmarker.detectForVideo(video, now));
    updateGestureTask();
    tickBunny(now);
    draw();
  }
  requestAnimationFrame(tick);
}

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function updateHand(res) {
  S.grabEvent = false;
  if (!res.landmarks || !res.landmarks.length) { S.hand = null; S.openness = null; return; }
  const lm = res.landmarks[0];
  const size = d(lm[0], lm[9]) || 1e-6;
  S.openness = [8, 12, 16, 20].reduce((s, i) => s + d(lm[i], lm[0]), 0) / 4 / size;
  const cx = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
  const cy = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
  S.hand = { x: (1 - cx) * W, y: cy * H, lm };
  if (S.openness > TH.open) S.wasOpen = true;
  if (S.openness < TH.close && S.wasOpen) { S.grabEvent = true; S.wasOpen = false; }
}

/* ================= 얼굴 촬영 → 주인공 캐릭터에 입히기 (아이 = 주인공) ================= */
// 시작 시 한 번만 얼굴을 인식해 비디오 원본 좌표의 얼굴 박스를 갱신
function updateFace(res) {
  if (!res.faceLandmarks || !res.faceLandmarks.length) { S.faceRaw = null; return; }
  const lm = res.faceLandmarks[0]; // 정규화 좌표(비디오 원본, 미러 아님)
  const L = lm[234], R = lm[454], top = lm[10], chin = lm[152]; // 볼·이마·턱
  const w = Math.hypot(R.x - L.x, R.y - L.y);
  const h = Math.hypot(chin.x - top.x, chin.y - top.y);
  S.faceRaw = { cx: (top.x + chin.x) / 2, cy: (top.y + chin.y) / 2, w, h };
}

// 현재 프레임의 얼굴을 잘라 타원 마스크한 오프스크린 캔버스로 저장 (셀피=미러 방향)
function captureFace() {
  const r = S.faceRaw; if (!r || !video.videoWidth) return false;
  const vw = video.videoWidth, vh = video.videoHeight;
  const padX = r.w * 0.38, padY = r.h * 0.5;
  let x0 = Math.max(0, (r.cx - r.w / 2 - padX) * vw);
  let y0 = Math.max(0, (r.cy - r.h / 2 - padY * 1.3) * vh); // 이마·머리 더 포함
  let x1 = Math.min(vw, (r.cx + r.w / 2 + padX) * vw);
  let y1 = Math.min(vh, (r.cy + r.h / 2 + padY) * vh);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw < 30 || sh < 30) return false;
  const size = 256;
  const off = document.createElement('canvas'); off.width = size; off.height = size;
  const o = off.getContext('2d');
  o.save(); o.translate(size, 0); o.scale(-1, 1); // 아이가 보던 셀피 방향 유지
  o.drawImage(video, x0, y0, sw, sh, 0, 0, size, size);
  o.restore();
  o.globalCompositeOperation = 'destination-in'; // 타원 밖은 투명 처리
  o.fillStyle = '#000';
  o.beginPath(); o.ellipse(size / 2, size * 0.52, size * 0.45, size * 0.48, 0, 0, Math.PI * 2); o.fill();
  S.child.faceImg = off;
  return true;
}
// 얼굴이 잡힐 때까지 잠깐 재시도
async function captureFaceWithRetry(ms = 2600) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (S.faceRaw && captureFace()) return true;
    await sleep(120);
  }
  return false;
}

/* ================= 무대 위 Bunny (B1: 살아있는 캐릭터) ================= */
function tickBunny(now) {
  const b = S.bunny;
  if (now > b.blinkAt) { b.blinkAt = now + 2200 + Math.random() * 2800; b.blinkTil = now + 120; }
}
function setMood(m) { const b = S.bunny; if (performance.now() < b.cheerUntil) return; b.mood = m; } // cheer는 잠금
function bunnyCheer(ms = 1500) {
  const b = S.bunny; b.mood = 'cheer';
  b.cheerUntil = performance.now() + ms; b.hopUntil = performance.now() + 720;
  burst(W * 0.14, H * 0.56, '✨');
}

function drawBunny() {
  const b = S.bunny, now = performance.now();
  const cx = W * 0.14;
  const bob = Math.sin(now / 520) * 3;
  let hop = 0, squash = 1;
  if (now < b.hopUntil) {
    const k = Math.sin((1 - (b.hopUntil - now) / 720) * Math.PI); // 0→1→0
    hop = -k * 44; squash = 1 - k * 0.12;
  }
  const cy = H * 0.80 + bob + hop;
  const blinking = now < b.blinkTil;
  const mood = b.mood;
  const s = (W / 960) * 1.35; // 캔버스 기준 스케일 (담은 얼굴이 잘 보이도록 크게)

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s * squash);

  // 팔로 타겟 가리키기 (point)
  if (mood === 'point' && S.gestureTask && S.gestureTask.item) {
    const it = S.gestureTask.item;
    const a = Math.atan2((it.y - cy) / s, (it.x - cx) / s);
    ctx.save(); ctx.strokeStyle = '#EFE9DF'; ctx.lineWidth = 11; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(18, -6); ctx.lineTo(18 + Math.cos(a) * 52, -6 + Math.sin(a) * 52); ctx.stroke();
    ctx.fillStyle = '#FDFDFB'; ctx.beginPath();
    ctx.arc(18 + Math.cos(a) * 60, -6 + Math.sin(a) * 60, 9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // 귀
  const earTilt = mood === 'worry' ? 0.5 : mood === 'cheer' ? -0.12 : 0.18;
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(side * 15, -58); ctx.rotate(side * earTilt);
    ctx.fillStyle = '#FDFDFB'; ctx.beginPath(); ctx.ellipse(0, 0, 12, 40, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#F7B8CC'; ctx.beginPath(); ctx.ellipse(0, 3, 6, 28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 몸통 + 머리
  ctx.fillStyle = '#FDFDFB'; ctx.strokeStyle = 'rgba(70,70,70,.14)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, 34, 30, 32, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, -12, 30, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 얼굴 — 시작 시 담은 아이 얼굴을 머리에 입힘 (없으면 그린 토끼 표정으로 폴백)
  if (S.child.faceImg) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, -13, 27, 30, 0, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(S.child.faceImg, -33, -47, 66, 70);
    ctx.restore();
    ctx.strokeStyle = 'rgba(70,70,70,.12)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, -13, 27, 30, 0, 0, Math.PI * 2); ctx.stroke();
  } else {
    // 발그레한 볼
    ctx.fillStyle = 'rgba(244,140,160,.5)';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * 18, -4, 6, 0, Math.PI * 2); ctx.fill(); }
    // 눈
    ctx.fillStyle = '#2A2A26'; ctx.strokeStyle = '#2A2A26'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      if (blinking || mood === 'cheer') {
        ctx.beginPath(); // 감은 눈/웃는 눈 ⌣
        ctx.arc(side * 12, -16, 6, mood === 'cheer' ? Math.PI : 0.15 * Math.PI, mood === 'cheer' ? Math.PI * 2 : 0.85 * Math.PI);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(side * 12, -16, mood === 'worry' ? 3 : 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 코 + 입
    ctx.fillStyle = '#F28FB0'; ctx.beginPath(); ctx.ellipse(0, -6, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8A6A55'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (mood === 'cheer') { ctx.arc(0, -3, 6, 0.15 * Math.PI, 0.85 * Math.PI); }       // 활짝
    else if (mood === 'worry') { ctx.arc(0, 4, 4, 1.15 * Math.PI, 1.85 * Math.PI); }   // ㅜ
    else { ctx.moveTo(-4, 0); ctx.lineTo(0, 2); ctx.lineTo(4, 0); }
    ctx.stroke();
  }
  // 걱정 땀방울
  if (mood === 'worry') {
    ctx.fillStyle = 'rgba(120,190,235,.9)';
    ctx.beginPath(); ctx.arc(26, -22, 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ----- 반응형 코치 문구 (B2: 아이 행동에 반응, 화면 하단) ----- */
function coach(msg) { if (S.coachMsg === msg) return; S.coachMsg = msg; hint(msg); }

/* ================= 동작 미션 ================= */
// type: 'grab' | 'wash' | 'carry' | 'handcheck'
function waitGesture(type, item, hintKo) {
  return new Promise(resolve => {
    const task = {
      type, item, resolve, t0: performance.now(),
      lastX: null, lastDir: 0, swipes: 0,      // wash
      held: false, lostAt: null,                // carry
      steady: 0,                                // handcheck
      hinted: false, skippable: false,
    };
    // 오래 못 풀면 Bunny가 음성으로 격려 (하단 코치 문구는 coach()가 상시 담당)
    task.hintTimer = setTimeout(async () => {
      task.hinted = true; task.hintKo = hintKo;
      setMood('worry');
      speak(nm() ? `You can do it, ${nm()}!` : "You can do it!");
    }, TH.hintAfterMs);
    task.skipTimer = setTimeout(() => { show('btnSkip'); }, TH.skipAfterMs);
    S.gestureTask = task;
    if (DEBUG) show('btnSkip');
  });
}
function finishGesture(result) {
  const t = S.gestureTask; if (!t) return;
  clearTimeout(t.hintTimer); clearTimeout(t.skipTimer);
  hide('btnSkip'); hint(null); S.coachMsg = null;
  S.gestureTask = null;
  t.resolve({ ...result, ms: Math.round(performance.now() - t.t0) });
}

function updateGestureTask() {
  const t = S.gestureTask; if (!t) return;
  const hand = S.hand;

  if (t.type === 'handcheck') {
    if (hand) { t.steady += 1; } else { t.steady = 0; }
    const pct = Math.min(100, Math.round(t.steady / 45 * 100)); // 약 1.5초 유지
    $('setupFill').style.width = pct + '%';
    if (pct >= 100) finishGesture({ ok: true });
    return;
  }

  const item = t.item;
  const over = hand && item && dist2(hand.x, hand.y, item.x, item.y) < TH.radius;

  // ----- 반응형 캐릭터: 아이가 지금 하는 행동에 Bunny가 반응 -----
  if (!hand) {
    setMood('worry');
    coach(nm() ? `${nm()}, 손을 보여줘요! 👋` : '손을 화면에 보여줘요! 👋');
  } else if (t.type === 'carry' && t.held) {
    setMood('point'); coach('바구니로 옮겨요! 🧺');
  } else if (over) {
    setMood('point');
    coach(t.type === 'wash' ? '싹싹 문질러요! 🫧'
      : t.type === 'grab' ? '바로 거기! 주먹 꼭 쥐어요 ✊'
      : '꼭 쥐어요! ✊');
  } else {
    setMood('point');
    coach(t.hinted && t.hintKo ? t.hintKo : '조금만 더 가까이! ✨');
  }

  if (t.type === 'grab') {
    if (over && S.grabEvent) { burst(item.x, item.y); finishGesture({ ok: true }); }
    return;
  }

  if (t.type === 'wash') {
    if (over && S.openness !== null && S.openness > TH.close) { // 손을 편 채 문지르기
      if (t.lastX !== null) {
        const dx = hand.x - t.lastX;
        if (Math.abs(dx) > 7) {
          const dir = Math.sign(dx);
          if (t.lastDir && dir !== t.lastDir) {
            t.swipes++;
            item.washProgress = Math.min(1, t.swipes / TH.washSwipes);
            bubbleParticle(item.x, item.y);
          }
          t.lastDir = dir;
        }
      }
      t.lastX = hand.x;
      if (t.swipes >= TH.washSwipes) { burst(item.x, item.y, '🫧'); finishGesture({ ok: true }); }
    } else { t.lastX = null; t.lastDir = 0; }
    return;
  }

  if (t.type === 'carry') {
    const basket = S.scene.basket;
    if (!t.held) {
      if (over && S.grabEvent) { t.held = true; t.lostAt = null; }
    } else {
      if (!hand) {
        // 손 사라짐 — 1.2초 유예 후 제자리로
        if (!t.lostAt) t.lostAt = performance.now();
        else if (performance.now() - t.lostAt > 1200) {
          t.held = false; item.x = item.ox; item.y = item.oy; t.lostAt = null;
        }
        return;
      }
      t.lostAt = null;
      item.x = hand.x; item.y = hand.y; // 과일이 손을 따라감
      const inBasket = dist2(item.x, item.y, basket.x, basket.y) < TH.radius + 30;
      if (inBasket) { item.inBasket = true; burst(basket.x, basket.y); finishGesture({ ok: true }); return; }
      if (S.openness !== null && S.openness > TH.open) {
        // 바구니 밖에서 손을 폈다 — 떨어뜨림
        t.held = false; item.x = item.ox; item.y = item.oy;
      }
    }
  }
}

$('btnSkip').addEventListener('click', () => {
  if (S.gestureTask && S.gestureTask.type !== 'handcheck') finishGesture({ ok: false, skipped: true });
  else if (S.speechSkip) S.speechSkip();
});
if (DEBUG) {
  window.addEventListener('keydown', e => {
    if (e.key === 'g' && S.gestureTask) finishGesture({ ok: true, debug: true });
    if (e.key === 's' && S.speechSkip) S.speechSkip();
  });
}

/* ================= 렌더링 ================= */
function burst(x, y, emoji) {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 5;
    S.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3,
      life: 1, emoji: emoji || ['✨', '⭐', '🌟'][i % 3],
    });
  }
}
function bubbleParticle(x, y) {
  S.particles.push({
    x: x + (Math.random() - .5) * 90, y: y + (Math.random() - .5) * 60,
    vx: (Math.random() - .5) * 1.5, vy: -2 - Math.random() * 2, life: 1, emoji: '🫧',
  });
}

function draw() {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  const sc = S.scene;
  if (sc) {
    if (sc.type === 'tree') drawTree();
    if (sc.type === 'basin') drawBasin();
    if (sc.type === 'basket') drawBasket(sc);
    for (const it of sc.items) drawItem(it, sc);
  }

  // 파티클
  for (const p of S.particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.02;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.font = '30px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.emoji, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  S.particles = S.particles.filter(p => p.life > 0);

  drawBunny(); // 무대 위 캐릭터 (파티클 위, 손 커서 아래)

  // 손 커서
  if (S.hand) {
    if (DEBUG) {
      ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
      for (const p of S.hand.lm) {
        ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(124,220,140,.8)'; ctx.fill();
      }
      ctx.restore();
    }
    const closed = S.openness !== null && S.openness < TH.close;
    ctx.beginPath(); ctx.arc(S.hand.x, S.hand.y, closed ? 26 : 38, 0, Math.PI * 2);
    ctx.strokeStyle = closed ? '#D9482B' : '#7CDC8C';
    ctx.lineWidth = 6; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 8; ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawTree() {
  ctx.save();
  ctx.fillStyle = 'rgba(121,85,45,.92)';
  ctx.fillRect(W * 0.66, H * 0.42, W * 0.07, H * 0.55);
  ctx.fillStyle = 'rgba(61,122,70,.9)';
  for (const [cx, cy, r] of [[0.70, 0.26, 0.20], [0.56, 0.30, 0.14], [0.85, 0.28, 0.14]]) {
    ctx.beginPath(); ctx.arc(W * cx, H * cy, W * r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function drawBasin() {
  ctx.save();
  ctx.fillStyle = 'rgba(121,85,45,.92)';
  ctx.fillRect(W * 0.12, H * 0.72, W * 0.76, H * 0.10);
  ctx.fillStyle = 'rgba(120,190,235,.85)';
  ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.70, W * 0.34, H * 0.085, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 5; ctx.stroke();
  ctx.restore();
}
function drawBasket(sc) {
  const b = sc.basket;
  ctx.font = '130px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🧺', b.x, b.y);
  // 담긴 과일
  let i = 0;
  for (const it of sc.items) if (it.inBasket) {
    ctx.font = '44px serif';
    ctx.fillText(it.emoji, b.x - 28 + (i % 2) * 56, b.y - 46);
    i++;
  }
}
function drawItem(it, sc) {
  if (it.done && sc.type !== 'basket') return;      // 완료 과일은 사라짐 (따기/씻기)
  if (it.inBasket) return;                          // 바구니 안 과일은 basket에서 그림
  const active = S.gestureTask && S.gestureTask.item === it;
  const pulse = active ? 1 + 0.06 * Math.sin(performance.now() / 220) : 1;
  ctx.save();
  ctx.font = `${86 * pulse}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 12;
  ctx.fillText(it.emoji, it.x, it.y);
  ctx.shadowBlur = 0;
  // 씻기: 얼룩이 진행도에 따라 옅어짐
  if (sc.type === 'basin' && it.washProgress < 1 && !it.done) {
    ctx.globalAlpha = 0.65 * (1 - (it.washProgress || 0));
    ctx.fillStyle = '#6B4A2B';
    for (const [dx, dy, r] of [[-18, -10, 9], [14, 6, 7], [-2, 18, 6], [20, -16, 5]]) {
      ctx.beginPath(); ctx.arc(it.x + dx, it.y + dy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (active) {
    ctx.beginPath(); ctx.arc(it.x, it.y, TH.radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.setLineDash([9, 9]); ctx.lineWidth = 4; ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/* ================= 게임 진행 (내러티브) ================= */
async function runPack() {
  S.t0 = performance.now();
  buildProgress();

  for (const sc of PACK.scenarios) {
    // ---- 장면 준비 ----
    S.scene = {
      type: sc.scene,
      items: sc.items.map(it => ({
        ...it,
        x: it.pos.x * W, y: it.pos.y * H,
        ox: it.pos.x * W, oy: it.pos.y * H,
        washProgress: 0, done: false, inBasket: false,
      })),
      basket: { x: W * 0.78, y: H * 0.70 },
    };

    // ---- 시나리오 인트로 ----
    setMood('idle');
    bubble(sc.introEn, sc.introKo);
    await speak(sc.introEn);
    await sleep(400);

    // ---- 동작 동사 스텝 (pick / wash) ----
    if (sc.verb) {
      const r = await speechStep(sc.verb.en, sc.verb.ko, sc.verb.accept, sc.verb.promptEn, sc.verb.promptKo);
      S.report.push({ en: sc.verb.en, ko: sc.verb.ko, emoji: sc.verb.emoji, gestureMs: null, gestureNote: '발화 전용', ...r });
      markDone('verb:' + sc.id);
      if (r.ok) { addSticker(sc.verb.emoji); await feedback('🌟 ' + cap(sc.verb.en) + '!'); }
    }

    // ---- 아이템 루프: 동작 → 발화 → 보상 ----
    for (const it of S.scene.items) {
      bubble(it.askEn, it.askKo);
      await speak(it.askEn);
      const g = await waitGesture(sc.gesture, it, sc.gestureHintKo);
      it.done = true;
      if (!g.skipped) { bunnyCheer(); await feedback(sc.gesture === 'wash' ? '🫧 So clean!' : '🎉 Got it!', 1000); }

      const sp = await speechStep(it.en, it.ko, it.accept);
      S.report.push({
        en: it.en, ko: it.ko, emoji: it.emoji,
        gestureMs: g.skipped ? null : g.ms,
        gestureNote: g.skipped ? '건너뜀' : (g.debug ? '디버그 패스' : Math.round(g.ms / 100) / 10 + '초'),
        ...sp,
      });
      markDone('item:' + it.en);
      addSticker(it.emoji);
      await sleep(300);
    }

    // ---- 시나리오 클리어 ----
    bunnyCheer(1800);
    bubble(sc.clearEn, sc.clearKo);
    await speak(sc.clearEn);
    await feedback('⭐ ' + sc.title + ' 완료!', 1400);
    await sleep(300);
  }

  // ---- 피날레 ----
  bunnyCheer(2600);
  bubble(PACK.finaleEn, PACK.finaleKo);
  await speak(nm() ? `You did it, ${nm()}! You are my best friend!` : PACK.finaleEn);
  await feedback('🏆 참 잘했어요!', 1800);
  S.scene = null;
  showReport();
}

/* ================= 학부모 리포트 ================= */
function showReport() {
  const mins = Math.round((performance.now() - S.t0) / 6000) / 10;
  const spoken = S.report.filter(r => r.ok).length;
  $('repSummary').textContent =
    `플레이 ${mins}분 · 단어 ${S.report.length}개 진행 · 영어로 말하기 성공 ${spoken}개`;
  const tb = $('repTable').querySelector('tbody');
  tb.innerHTML = S.report.map(r => `
    <tr>
      <td>${r.emoji} <b>${r.en}</b></td>
      <td>${r.ko}</td>
      <td>${r.gestureNote || '–'}</td>
      <td class="${r.ok ? 'ok' : 'miss'}">${r.ok ? `성공 (${r.attempts}회차)` : '다음에 다시'}</td>
      <td>${r.note || ''}</td>
    </tr>`).join('');
  show('ovReport');
}
$('btnRepCopy').addEventListener('click', async () => {
  const head = 'word\tko\tgesture\tspeech_ok\tattempts\tnote';
  const rows = S.report.map(r => [r.en, r.ko, r.gestureNote || '', r.ok ? 'y' : 'n', r.attempts, r.note || ''].join('\t'));
  await navigator.clipboard.writeText([head, ...rows].join('\n'));
  $('btnRepCopy').textContent = '복사됨 ✓';
  setTimeout(() => $('btnRepCopy').textContent = '리포트 복사', 1500);
});
$('btnReplay').addEventListener('click', () => location.reload());

/* ================= 부팅 시퀀스 ================= */
$('btnPlay').addEventListener('click', async () => {
  const raw = ($('childName')?.value || '').trim();
  S.child.name = raw.slice(0, 12).replace(/[<>]/g, ''); // 개인화 호칭
  hide('ovTitle'); show('ovSetup');
  try {
    await startCam();
  } catch (e) {
    $('setupEmoji').textContent = '😢';
    $('setupTitle').textContent = '카메라를 켤 수 없어요';
    $('setupDesc').textContent = '카메라 권한을 허용했는지 확인하고 새로고침해 주세요. (' + e.message + ')';
    return;
  }
  // 손 인식 체크 — 30초 온보딩의 핵심
  $('setupEmoji').textContent = '✋';
  $('setupTitle').textContent = '손을 흔들어 보세요!';
  $('setupDesc').textContent = '카메라에 손이 보이면 게이지가 차올라요. 팔을 뻗을 공간을 확보해 주세요.';
  await waitGesture('handcheck', null, null);
  // 얼굴 담기 — 이 순간의 얼굴을 이야기 속 주인공 캐릭터에 입힌다 (1회 촬영)
  $('setupEmoji').textContent = '📸';
  $('setupTitle').textContent = '얼굴을 담을게요!';
  $('setupDesc').textContent = '카메라를 잠깐 바라봐 주세요. 이 얼굴이 이야기 속 주인공이 돼요.';
  $('setupFill').style.width = '100%';
  await sleep(600);
  await captureFaceWithRetry();
  hide('ovSetup');
  bunnyCheer();
  await feedback(nm() ? `👋 Hi, ${nm()}!` : '👋 Hello!', 1000);
  await speak(nm() ? `Hi ${nm()}! Let's play!` : `Hi! Let's play!`);
  runPack();
});

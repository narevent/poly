/* ============================================================
   trainer.js — Poly Polyrhythm Trainer

   Two voices at a fixed ratio run against each other; you tap
   both, one hand each, and every tap is scored against the note
   it was aiming for.

   The sounds come from the metronome's voice library, so a click
   here is the same click there — see shared/voices.js.
   ============================================================ */

import { playVoice, VOICES, isVoice, resolveVoice } from '../../shared/voices.js';
import { createContext, attach, ping } from '../../shared/audio-session.js';
import * as haptics from '../../shared/haptics.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

const PRESETS = [
  { a: 2, b: 3, lvl: 'Beginner' }, { a: 3, b: 4, lvl: 'Beginner' },
  { a: 3, b: 2, lvl: 'Beginner' }, { a: 4, b: 3, lvl: 'Easy' },
  { a: 4, b: 5, lvl: 'Medium' },   { a: 3, b: 5, lvl: 'Medium' },
  { a: 5, b: 4, lvl: 'Medium' },   { a: 4, b: 7, lvl: 'Hard' },
  { a: 5, b: 7, lvl: 'Hard' },     { a: 7, b: 11, lvl: 'Expert' },
];

/* Canvas cannot read CSS custom properties, so the palette is restated here.
   These are the same tokens trainer.css uses — keep the two in step. */
const COL = {
  A: '#6ea8ff', B: '#9b8cff', unison: '#e7ecf3',
  good: '#5fe3a1', ok: '#ffb86b', bad: '#ff6b81',
  railA: 'rgba(110,168,255,.16)', railB: 'rgba(155,140,255,.16)',
};
const MONO = "'JetBrains Mono', ui-monospace, monospace";

/* ---------------- state ---------------- */
let A = 3, B = 4, bpm = 90, tolMs = 50, latMs = 0;
let voice = { A: 'click', B: 'beep' };
/* `hap` is gone from here: haptics are one setting for the whole of Poly,
   switched on in the hub and read from shared/haptics.js, so turning it on
   before you pick an app is enough. A stored `hap` from before that change
   is ignored rather than migrated — the shared setting is opt-in, and
   silently switching on a phone's motor is not a migration. */
let sound = { A: true, B: true, tap: true, count: true };

let playing = false, startTime = 0, cycleSec = 0;
let events = [], genCycle = 0;
let streak = 0, best = 0, evaluated = 0, goodCount = 0, errSum = 0, errN = 0;
let hist = { A: [], B: [] };
let floats = [];
let lastBeat = { A: -1, B: -1 };
let lastStreakShown = 0;

/* ---------------- clock bridge ----------------
   Taps are stamped with the event's own hardware timestamp (the
   performance.now timebase) and converted to audio-clock time, so a busy
   main thread cannot add latency to a player's score. */
let clockOffset = null;   // performance-seconds -> audio-seconds
let autoLat = 0;          // output latency of the audio device

function syncClock() {
  if (!actx) return;
  const o = performance.now() / 1000 - actx.currentTime;
  if (clockOffset === null || o < clockOffset) clockOffset = o;  // fast down: jitter floor
  else clockOffset += (o - clockOffset) * 0.05;                  // follow up: resume stalls, drift
}
function audioTimeOf(perfMs) {
  if (clockOffset === null) syncClock();
  return perfMs / 1000 - clockOffset;
}
function measureAutoLatency() {
  let l = (typeof actx.outputLatency === 'number' && isFinite(actx.outputLatency)) ? actx.outputLatency : 0;
  if (!(l > 0) || l > 0.5) l = actx.baseLatency || 0;
  autoLat = clamp(l, 0, 0.4);
  $('autoLat').textContent = autoLat > 0
    ? `device output ${Math.round(autoLat * 1000)} ms compensated`
    : 'device latency not reported';
}
/* position of the sound the player is hearing right now */
function relNow() { return (actx ? actx.currentTime : 0) - startTime - autoLat; }

/* ---------------- audio ----------------
   Building and keeping the context is shared/audio-session.js's job — see
   the note at the top of that file for what a phone does to a Web Audio
   context and why `if (state === 'suspended') resume()` is not enough. The
   trainer only has to say when it wants sound and what to do when the
   context cannot be saved. */
let actx = null, master = null, detachAudio = null;
function ensureAudio() {
  if (!actx) {
    actx = createContext({ latencyHint: 'interactive' });
    if (!actx) return null;
    master = actx.createGain();
    master.gain.value = 0.55;
    master.connect(actx.destination);
    measureAutoLatency();
    detachAudio = attach(actx, { isActive: () => playing, onLost: audioLost });
  }
  ping(actx);
  return actx;
}

/* The context died: an interruption it never came back from, or a route
   change that left it running with a stopped clock. An exercise cannot be
   resumed through that — every note after the gap was scored against a
   clock that was not moving — so the run ends and says why. The next start
   builds a fresh context. */
function audioLost(reason) {
  if (detachAudio) { detachAudio(); detachAudio = null; }
  const wasPlaying = playing;
  // the page being left, or sitting hidden with nothing running, is a
  // release rather than a fault: still end the run, but do not announce it
  const deliberate = reason === 'pagehide' || reason === 'hidden';
  actx = null; master = null; clockOffset = null;
  if (wasPlaying) {
    stop();
    if (!deliberate) toast('Audio was interrupted — press start again', 'bad');
  }
}

/* One scheduled note. A unison hit is played as an accent on voice A only —
   two voices firing on the same sample sum into a flam-flavoured blur, and
   the accent reads as "both" more clearly than the pile-up does. */
function voiceClick(t, v, coin) {
  if (!actx) return;
  if (coin) {
    if (sound.A || sound.B) playVoice(actx, master, t, voice.A, 'accent', 1);
    return;
  }
  if (v === 'A' && sound.A) playVoice(actx, master, t, voice.A, 'normal', 0.9);
  else if (v === 'B' && sound.B) playVoice(actx, master, t, voice.B, 'normal', 0.85);
}
/* The player's own tap: pitchless, so it never sounds like a third voice. */
function tapClick(v) {
  if (!actx) return;
  playVoice(actx, master, actx.currentTime, 'tick', 'ghost', v === 'A' ? 0.8 : 0.7);
}

/* ---------------- storage ---------------- */
const LS = 'poly-trainer-v1';
function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({ best, settings: { A, B, bpm, tolMs, latMs, sound, voice } }));
  } catch (e) { /* private mode — settings just do not persist */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(LS) || '{}');
    best = d.best || 0;
    const s = d.settings || {};
    if (s.A) A = clamp(s.A | 0, 1, 16);
    if (s.B) B = clamp(s.B | 0, 1, 16);
    if (s.bpm) bpm = clamp(s.bpm | 0, 30, 240);
    if (s.tolMs) tolMs = clamp(s.tolMs | 0, 15, 120);
    if (typeof s.latMs === 'number') latMs = clamp(s.latMs, -120, 120);
    // key by key, so a retired flag in old storage (`hap`, now a Poly-wide
    // setting of its own) is dropped rather than carried around for ever
    if (s.sound) for (const k of Object.keys(sound)) if (k in s.sound) sound[k] = !!s.sound[k];
    if (s.voice) {
      if (isVoice(s.voice.A)) voice.A = resolveVoice(s.voice.A);
      if (isVoice(s.voice.B)) voice.B = resolveVoice(s.voice.B);
    }
  } catch (e) { console.warn('load failed', e); }
}

/* ---------------- timing / events ---------------- */
function intervalOf(v) { return cycleSec / (v === 'A' ? A : B); }
function computeCycle() { cycleSec = A * (60 / bpm); }

function genCycleEvents(c) {
  const t0 = c * cycleSec, out = [];
  for (let i = 0; i < A; i++) out.push({ t: t0 + i * cycleSec / A, v: 'A', coin: false, state: 'pending', sched: false });
  for (let j = 0; j < B; j++) out.push({ t: t0 + j * cycleSec / B, v: 'B', coin: false, state: 'pending', sched: false });
  for (const e of out) {
    for (const f of out) if (e.v !== f.v && Math.abs(e.t - f.t) < 0.0015) e.coin = true;
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}
function ensureEvents(untilRel) {
  while (genCycle * cycleSec < untilRel + cycleSec * 2) {
    events = events.concat(genCycleEvents(genCycle++));
  }
}
let lastPrune = 0;
function pruneEvents(rel) {
  if (rel - lastPrune < 2) return;   // keep the list a few seconds long, always
  lastPrune = rel;
  events = events.filter(e => e.t > rel - 3);
}

/* ---------------- transport ---------------- */
let schedTimer = null, rafId = null, leadSec = 0;

function start() {
  if (!ensureAudio()) return;
  if (playing) return;
  playing = true;
  computeCycle();
  events = []; genCycle = 0; floats = [];
  evaluated = 0; goodCount = 0; errSum = 0; errN = 0;
  hist = { A: [], B: [] }; renderHist();
  lastBeat = { A: -1, B: -1 };
  setStat('sAcc', '—'); setStat('sTiming', '—');
  $('sTiming').style.color = '';

  leadSec = sound.count ? cycleSec : 0;
  clockOffset = null; syncClock(); measureAutoLatency();
  startTime = actx.currentTime + 0.18 + leadSec;
  ensureEvents(0);

  if (leadSec > 0) {
    for (let i = 0; i < A; i++) {
      playVoice(actx, master, startTime - leadSec + i * cycleSec / A, 'click', i === 0 ? 'accent' : 'ghost', 0.8);
    }
  }
  $('playBtn').classList.add('playing');
  scheduleTick();
  loop();
  updateStatus();
}

/* A ratio or tempo change mid-session rebuilds the grid but must not wipe the
   run — you are still playing, so the streak and the averages carry over. */
function restartKeepingScore() {
  if (!playing) return;
  const keep = [streak, evaluated, goodCount, errSum, errN];
  const wasCount = sound.count;
  sound.count = false;
  stop(true); start();
  sound.count = wasCount;
  [streak, evaluated, goodCount, errSum, errN] = keep;
  updateStats();
}

function stop(quiet) {
  playing = false;
  haptics.cancel();
  clearTimeout(schedTimer);
  cancelAnimationFrame(rafId);
  $('playBtn').classList.remove('playing');
  $('countin').classList.remove('on');
  $('apA').style.width = '0%'; $('apB').style.width = '0%';
  ['A', 'B'].forEach(v => {
    const pad = $('pad' + v);
    flashTok.set(pad, (flashTok.get(pad) || 0) + 1);   // void any pending flash
    pad.classList.remove('beat', 'pressed', 'good', 'ok', 'bad');
    $('err' + v).classList.remove('show');
  });
  if (!quiet) { draw(-999); updateStatus(); }
}

function scheduleTick() {
  if (!playing || !actx) return;
  syncClock();
  const now = actx.currentTime, rel = now - startTime;
  ensureEvents(rel);
  for (const e of events) {
    if (e.sched) continue;
    const at = startTime + e.t;
    if (at < now + 0.3) {
      e.sched = true;
      if (at >= now - 0.02) voiceClick(Math.max(at, now), e.v, e.coin);
    }
  }
  schedTimer = setTimeout(scheduleTick, 25);
}

function togglePlay() { if (playing) stop(); else start(); }

/* ---------------- scoring ---------------- */
/* How late a note may be answered before it counts as missed. Capped at half
   the voice's own interval so a tap can never be claimed by two notes. */
function missWindow(v) { return Math.min(intervalOf(v) * 0.5, Math.max(tolMs / 1000 * 2.5, 0.13)); }

function handleTap(v, evTime) {
  if (!playing) { start(); return; }
  // stamp from the event itself; fall back only if it looks unusable
  const nowPerf = performance.now();
  const stamp = (typeof evTime === 'number' && evTime > 0 && nowPerf - evTime >= 0 && nowPerf - evTime < 300)
    ? evTime : nowPerf;
  const rel = audioTimeOf(stamp) - startTime - autoLat - latMs / 1000;

  if (sound.tap) tapClick(v);            // audible first, then the bookkeeping
  if (rel < -0.05) { flashKey(v); return; }   // count-in: free practice, unscored

  const win = missWindow(v);
  let target = null, bestErr = Infinity;
  for (const e of events) {
    if (e.v !== v || e.state !== 'pending') continue;
    const err = rel - e.t;
    if (Math.abs(err) < Math.abs(bestErr)) { bestErr = err; target = e; }
  }
  if (!target || Math.abs(bestErr) > win) {
    registerGrade(v, 'bad', null, true);     // ghost tap — no note near it
    return;
  }
  const absMs = Math.abs(bestErr) * 1000;
  const grade = absMs <= tolMs ? 'good' : (absMs <= tolMs * 2 ? 'ok' : 'bad');
  target.state = 'hit'; target.grade = grade; target.err = bestErr; target.tapT = rel;
  errSum += bestErr * 1000; errN++;
  registerGrade(v, grade, bestErr * 1000, false);
}

function registerGrade(v, grade, errMs, ghost) {
  if (!ghost) { evaluated++; if (grade === 'good') goodCount++; }
  if (grade === 'good') {
    streak++;
    if (streak > best) {
      best = streak; save();
      if (streak > 0 && streak % 10 === 0) toast('New best · ' + best, 'good');
    }
  } else if (grade === 'bad') {
    if (streak >= 8) toast('Streak broken at ' + streak, 'bad');
    streak = 0;
    haptics.pulse('miss');
  }
  pulsePad(v, grade, errMs, ghost);
  updateStats();
}

function noteMissed(e) {
  e.state = 'miss';
  evaluated++;
  if (streak >= 8) toast(`Missed a ${e.v} · streak ${streak}`, 'bad');
  streak = 0;
  updateStats();
  flash($('pad' + e.v), 'bad', 220, GRADES);
  pushHist(e.v, 'bad');
}

/* ---------------- stats ---------------- */
function updateStats() {
  const grew = streak > lastStreakShown;
  setStat('sStreak', streak);
  setStat('sBest', best);
  // the streak counter kicks each time it climbs — the run is the score here,
  // and it should register without being read
  if (grew) flash($('sStreak'), 'bump', 300);
  lastStreakShown = streak;
  $('stStreak').classList.toggle('hot', streak >= 10);
  setStat('sAcc', evaluated ? Math.round(goodCount / evaluated * 100) + '%' : '—');
  if (errN > 2) {
    const m = errSum / errN;
    setStat('sTiming', (m > 0 ? '+' : '') + m.toFixed(0) + ' ms');
    $('sTiming').style.color = Math.abs(m) < 12 ? 'var(--good)' : (Math.abs(m) < 30 ? 'var(--warn)' : 'var(--danger)');
  } else {
    setStat('sTiming', '—');
    $('sTiming').style.color = '';
  }
}
function setStat(id, v) {
  const el = $(id);
  if (el.textContent !== String(v)) el.textContent = v;
}

function pulsePad(v, grade, errMs, ghost) {
  flash($('pad' + v), grade, 230, GRADES);
  const el = $('err' + v);
  const blank = errMs === null || errMs === undefined;
  if (blank) el.textContent = ghost ? 'no note' : '';
  else el.textContent = (errMs > 0 ? '+' : '') + errMs.toFixed(0) + ' ms ' + (errMs > 0 ? 'late' : 'early');
  // a blank reading (a tap with nothing to score) leaves the pill hidden
  // rather than showing an empty outline
  el.className = 'err' + (el.textContent ? ' show' : '') + (blank ? '' : ' ' + grade);
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 700);
  if (!ghost) pushHist(v, grade);
  if (errMs !== null && errMs !== undefined) {
    floats.push({ v, grade, txt: (errMs > 0 ? '+' : '') + errMs.toFixed(0), t0: performance.now() });
  }
}

const GRADES = ['good', 'ok', 'bad'];
/* Flashes are token-guarded: a second flash on the same element cancels the
   first one's cleanup, so a fast passage cannot leave a colour stuck on. */
const flashTok = new WeakMap();
function flash(el, cls, ms, group) {
  const t = (flashTok.get(el) || 0) + 1;
  flashTok.set(el, t);
  (group || [cls]).forEach(c => el.classList.remove(c));
  requestAnimationFrame(() => {
    if (flashTok.get(el) !== t) return;
    el.classList.add(cls);
    setTimeout(() => { if (flashTok.get(el) === t) el.classList.remove(cls); }, ms);
  });
}

function pushHist(v, g) {
  hist[v].push(g);
  if (hist[v].length > 9) hist[v].shift();
  renderHist();
}
const histNodes = {};
function initHist() {
  ['A', 'B'].forEach(v => {
    const c = $('hist' + v);
    c.innerHTML = ''; histNodes[v] = [];
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('i');
      c.appendChild(d); histNodes[v].push(d);
    }
  });
}
function renderHist() {
  ['A', 'B'].forEach(v => {
    const nodes = histNodes[v];
    if (!nodes) return;
    for (let i = 0; i < 9; i++) {
      const g = hist[v][hist[v].length - 9 + i] || '';
      if (nodes[i].className !== g) nodes[i].className = g;
    }
  });
}

/* ---------------- canvas ---------------- */
const cv = $('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0;
function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = r.width; H = r.height;
  if (!playing) draw(-999);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
if (window.ResizeObserver) {
  let rw = 0, rh = 0;
  new ResizeObserver(es => {
    const r = es[0].contentRect;
    if (Math.abs(r.width - rw) < 0.5 && Math.abs(r.height - rh) < 0.5) return;
    rw = r.width; rh = r.height;
    resize();
  }).observe(cv);
}

function loop() {
  if (!playing || !actx) return;
  const rel = relNow();

  for (const e of events) {
    if (e.state === 'pending' && rel > e.t + missWindow(e.v)) noteMissed(e);
  }
  pruneEvents(rel);
  ensureEvents(rel);

  // beat pulses + approach bars
  ['A', 'B'].forEach(v => {
    const iv = intervalOf(v);
    const idx = Math.floor(rel / iv);
    if (idx !== lastBeat[v] && rel >= -leadSec) {
      lastBeat[v] = idx;
      flash($('pad' + v), 'beat', 160);
      /* Fired from the same place as the visual pulse, so what the hand
         feels and what the eye sees are the same event — which is the
         point of haptics here: the cross-rhythm arrives through a second
         sense while you are busy looking at the playhead. A gets the
         stronger tap so the two voices stay tellable apart. */
      haptics.pulse(v === 'A' ? 'accent' : 'beat');
    }
    const frac = (((rel % iv) + iv) % iv) / iv;
    $('ap' + v).style.width = (frac * 100).toFixed(1) + '%';
  });

  if (rel < 0) {
    const beatsLeft = Math.ceil(-rel / (cycleSec / A));
    $('countin').classList.add('on');
    const n = String(beatsLeft);
    const nEl = $('countinN');
    if (nEl.textContent !== n) {
      nEl.textContent = n;
      nEl.style.animation = 'none'; void nEl.offsetWidth; nEl.style.animation = '';
    }
    $('statusPos').textContent = 'count-in';
  } else {
    $('countin').classList.remove('on');
    $('statusPos').textContent = 'cycle ' + (Math.floor(rel / cycleSec) + 1);
  }

  draw(rel);
  rafId = requestAnimationFrame(loop);
}

function draw(rel) {
  const idle = rel < -900;
  ctx.clearRect(0, 0, W, H);
  const bgG = ctx.createLinearGradient(0, 0, 0, H);
  bgG.addColorStop(0, 'rgba(255,255,255,.02)');
  bgG.addColorStop(1, 'rgba(0,0,0,.10)');
  ctx.fillStyle = bgG;
  ctx.fillRect(0, 0, W, H);

  if (cycleSec <= 0) computeCycle();
  const winSec = clamp(cycleSec * 1.15, 1.1, 6);
  const pps = W / winSec;
  const playX = Math.round(W * 0.30);
  const yA = H * 0.30, yB = H * 0.70;
  const rN = clamp(Math.min(W * 0.02, H * 0.055), 4.5, 9);
  const relPos = idle ? 0 : rel;

  if (idle) { events = []; genCycle = 0; ensureEvents(winSec); }
  else ensureEvents(rel + winSec);

  // lane rails
  ctx.lineWidth = 1;
  [[yA, COL.railA], [yB, COL.railB]].forEach(([y, c]) => {
    ctx.strokeStyle = c;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  });
  ctx.font = `700 10px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(231,236,243,.28)';
  ctx.fillText('A', 6, Math.max(11, yA - rN - 6));
  ctx.fillText('B', 6, Math.min(H - 4, yB + rN + 14));

  const xOf = t => playX + (t - relPos) * pps;

  // cycle boundaries
  const firstCycle = Math.floor((relPos - playX / pps) / cycleSec);
  for (let c = firstCycle; c < firstCycle + 6; c++) {
    const x = xOf(c * cycleSec);
    if (x < -4 || x > W + 4) continue;
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, H * 0.10); ctx.lineTo(x, H * 0.90); ctx.stroke();
    ctx.setLineDash([]);
  }

  // unison connectors
  for (const e of events) {
    if (!e.coin || e.v !== 'A') continue;
    const x = xOf(e.t);
    if (x < -20 || x > W + 20) continue;
    ctx.strokeStyle = 'rgba(231,236,243,.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, yA); ctx.lineTo(x, yB); ctx.stroke();
  }

  // notes
  for (const e of events) {
    const x = xOf(e.t);
    if (x < -24 || x > W + 24) continue;
    const y = e.v === 'A' ? yA : yB;
    const base = e.coin ? COL.unison : COL[e.v];
    const near = clamp(1 - Math.abs(x - playX) / (pps * 0.35), 0, 1);
    let col = base, r = rN, alpha = 1, ring = null;

    if (e.state === 'hit') { col = COL[e.grade]; ring = COL[e.grade]; }
    else if (e.state === 'miss') { col = 'rgba(120,60,70,.55)'; alpha = .55; }
    else if (idle) { alpha = .62; }
    else { alpha = x < playX - 4 ? .5 : (0.55 + 0.45 * near); r = rN * (1 + 0.24 * near); }

    // approach halo — the note swells as it nears the line
    if (e.state === 'pending' && !idle && near > 0.02) {
      ctx.globalAlpha = near * 0.20;
      ctx.fillStyle = base;
      ctx.beginPath(); ctx.arc(x, y, r * 2.3, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();

    if (e.state === 'hit') {
      ctx.globalAlpha = .9; ctx.strokeStyle = ring; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, 6.2832); ctx.stroke();
      // where the tap actually landed
      const tx = xOf(e.tapT);
      ctx.globalAlpha = .75; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(tx, y - r - 9); ctx.lineTo(tx, y + r + 9); ctx.stroke();
    }
    if (e.state === 'miss') {
      ctx.globalAlpha = .8; ctx.strokeStyle = 'rgba(255,107,129,.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // tolerance band + playhead
  const bandW = Math.max(3, tolMs / 1000 * pps);
  ctx.fillStyle = 'rgba(255,255,255,.04)';
  ctx.fillRect(playX - bandW, H * 0.09, bandW * 2, H * 0.82);
  const pg = ctx.createLinearGradient(playX, H * 0.07, playX, H * 0.93);
  pg.addColorStop(0, 'rgba(231,236,243,.28)');
  pg.addColorStop(.5, 'rgba(231,236,243,.85)');
  pg.addColorStop(1, 'rgba(231,236,243,.28)');
  ctx.strokeStyle = pg; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(playX, H * 0.07); ctx.lineTo(playX, H * 0.93); ctx.stroke();

  // floating error labels
  const now = performance.now();
  floats = floats.filter(f => now - f.t0 < 900);
  ctx.textAlign = 'center';
  ctx.font = `700 11px ${MONO}`;
  floats.forEach(f => {
    const p = (now - f.t0) / 900;
    ctx.globalAlpha = (1 - p) * 0.95;
    ctx.fillStyle = COL[f.grade];
    const y = clamp((f.v === 'A' ? yA - rN * 2.6 : yB + rN * 3.4) - p * 14, 12, H - 6);
    ctx.fillText(f.txt + 'ms', playX, y);
  });
  ctx.globalAlpha = 1;

  if (idle && H > 130) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(231,236,243,.34)';
    ctx.font = '500 12px Sora, system-ui, sans-serif';
    ctx.fillText('Press Start — notes flow toward the line', W / 2, H - 10);
  }
}

/* ---------------- UI wiring ---------------- */
function syncRatio() {
  $('ratioA').textContent = A; $('ratioB').textContent = B;
  $('padAN').textContent = A; $('padBN').textContent = B;
  const i = PRESETS.findIndex(p => p.a === A && p.b === B);
  document.querySelectorAll('.preset').forEach((el, j) => el.classList.toggle('active', j === i));
  computeCycle();
  if (!playing) { events = []; genCycle = 0; draw(-999); }
}

function buildPresets() {
  const c = $('presets');
  c.innerHTML = '';
  PRESETS.forEach(p => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'preset';
    el.innerHTML = `<b>${p.a}:${p.b}</b><span>${p.lvl}</span>`;
    el.addEventListener('click', () => {
      A = p.a; B = p.b;
      syncRatio(); save();
      if (playing) restartKeepingScore();
    });
    c.appendChild(el);
  });
}

function buildVoicePickers() {
  ['A', 'B'].forEach(v => {
    const sel = $('voice' + v);
    sel.innerHTML = '';
    VOICES.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.name; opt.title = o.desc;
      sel.appendChild(opt);
    });
    sel.value = voice[v];
    sel.addEventListener('change', () => {
      voice[v] = sel.value;
      save();
      // audition it, so the choice is heard rather than guessed
      ensureAudio();
      playVoice(actx, master, actx.currentTime + 0.02, voice[v], 'normal', 0.9);
    });
  });
}

function setBpm(v, quiet) {
  bpm = clamp(Math.round(v), 30, 240);
  $('bpmReadout').textContent = bpm;
  $('statusBpm').textContent = bpm + ' BPM';
  if (!quiet) $('bpm').value = bpm;
  computeCycle(); save();
  if (playing) restartKeepingScore(); else draw(-999);
}
function setTol(v) {
  tolMs = clamp(v | 0, 15, 120);
  $('tolV').textContent = '±' + tolMs + ' ms';
  $('tolNote').textContent = '±' + tolMs + ' ms';
  $('tol').value = tolMs;
  save();
  if (!playing) draw(-999);
}
function setLat(v) {
  latMs = clamp(v | 0, -120, 120);
  $('latV').textContent = (latMs > 0 ? '+' : '') + latMs + ' ms';
  $('lat').value = latMs;
  save();
}

function updateStatus() {
  $('statusPos').textContent = playing ? 'playing' : 'stopped';
  $('statusBpm').textContent = bpm + ' BPM';
}

/* ---- pads ---- */
function bindPad(v) {
  const pad = $('pad' + v);
  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    pad.classList.add('pressed');
    ensureAudio();
    handleTap(v, e.timeStamp);
  });
  // keyboard activation (Enter/Space on a focused pad) reports detail 0
  pad.addEventListener('click', e => {
    if (e.detail === 0) { ensureAudio(); handleTap(v, e.timeStamp); flashKey(v); }
  });
  const up = () => pad.classList.remove('pressed');
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('pointerleave', up);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  pad.addEventListener('contextmenu', e => e.preventDefault());
}
function flashKey(v) {
  const p = $('pad' + v);
  p.classList.add('pressed');
  setTimeout(() => p.classList.remove('pressed'), 90);
}

/* ---- sheet ---- */
function openSheet() {
  $('sheet').classList.add('on');
  $('scrim').classList.add('on');
  $('sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('sheet').classList.remove('on');
  $('scrim').classList.remove('on');
  $('sheet').setAttribute('aria-hidden', 'true');
}

/* ---- toast ---- */
let toastT = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast ' + (kind || ''); }, 1700);
}

/* ---------------- init ---------------- */
load();
initHist();
buildPresets();
buildVoicePickers();
syncRatio();
setBpm(bpm); setTol(tolMs); setLat(latMs);
updateStats();
updateStatus();
resize();

$('playBtn').addEventListener('click', togglePlay);
$('bpmUp').addEventListener('click', () => setBpm(bpm + (bpm >= 120 ? 5 : 2)));
$('bpmDown').addEventListener('click', () => setBpm(bpm - (bpm > 120 ? 5 : 2)));
/* dragging only repaints the readout; the grid is rebuilt once on release, so
   a drag across the range does not restart the exercise on every step */
$('bpm').addEventListener('input', e => {
  bpm = clamp(+e.target.value, 30, 240);
  $('bpmReadout').textContent = bpm;
  $('statusBpm').textContent = bpm + ' BPM';
});
$('bpm').addEventListener('change', e => setBpm(+e.target.value, true));
$('tol').addEventListener('input', e => setTol(+e.target.value));
$('lat').addEventListener('input', e => setLat(+e.target.value));

document.querySelectorAll('[data-step]').forEach(b => {
  b.addEventListener('click', () => {
    const d = b.dataset.step;
    if (d[0] === 'a') A = clamp(A + (d[1] === '+' ? 1 : -1), 1, 16);
    else B = clamp(B + (d[1] === '+' ? 1 : -1), 1, 16);
    syncRatio(); save();
    if (playing) restartKeepingScore();
  });
});

/* Haptics is one Poly-wide setting, not a trainer setting — it is offered
   here as well because this is where you find out you want it, and a
   change made here is the same change the hub shows. */
(() => {
  const el = $('tgHap'), sw = el.querySelector('.sw'), note = $('hapNote');
  const supported = haptics.isSupported();
  if (!supported) { el.setAttribute('aria-disabled', 'true'); note.textContent = haptics.supportNote(); }
  const sync = () => {
    const on = haptics.isEnabled();
    sw.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    if (supported) note.textContent = on ? haptics.supportNote() : 'Feel each voice as it lands';
  };
  sync();
  haptics.onChange(sync);
  if (supported) el.addEventListener('click', () => haptics.setEnabled(!haptics.isEnabled()));
})();

[['tgA', 'A'], ['tgB', 'B'], ['tgTap', 'tap'], ['tgCount', 'count']].forEach(([id, key]) => {
  const el = $(id), sw = el.querySelector('.sw');
  sw.classList.toggle('on', !!sound[key]);
  el.addEventListener('click', () => {
    sound[key] = !sound[key];
    sw.classList.toggle('on', sound[key]);
    save();
  });
});

$('settingsBtn').addEventListener('click', openSheet);
$('closeBtn').addEventListener('click', closeSheet);
$('scrim').addEventListener('click', closeSheet);
$('resetBtn').addEventListener('click', () => {
  streak = 0; best = 0; evaluated = 0; goodCount = 0; errSum = 0; errN = 0;
  hist = { A: [], B: [] };
  renderHist(); updateStats(); save();
  toast('Progress reset', 'bad');
});

bindPad('A'); bindPad('B');

document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'f' || k === 'arrowleft' || k === 'a') { e.preventDefault(); ensureAudio(); handleTap('A', e.timeStamp); flashKey('A'); }
  else if (k === 'j' || k === 'arrowright' || k === 'l') { e.preventDefault(); ensureAudio(); handleTap('B', e.timeStamp); flashKey('B'); }
  else if (e.code === 'Space' || k === 'enter') { e.preventDefault(); togglePlay(); }
  else if (k === 'escape') { closeSheet(); }
});

/* On touch there are no keys to name, and no room for a keyboard hint. */
if (matchMedia('(hover: none)').matches) {
  $('keyA').textContent = 'left hand';
  $('keyB').textContent = 'right hand';
  $('statusHint').textContent = 'two hands, one pad each';
}

document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });

/* A read-only window onto the clock, for checking latency and frame health
   from the console — `__poly.rel` is where the exercise thinks it is. */
window.__poly = {
  get playing() { return playing; },
  get rel() { return playing ? relNow() : null; },
  get cycleSec() { return cycleSec; },
  get ratio() { return A + ':' + B; },
  get autoLatMs() { return Math.round(autoLat * 1000); },
  get clockOffset() { return clockOffset; },
  get ctxState() { return actx && actx.state; },
  get events() { return events.length; },
  get stats() { return { streak, best, evaluated, goodCount, meanErrMs: errN ? errSum / errN : null }; },
};

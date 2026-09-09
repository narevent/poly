/* ============================================================
   Poly Circles — a polyrhythm visualiser.
   ============================================================
   THE MODEL
   One cycle of time is a circle. Each voice is a ring; its
   pulses sit as dots at even angles, joined into a polygon —
   3 is a triangle, 5 a pentagon. The polygons DO NOT SPIN.
   The shape is the rhythm's identity: always readable, always
   upright.

   Time is one playhead — a radial hand sweeping from 12
   o'clock clockwise once per cycle. It touches a voice's dots
   exactly when they sound, so you watch agreement happen
   rather than chase a spinning shape.

   TEMPO — BPM is the SLOWEST voice's rate in cycles per
   minute, so 3:5 at 45 bpm turns the hand once every 1.33 s
   and nothing blurs.

   AUDIO — a lookahead scheduler on AudioContext time; the
   visuals read the same clock, so what you see is what you
   hear.
   ============================================================ */
import {
  load, save, makeVoice, PRESETS,
  MAX_VOICES, MAX_PULSES, MIN_BPM, MAX_BPM, SOUNDS, clampPitch,
} from './store.js';
import { createContext, attach } from '../../shared/audio-session.js';
import { prepare, playVoice } from '../../shared/voices.js';

/* ---------------------------------------------------------- */
/* DOM                                                        */
/* ---------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const ui = {
  play: $('playBtn'),
  bpm: $('bpmReadout'),
  canvas: $('stage'),
  frame: $('stageFrame'),
  rows: $('voiceRows'),
  legend: $('voicesLegend'),
  add: $('addVoice'),
  presets: $('presetChips'),
  status: $('statusPos'),
  ratio: $('statusRatio'),
  ratioBadge: $('ratioBadge'),
  statusBpm: $('statusBpm'),
  cycleInfo: $('cycleInfo'),
};

const state = load();

/* ---------------------------------------------------------- */
/* Canvas                                                     */
/* ---------------------------------------------------------- */
const canvas = ui.canvas;
const g = canvas.getContext('2d');
let DPR = 1, cx = 0, cy = 0, outerR = 0;

function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * DPR);
  canvas.height = Math.round(r.height * DPR);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx = r.width / 2;
  cy = r.height / 2;
  /* margin must fit the outer dot AND its bloom AND the playhead tip —
     18 CSS px keeps everything inside the rim on any screen */
  outerR = Math.min(cx, cy) - 18;
  return true;
}
new ResizeObserver(() => resize()).observe(ui.frame);
/* some browsers fire the observer before layout settles; the frame loop
   re-checks until the canvas has real geometry, so the stage is never
   left unsized */
function ensureSized() {
  if (!outerR) resize();
}

const TAU = Math.PI * 2;
/* pulse 0 always sits at 12 o'clock, shapes never spin */
const angleOf = (i, n) => -Math.PI / 2 + (i / n) * TAU;
const pt = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];

/* ---------------------------------------------------------- */
/* Time                                                       */
/* ---------------------------------------------------------- */
/* one full rotation of the playhead */
const cycleSec = () => 60 / state.bpm;

/* ---------------------------------------------------------- */
/* Audio                                                      */
/* ---------------------------------------------------------- */
let session = null;
let playing = false;
let schedTimer = null;
let nextTime = 0;
let cycleIndex = 0;
const LOOKAHEAD = 0.30;
const TICK_MS = 40;

async function ensureSession() {
  if (session) {
    if (session.ctx.state === 'suspended') await session.ctx.resume();
    return session;
  }
  const ac = await createContext();
  if (!ac) { setStatus('audio unavailable in this browser'); return null; }
  session = { ctx: ac, master: ac.destination };
  attach(ac, {
    isActive: () => playing,
    onLost: () => {
      session = null;
      if (playing) {
        playing = false;
        clearInterval(schedTimer);
        syncPlayBtn();
        setStatus('audio lost — tap play');
      }
    },
  });
  if (session.ctx.state === 'suspended') await session.ctx.resume();
  prepare(ac);
  return session;
}

function setStatus(msg) {
  if (ui.status) ui.status.textContent = msg;
}

function syncPlayBtn() {
  ui.play.classList.toggle('playing', playing);
  ui.play.setAttribute('aria-pressed', String(playing));
}

function start() {
  if (playing) return;
  ensureSession().then((s) => {
    if (!s) return;
    playing = true;
    syncPlayBtn();
    nextTime = s.ctx.currentTime + 0.08;
    cycleIndex = 0;
    schedTimer = setInterval(schedTick, TICK_MS);
  });
}

function stop() {
  if (!playing) return;
  playing = false;
  syncPlayBtn();
  clearInterval(schedTimer);
}

function toggle() { playing ? stop() : start(); }

function audible() {
  const anySolo = state.voices.some((v) => v.solo);
  return state.voices.filter((v) => !v.muted && (!anySolo || v.solo));
}

/* Schedule every voice's pulses for one cycle, then step the
   cycle boundary forward. Voices keep the same alignment no
   matter how you edit the arrangement. */
function schedTick() {
  const now = session.ctx.currentTime;
  /* If the clock stalled or jumped (tab throttled, ctx suspended), re-anchor
     instead of trying to catch up forever. */
  if (nextTime < now) nextTime = now + 0.02;
  const horizon = now + LOOKAHEAD;
  let guard = 0;
  while (nextTime < horizon && guard++ < 64) {
    const cyc = cycleSec();
    for (const v of audible()) {
      const step = cyc / v.pulses;
      for (let i = 0; i < v.pulses; i++) {
        playVoice(session.ctx, session.master, nextTime + i * step, v.sound,
          i === 0 ? 'accent' : 'normal', v.level, v.pitch);
      }
    }
    nextTime += cyc;
    cycleIndex += 1;
  }
}

/* ---------------------------------------------------------- */
/* Drawing                                                    */
/* ---------------------------------------------------------- */
function draw() {
  const w = canvas.width / DPR;
  const h = canvas.height / DPR;
  g.clearRect(0, 0, w, h);

  const vs = state.voices;
  const n = vs.length;
  const cyc = cycleSec();
  const t = session ? session.ctx.currentTime : 0;

  /* Rings grow from the centre outwards; the first voice owns the outer
     ring, so the voice you added first is the one you read first. */
  const ringGap = n > 1 ? (outerR * 0.62) / (n - 1) : 0;
  const innerR = outerR * 0.38;

  /* playhead phase 0..1 — 0 at 12 o'clock, sweeping clockwise */
  const phase = playing && session ? (((t % cyc) + cyc) % cyc) / cyc : -1;

  vs.forEach((v, k) => {
    const r = n > 1 ? innerR + (n - 1 - k) * ringGap : innerR + ringGap;
    const P = v.pulses;
    const active = !v.muted && (!state.voices.some(x => x.solo) || v.solo);

    /* --- outlined circle: the ring itself is the voice --- */
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.lineWidth = active ? 2 : 1;
    g.strokeStyle = v.color;
    g.globalAlpha = active ? 0.5 : 0.14;
    g.stroke();
    g.globalAlpha = 1;

    /* --- pulse dots; the one the playhead just passed blooms --- */
    /* which dot did the playhead last pass, and how long ago?
       dot i sits at phase i/P, so the last one passed is floor(phase*P). */
    const pAbs = phase < 0 ? -1 : phase * P;
    const hitIdx = pAbs >= 0 ? Math.floor(pAbs) % P : -1;
    const since = pAbs >= 0 ? (pAbs - Math.floor(pAbs)) * (cyc / P) : Infinity;
    const hot = since < 0.16;
    for (let i = 0; i < P; i++) {
      const [x, y] = pt(angleOf(i, P), r);
      const isHead = i === 0;
      const base = isHead ? 5.5 : 4.2;
      g.beginPath();
      g.arc(x, y, base * (hot && i === hitIdx ? 1.25 : 1), 0, TAU);
      g.fillStyle = v.color;
      g.globalAlpha = active ? (isHead ? 1 : 0.75) : 0.16;
      g.fill();

      /* bloom: the dot the playhead just passed, on this ring */
      if (hot && i === hitIdx) {
        g.beginPath();
        g.arc(x, y, 8 + since * 36, 0, TAU);
        g.globalAlpha = (1 - since / 0.16) * 0.5;
        g.fill();
      }
      g.globalAlpha = 1;
    }

    /* label the ring with its pulse count, nudged right of the head dot
       so it never collides with the playhead (which sits at 12 o'clock) */
    if (active) {
      const a = -Math.PI / 2 + 0.30;
      const [lx, ly] = pt(a, r);
      g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = v.color;
      g.globalAlpha = 0.95;
      g.fillText(String(P), lx, ly);
      g.globalAlpha = 1;
    }
  });

  /* --- the playhead: a bright radial hand, the visual anchor --- */
  if (playing && session) {
    const phase = (((t % cyc) + cyc) % cyc) / cyc;    // 0..1
    const a = -Math.PI / 2 + phase * TAU;
    const [tx, ty] = pt(a, outerR + 8);

    /* soft trailing wedge — motion reads at a glance */
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, outerR, a - 0.16, a);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fill();

    /* the hand */
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(tx, ty);
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.stroke();

    /* bright tip at the rim */
    g.beginPath();
    g.arc(tx, ty, 5, 0, TAU);
    g.fillStyle = '#fff';
    g.fill();
  }
}

/* ---------------------------------------------------------- */
/* Voice rows                                                 */
/* ---------------------------------------------------------- */
function renderVoices() {
  ui.rows.textContent = '';
  state.voices.forEach((v, k) => ui.rows.appendChild(rowFor(v, k)));
  ui.add.disabled = state.voices.length >= MAX_VOICES;
}

function rowFor(v, k) {
  const row = document.createElement('div');
  row.className = 'voice-row' + (v.muted ? ' is-muted' : '');

  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = v.color;

  const minus = document.createElement('button');
  minus.className = 'step'; minus.textContent = '−';
  const plus = document.createElement('button');
  plus.className = 'step'; plus.textContent = '+';
  const count = document.createElement('span');
  count.className = 'vpulse'; count.textContent = String(v.pulses);
  const stepper = document.createElement('div');
  stepper.className = 'stepper';
  stepper.append(minus, count, plus);

  const sel = document.createElement('select');
  sel.className = 'vsound';
  sel.setAttribute('aria-label', 'sound for voice ' + (k + 1));
  for (const s of SOUNDS) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    if (s === v.sound) o.selected = true;
    sel.append(o);
  }

  const lvl = document.createElement('input');
  lvl.type = 'range'; lvl.min = '0'; lvl.max = '1'; lvl.step = '0.01';
  lvl.value = String(v.level);
  lvl.className = 'slider vlevel';
  lvl.setAttribute('aria-label', 'level for voice ' + (k + 1));

  /* pitch, in semitones relative to the sample's own pitch — lets
     overlapping voices be told apart by ear, not just by position */
  const pit = document.createElement('input');
  pit.type = 'range'; pit.min = '-12'; pit.max = '12'; pit.step = '1';
  pit.value = String(v.pitch ?? 0);
  pit.className = 'slider vpitch';
  pit.setAttribute('aria-label', 'pitch for voice ' + (k + 1));
  const pitOut = document.createElement('span');
  pitOut.className = 'vpitch-out';
  const pitLabel = () => {
    const n = Number(pit.value);
    pitOut.textContent = (n > 0 ? '+' : '') + n + ' st';
  };
  pitLabel();

  const mute = document.createElement('button');
  mute.className = 'pill'; mute.textContent = 'M';
  mute.classList.toggle('is-on', v.muted);
  const solo = document.createElement('button');
  solo.className = 'pill'; solo.textContent = 'S';
  solo.classList.toggle('is-on', v.solo);
  const del = document.createElement('button');
  del.className = 'pill pill-x'; del.textContent = '×';
  del.disabled = state.voices.length <= 1;

  const pills = document.createElement('div');
  pills.className = 'vpills';
  pills.append(mute, solo, del);

  const pitchRow = document.createElement('div');
  pitchRow.className = 'vpitch-row vpitch-bipolar';
  const pitTag = document.createElement('span');
  pitTag.className = 'vpitch-tag';
  pitTag.textContent = 'pitch';
  pitchRow.append(pitTag, pitOut, pit);

  /* level row — same captioned-slider shape as the pitch row, so the two
     knobs are self-describing and visually paired */
  const lvlRow = document.createElement('div');
  lvlRow.className = 'vpitch-row';
  const lvlTag = document.createElement('span');
  lvlTag.className = 'vpitch-tag';
  lvlTag.textContent = 'level';
  const lvlOut = document.createElement('span');
  lvlOut.className = 'vpitch-out';
  const lvlLabel = () => { lvlOut.textContent = Math.round(v.level * 100) + '%'; };
  lvlLabel();
  lvlRow.append(lvlTag, lvlOut, lvl);

  /* ---------- column A: identity — sound, then subdivision ---------- */
  const colA = document.createElement('div');
  colA.className = 'vcol vcol-a';
  colA.append(sel, stepper);

  /* ---------- column B: mix — buttons, then pitch, then volume ---------- */
  const colB = document.createElement('div');
  colB.className = 'vcol vcol-b';
  colB.append(pills, pitchRow, lvlRow);

  row.append(sw, colA, colB);

  minus.addEventListener('click', () => {
    if (v.pulses > 1) { v.pulses -= 1; persist(); }
  });
  plus.addEventListener('click', () => {
    if (v.pulses < MAX_PULSES) { v.pulses += 1; persist(); }
  });
  sel.addEventListener('change', () => { v.sound = sel.value; persist(); });
  lvl.addEventListener('input', () => { v.level = Number(lvl.value); lvlLabel(); save(state); });
  pit.addEventListener('input', () => {
    v.pitch = clampPitch(Number(pit.value));
    pitLabel();
    save(state);
  });
  pit.addEventListener('change', () => { persist(); });
  mute.addEventListener('click', () => { v.muted = !v.muted; persist(); });
  solo.addEventListener('click', () => { v.solo = !v.solo; persist(); });
  del.addEventListener('click', () => { state.voices.splice(k, 1); persist(); });

  return row;
}

/* ---------------------------------------------------------- */
/* Presets + add                                              */
/* ---------------------------------------------------------- */
function renderPresets() {
  ui.presets.textContent = '';
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.name;
    b.addEventListener('click', () => {
      state.voices = p.pulses.map((n) => makeVoice(n));
      persist();
    });
    ui.presets.appendChild(b);
  });
}

/* ---------------------------------------------------------- */
/* Readouts + persistence                                     */
/* ---------------------------------------------------------- */
function ratioText() {
  return state.voices.map((v) => v.pulses).join(' : ');
}

function updateReadouts() {
  /* only write the readout when the user isn't mid-edit */
  if (!ui.bpm.isContentEditable || document.activeElement !== ui.bpm) {
    ui.bpm.textContent = String(state.bpm);
  }
  ui.statusBpm.textContent = state.bpm + ' BPM';
  ui.ratio.textContent = ratioText();
  if (ui.ratioBadge) ui.ratioBadge.textContent = ratioText();
  if (ui.cycleInfo) {
    ui.cycleInfo.textContent =
      'one cycle = ' + cycleSec().toFixed(2) + ' s';
  }
}

function renderLegend() {
  if (!ui.legend) return;
  ui.legend.textContent = '';
  state.voices.forEach((v) => {
    const item = document.createElement('span');
    item.className = 'leg-item';
    const s = document.createElement('span');
    s.className = 'leg-sw';
    s.style.background = v.color;
    item.append(s, document.createTextNode(v.pulses + ' · ' + v.sound));
    ui.legend.append(item);
  });
}

function persist() {
  save(state);
  renderVoices();
  renderPresets();
  updateReadouts();
  renderLegend();
}

/* ---------------------------------------------------------- */
/* Controls                                                   */
/* ---------------------------------------------------------- */
function bindControls() {
  ui.play.addEventListener('click', toggle);

  /* BPM: a slider like the other apps, plus the readout doubles as a
     numeric field — type a number, or use the slider, or arrow keys. */
  const bpmSlider = $('bpmSlider');
  bpmSlider.min = String(MIN_BPM);
  bpmSlider.max = String(MAX_BPM);
  bpmSlider.step = '1';
  bpmSlider.value = String(state.bpm);
  bpmSlider.addEventListener('input', () => {
    state.bpm = Number(bpmSlider.value);
    updateReadouts();
    save(state);
  });

  ui.bpm.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      state.bpm = Math.min(MAX_BPM, state.bpm + 1); syncBpm(); e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      state.bpm = Math.max(MIN_BPM, state.bpm - 1); syncBpm(); e.preventDefault();
    } else if (e.key === 'Enter') {
      commitBpmEdit(); e.preventDefault();
    }
  });
  ui.bpm.addEventListener('blur', commitBpmEdit);

  function syncBpm() {
    bpmSlider.value = String(state.bpm);
    updateReadouts();
  }
  function commitBpmEdit() {
    const n = parseInt(ui.bpm.textContent, 10);
    if (Number.isFinite(n)) {
      state.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, n));
      syncBpm();
      save(state);
    } else {
      ui.bpm.textContent = String(state.bpm);
    }
  }

  ui.add.addEventListener('click', () => {
    if (state.voices.length >= MAX_VOICES) return;
    const used = new Set(state.voices.map((v) => v.pulses));
    let n = 2;
    while (used.has(n) && n < MAX_PULSES) n += 1;
    state.voices.push(makeVoice(n));
    persist();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof Element &&
        (e.target.matches('input, select, button'))) return;
    if (e.code === 'Space') { toggle(); e.preventDefault(); }
  });
}

/* ---------------------------------------------------------- */
/* Main                                                       */
/* ---------------------------------------------------------- */
function frame() {
  ensureSized();
  draw();
  setStatus(playing ? 'playing' : 'stopped');
  requestAnimationFrame(frame);
}

function init() {
  resize();
  renderVoices();
  renderPresets();
  updateReadouts();
  renderLegend();
  bindControls();
  requestAnimationFrame(frame);
}

init();
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
import { createContext, attach, ping, startLead, debugState } from '../../shared/audio-session.js';
import { prepare, playVoice, voiceLoad } from '../../shared/voices.js';

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
/* WHY THIS IS NOT A setInterval AND AN ACCUMULATING CURSOR

   It was, and on a phone it went silent. The animation carried on
   perfectly — it reads ctx.currentTime, which never stopped — while not
   one hit could be heard, which is exactly what makes the fault so
   confusing to look at.

   Two things caused it, and both are about scheduling a hit too late
   rather than about the context dying:

   1. iOS throttles and coalesces timer callbacks — under Low Power Mode,
      under memory pressure, whenever the main thread is busy. The old
      scheduler noticed it had been starved and re-anchored to
      `currentTime + 0.02`. Twenty milliseconds is INSIDE the engine's
      render-ahead: a source booked there is not early, it is late, and
      its attack has already been rendered as silence. On a click that is
      two milliseconds long, that is the whole click. Every hit, silently
      dropped, for as long as the throttling lasted.

   2. It accumulated `nextTime += cycle`, so one starved pass poisoned
      every pass after it.

   So now: the clock is an AudioWorklet ticking on the audio thread (which
   no phone throttles), with the timer left running underneath it as a
   bootstrap and a fallback; hit times are DERIVED from a shared grid
   rather than accumulated; a starved pass skips the missed pulses with
   modular arithmetic instead of firing them late; and nothing is ever
   booked closer than startLead(), which is the session layer's reading of
   how far ahead this engine actually renders.

   The mixer changed for the same reason the trainer's did: a hit used to
   be built as two nodes (source + its own gain) straight into the
   destination. voices.js is explicit that a caller wanting anything other
   than unity gain should hold a persistent bus and ask for 1 — so each
   voice now owns a channel gain, and a hit is one node again. */

/* Ticks on the audio thread every 512 frames (~10.7 ms at 48 kHz). Loaded
   from a Blob so the app stays a directory of static files. */
const CLOCK_WORKLET = `
class ClockProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._n = 0; }
  process() {
    this._n += 128;
    if (this._n >= 512) { this._n = 0; this.port.postMessage(0); }
    return true;
  }
}
registerProcessor('circles-clock', ClockProcessor);
`;

const MASTER_GAIN = 0.9;
const AHEAD = 0.22;      // look-ahead window (s)
const TICK_MS = 25;      // fallback clock

let session = null;      // { ctx, mix, master, chans }
let playing = false;
let timer = null;
let clockNode = null;
let statusMsg = '';      // a message that outlives one animation frame

/* The shared cycle grid. Every voice's pulses are DERIVED from it —
   `anchor` is the audio time of a cycle boundary, `gridCyc` the cycle
   length it was laid out with — so voices cannot drift apart from each
   other or from the playhead, however long the app runs and however the
   arrangement is edited underneath it. */
let anchor = 0;
let gridCyc = 0;

/* Per-voice playback counters, keyed by voice id rather than stored on the
   voice, because the voice is what gets JSON.stringify'd into
   localStorage. `k` is the pulse index since `anchor`; `last` is the time
   of the last hit booked, so a re-derived counter can never double-book
   one that is already in the look-ahead. */
const counters = new Map();
function counterFor(v) {
  let c = counters.get(v.id);
  if (!c) { c = { k: 0, last: -1 }; counters.set(v.id, c); }
  return c;
}

/* ---------- the graph ----------
     voice hits -> chan[voice] -> mix (equal-power) -> master -> limiter
   The mix law is what stops the app getting louder every time a voice is
   added, and the limiter is a backstop for the moment all the rings agree
   and every voice lands on the same instant. */
function ensureSession() {
  if (session) { ping(session.ctx); return session; }

  const ctx = createContext({ latencyHint: 'interactive' });
  if (!ctx) { setStatus('audio unavailable in this browser'); return null; }

  const mix = ctx.createGain();
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  mix.connect(master);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3;
  lim.knee.value = 0;
  lim.ratio.value = 12;
  lim.attack.value = 0.001;
  lim.release.value = 0.08;
  master.connect(lim);
  lim.connect(ctx.destination);

  session = { ctx, mix, master, chans: new Map() };

  /* Rendering the voices to buffers is an optimisation, not a
     precondition — playVoice() falls back to building the graph live. An
     engine that refuses the offline context must not take the play button
     down with it. */
  try { prepare(ctx); } catch (e) { /* live path it is */ }
  initClock(ctx);

  /* Everything about surviving on a phone — resuming from `interrupted`,
     spotting a context whose clock has stopped, handing the audio session
     back when the page is left — belongs to the session layer, the same
     way it does for the metronome and the trainer. */
  attach(ctx, {
    isActive: () => playing,
    onLost: (reason) => onCtxLost(reason),
  });

  ping(ctx);
  syncChannels();
  return session;
}

/* A context is gone: closed under us, or running with a clock that
   stopped. Rebuild and pick playback straight back up — a bar's hiccup is
   a far better answer than a metronome that is silently doing nothing.
   A `hidden` or `pagehide` release is us handing the hardware back on
   purpose and is not rebuilt. */
let recoveries = 0;
let recoveryWindow = 0;
function onCtxLost(reason) {
  session = null;
  clockNode = null;
  counters.clear();

  if (!playing) return;
  if (reason === 'hidden' || reason === 'pagehide') { hardStop(); return; }

  const t = Date.now();
  if (t - recoveryWindow > 60000) { recoveries = 0; recoveryWindow = t; }
  if (++recoveries > 3) {
    hardStop();
    setStatus('audio unavailable — tap play');
    return;
  }
  hardStop();
  start();
}

/* Upgrade the clock to the audio thread. Optional and asynchronous: if it
   fails, the fallback timer is already running. */
function initClock(ctx) {
  if (!ctx.audioWorklet || clockNode) return;
  let url;
  try {
    url = URL.createObjectURL(new Blob([CLOCK_WORKLET], { type: 'application/javascript' }));
  } catch (e) { return; }
  ctx.audioWorklet.addModule(url).then(() => {
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'circles-clock');
    // it has to stay connected to be pulled by the graph, and must not be
    // heard: route it through a muted gain
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = () => { if (playing) schedule(); };
    clockNode = node;
  }).catch(() => { try { URL.revokeObjectURL(url); } catch (e) {} });
}

/* Deliberately left running alongside the worklet rather than cleared once
   it arrives. schedule() is idempotent — a pulse already booked is skipped
   by its `last` guard — so a second driver costs nothing and covers the
   case where the worklet node itself is taken out by an interruption. */
function startClock() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!playing) return;
    try { schedule(); } catch (e) { /* one tick, not the session */ }
  }, TICK_MS);
}

function setStatus(msg) {
  statusMsg = msg;
  if (ui.status) ui.status.textContent = msg;
}

function syncPlayBtn() {
  ui.play.classList.toggle('playing', playing);
  ui.play.setAttribute('aria-pressed', String(playing));
}

/* Synchronous, all of it, on purpose: this runs inside the click handler,
   and on iOS the gesture task is the only place a context reliably accepts
   a resume. The old code awaited its way out of the gesture first. */
function start() {
  if (playing) return;
  const s = ensureSession();
  if (!s) return;

  playing = true;
  statusMsg = '';
  syncPlayBtn();

  counters.clear();
  gridCyc = cycleSec();
  anchor = s.ctx.currentTime + startLead(s.ctx);

  startClock();
  schedule();
}

function stop() {
  if (!playing) return;
  hardStop();
}

function hardStop() {
  playing = false;
  statusMsg = '';
  if (timer) { clearInterval(timer); timer = null; }
  counters.clear();
  syncPlayBtn();
}

function toggle() { playing ? stop() : start(); }

function audibleSet() {
  const anySolo = state.voices.some((v) => v.solo);
  return (v) => !v.muted && (!anySolo || v.solo);
}

function audible() { return state.voices.filter(audibleSet()); }

/* ---------- the mixer ---------- */
/* One persistent gain per voice. Persistent is the point: a hit is then a
   single buffer source asking for unity gain, and moving a level slider is
   heard on notes that were already booked into the look-ahead. */
function channelFor(v) {
  let ch = session.chans.get(v.id);
  if (!ch) {
    ch = session.ctx.createGain();
    ch.gain.value = v.level;      // set, not ramped: a new voice must not fade in
    ch.connect(session.mix);
    session.chans.set(v.id, ch);
  }
  return ch;
}

function syncChannels() {
  if (!session) return;
  const ctx = session.ctx;
  const now = ctx.currentTime;
  const live = new Set(state.voices.map((v) => v.id));

  for (const [id, ch] of [...session.chans]) {
    if (live.has(id)) continue;
    session.chans.delete(id);
    // hits already inside the look-ahead still play through it
    ch.gain.setTargetAtTime(0, now, 0.05);
    setTimeout(() => { try { ch.disconnect(); } catch (e) {} }, 1000);
  }

  for (const v of state.voices) {
    const ch = channelFor(v);
    if (Math.abs(ch.gain.value - v.level) > 1e-4) ch.gain.setTargetAtTime(v.level, now, 0.01);
  }

  /* Equal-power mixdown: divide the bus by sqrt(sum of levels squared)
     across the audible voices, so summed loudness stays put as voices come
     and go. */
  const on = audible();
  let p = 0;
  for (const v of on) p += v.level * v.level;
  session.mix.gain.setTargetAtTime(p > 0 ? 1 / Math.sqrt(p) : 1, now, 0.02);
}

/* ---------- the grid ---------- */
const phaseAt = (t) => (((t - anchor) % gridCyc) + gridCyc) % gridCyc / gridCyc;

/* Put every counter on the first pulse at or after `from`, without moving
   the grid. Called whenever the arrangement changes: voices stay locked to
   the same cycle, which is the whole invariant this app is about. */
function rebase(from) {
  for (const v of state.voices) {
    const c = counterFor(v);
    c.k = Math.max(0, Math.ceil((from - anchor) / (gridCyc / v.pulses)));
  }
}

/* A tempo change keeps the playhead exactly where it is and only changes
   how fast it moves from here — the grid is re-anchored to preserve the
   current phase rather than restarted. */
function retempo() {
  const cyc = cycleSec();
  if (!playing || !session) { gridCyc = cyc; return; }
  const t = session.ctx.currentTime;
  const ph = phaseAt(t);
  anchor = t - ph * cyc;
  gridCyc = cyc;
  rebase(t + startLead(session.ctx));
}

/* Edits to the arrangement: re-point the mixer and re-derive the counters
   from the present, leaving the grid — and so the phase — alone. */
function syncAudio() {
  if (!session) return;
  for (const id of [...counters.keys()]) {
    if (!state.voices.some((v) => v.id === id)) counters.delete(id);
  }
  syncChannels();
  if (playing) rebase(session.ctx.currentTime + startLead(session.ctx));
}

/* ---------- the scheduler ---------- */
function schedule() {
  if (!playing || !session) return;
  const ctx = session.ctx;
  const now = ctx.currentTime;

  /* The floor, and the reason this app went quiet on a phone: never book a
     hit closer than the engine's render-ahead. Anything nearer has already
     been rendered as silence by the time it is asked for. */
  const floor = now + startLead(ctx);
  const horizon = now + AHEAD;
  const on = audibleSet();

  for (const v of state.voices) {
    const c = counterFor(v);
    const step = gridCyc / v.pulses;

    /* Starved — a throttled timer, a long stall, a resume from suspend.
       Skip the missed pulses with modular arithmetic instead of firing
       them late: the voice lands back on its own grid, in phase, in O(1)
       however far behind it is. */
    if (anchor + c.k * step < floor) c.k = Math.ceil((floor - anchor) / step);

    /* Muted voices keep counting and simply emit nothing, so unmuting
       drops them back exactly where they would have been. */
    const emit = on(v);
    let guard = 0;
    while (anchor + c.k * step < horizon && guard++ < 64) {
      const t = anchor + c.k * step;
      if (emit && t > c.last) {
        playVoice(ctx, channelFor(v), t, v.sound,
          c.k % v.pulses === 0 ? 'accent' : 'normal', 1, v.pitch);
        c.last = t;
      }
      c.k += 1;
    }
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
  /* The cycle the SCHEDULER is using, not the one the slider says: while a
     tempo change is settling those differ for one look-ahead window, and
     drawing the new one would slide the playhead off the hits that are
     already booked. */
  const cyc = playing && gridCyc ? gridCyc : cycleSec();
  /* What is being HEARD right now, which is not what has been rendered:
     ctx.currentTime is how far the engine has got, and the sound of it
     leaves the speaker a device latency later. Subtracting it is what
     makes the playhead touch a dot at the instant that dot is audible —
     the promise this app is built on. */
  const t = session
    ? session.ctx.currentTime - (session.ctx.outputLatency || session.ctx.baseLatency || 0)
    : 0;

  /* Rings grow from the centre outwards; the first voice owns the outer
     ring, so the voice you added first is the one you read first. */
  const ringGap = n > 1 ? (outerR * 0.62) / (n - 1) : 0;
  const innerR = outerR * 0.38;

  /* Playhead phase 0..1 — 0 at 12 o'clock, sweeping clockwise. Measured
     from the scheduler's own anchor: phase off the raw clock (t % cyc) is
     phase relative to whenever the audio context happened to be created,
     which is not where the hits are. */
  const phase = playing && session ? phaseAt(t) : -1;

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
  lvl.addEventListener('input', () => {
    v.level = Number(lvl.value);
    lvlLabel();
    syncAudio();     // persistent bus: the move is heard on notes already booked
    save(state);
  });
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
  syncAudio();
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
    retempo();
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
    retempo();
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
  /* The status line used to be rewritten every animation frame, which meant
     'audio lost — tap play' was on screen for about sixteen milliseconds.
     A real message now stands until the transport state changes. */
  if (!statusMsg && ui.status) {
    const s = playing ? 'playing' : 'stopped';
    if (ui.status.textContent !== s) ui.status.textContent = s;
  }
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

/* A read-only window onto the engine, the same handle the metronome and the
   trainer carry — `__poly.audio` is the session layer's ring buffer, which is
   how a dropout on someone else's phone gets read back rather than guessed
   at, and `grid` is what the scheduler currently believes about time. */
window.__poly = {
  get running() { return playing; },
  get ctxState() { return session ? session.ctx.state : null; },
  get ctxTime() { return session ? session.ctx.currentTime : null; },
  get voices() { return voiceLoad(session && session.ctx); },
  get clock() { return clockNode ? 'worklet' : 'timer'; },
  get grid() {
    return {
      anchor, cycle: gridCyc,
      phase: session && playing ? phaseAt(session.ctx.currentTime) : null,
      booked: [...counters].map(([id, c]) => ({ id, k: c.k, last: c.last })),
    };
  },
  get audio() { return debugState(); },
};

init();
/* ============================================================
   audio-check.js — what the graph renders vs what you can hear

   The dropout this exists for is invisible from inside the app: the
   context runs, the clock advances, the scheduler schedules, the
   animation is perfect, and there is no sound. Every one of those is
   something the app can already check, and all of them say "fine".

   The one thing the app never measures is the SIGNAL. So this page taps
   the graph with an AnalyserNode and reports the peak the engine actually
   rendered, then asks whether you heard it. Those two answers together
   are the whole diagnosis:

     signal, and you heard it        -> the audio path works
     signal, and you heard nothing   -> the phone is silencing us; the
                                        graph is not the problem
     no signal                       -> the context or the graph is dead,
                                        and the numbers below say which
   ============================================================ */
import { createContext, attach, ping, debugState, claimPlayback } from './audio-session.js';
import { prepare, playVoice } from './voices.js';

const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), logEl = $('log'), verdictEl = $('verdictBox');

let ctx = null;
let analyser = null;
let peak = 0;            // highest sample seen while a test was running
let measuring = false;
let lastMeasuredPeak = null;

const facts = new Map();
function fact(k, v, cls) { facts.set(k, { v, cls }); render(); }

function render() {
  rowsEl.textContent = '';
  for (const [k, { v, cls }] of facts) {
    const row = document.createElement('div');
    row.className = 'row';
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('span'); b.textContent = String(v);
    if (cls) b.classList.add(cls);
    row.append(a, b);
    rowsEl.append(row);
  }
  logEl.textContent = debugState().log
    .map((e) => e.at + 'ms  ' + e.kind + '  ' + (e.detail === undefined ? '' : e.detail))
    .join('\n') || '—';
}

function verdict(html, cls) {
  verdictEl.hidden = false;
  verdictEl.textContent = html;
  verdictEl.classList.remove('v-good', 'v-bad', 'v-warn');
  if (cls) verdictEl.classList.add(cls);
}

/* ---------- the environment, before anything is built ---------- */
function reportEnv() {
  const s = navigator.audioSession;
  fact('user agent', navigator.userAgent.slice(0, 64));
  fact('audioSession API', s ? 'yes' : 'not available — silent element used instead',
       s ? 'v-good' : 'v-warn');
  if (s) fact('session type', s.type, s.type === 'playback' ? 'v-good' : 'v-warn');
  fact('AudioWorklet', (typeof AudioWorkletNode !== 'undefined') ? 'yes' : 'no');
  fact('OfflineAudioContext', (typeof OfflineAudioContext !== 'undefined') ? 'yes' : 'no');
}

/* ---------- one context, tapped so we can see the signal ---------- */
function ensure() {
  if (ctx) { ping(ctx); return ctx; }
  ctx = createContext();
  if (!ctx) { verdict('This browser has no Web Audio at all.', 'v-bad'); return null; }

  /* Everything under test goes through the analyser and then on to the
     speaker, so what we measure is exactly what is sent out. */
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(ctx.destination);

  attach(ctx, { isActive: () => measuring, onLost: (r) => fact('context lost', r, 'v-bad') });
  ping(ctx);
  prepare(ctx);
  return ctx;
}

function reportCtx() {
  if (!ctx) return;
  const s = navigator.audioSession;
  if (s) fact('session type', s.type, s.type === 'playback' ? 'v-good' : 'v-warn');
  fact('context state', ctx.state, ctx.state === 'running' ? 'v-good' : 'v-bad');
  fact('sample rate', ctx.sampleRate + ' Hz');
  fact('base latency', ctx.baseLatency != null ? (ctx.baseLatency * 1000).toFixed(1) + ' ms' : 'unknown');
  fact('output latency', ctx.outputLatency != null ? (ctx.outputLatency * 1000).toFixed(1) + ' ms' : 'unknown');
}

/* Watch the rendered signal for `ms`, remembering the loudest sample. */
function measure(ms) {
  peak = 0;
  measuring = true;
  const data = new Float32Array(analyser.fftSize);
  const t0 = performance.now();
  const clockStart = ctx.currentTime;

  /* Sampled on a timer rather than on animation frames: a page that is not
     being painted still has to be measurable, and the whole point here is
     to separate what the engine renders from what the screen is doing. */
  return new Promise((done) => {
    const look = () => {
      analyser.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (performance.now() - t0 < ms) return;
      clearInterval(h);
      measuring = false;
      const moved = ctx.currentTime - clockStart;
      fact('clock advanced', moved.toFixed(3) + ' s in ' + (ms / 1000).toFixed(1) + ' s',
           moved > ms / 1000 * 0.8 ? 'v-good' : 'v-bad');
      lastMeasuredPeak = peak;
      fact('signal rendered', peak.toFixed(4) + (peak > 0.01 ? '  (full)' : '  (silence)'),
           peak > 0.01 ? 'v-good' : 'v-bad');
      done(peak);
    };
    const h = setInterval(look, 16);
  });
}

/* ---------- step 1: a plain loud tone ---------- */
$('toneBtn').addEventListener('click', async () => {
  claimPlayback();
  if (!ensure()) return;
  reportCtx();
  $('statusPos').textContent = 'playing tone…';

  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = 440;
  /* ramped, not switched: a hard edge on a phone speaker is a click, and
     a click is the one thing this test must not be confused by */
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
  g.gain.setValueAtTime(0.35, ctx.currentTime + 1.9);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.0);
  o.connect(g); g.connect(analyser);
  o.start();
  o.stop(ctx.currentTime + 2.05);

  await measure(2100);
  try { g.disconnect(); } catch (e) {}
  $('statusPos').textContent = 'tone finished';
  $('ask').hidden = false;
});

/* ---------- step 2: the real hit path ---------- */
$('clickBtn').addEventListener('click', async () => {
  claimPlayback();
  if (!ensure()) return;
  reportCtx();
  $('statusPos').textContent = 'playing clicks…';

  await prepare(ctx);
  const t0 = ctx.currentTime + 0.1;
  for (let i = 0; i < 8; i++) {
    playVoice(ctx, analyser, t0 + i * 0.25, 'click', i % 4 === 0 ? 'accent' : 'normal', 1, 0);
  }
  await measure(2400);
  $('statusPos').textContent = 'clicks finished';
  $('ask').hidden = false;
});

/* ---------- the diagnosis ---------- */
function conclude(heard) {
  const signal = lastMeasuredPeak != null && lastMeasuredPeak > 0.01;
  if (signal && heard) {
    verdict('Audio path works: the engine rendered a full signal and it reached '
          + 'your ears. If an app is still silent, the fault is in that app’s '
          + 'scheduling, not in the audio session.', 'v-good');
  } else if (signal && !heard) {
    verdict('The engine rendered a FULL signal and you heard nothing, so nothing '
          + 'is wrong with the app’s audio graph — the phone is silencing '
          + 'it. Check the Ring/Silent switch and the volume while this page is '
          + 'open, and tell me what the "session type" row above says.', 'v-warn');
  } else {
    verdict('The engine rendered SILENCE — the fault is inside the audio '
          + 'context, not in the phone’s output. The rows above say which '
          + 'part: a state that is not "running", a clock that did not advance, '
          + 'or a context reported lost.', 'v-bad');
  }
  fact('you heard it', heard ? 'yes' : 'no', heard ? 'v-good' : 'v-bad');
}

$('heardYes').addEventListener('click', () => conclude(true));
$('heardNo').addEventListener('click', () => conclude(false));

reportEnv();
render();

window.__poly = {
  get ctxState() { return ctx ? ctx.state : null; },
  get peak() { return lastMeasuredPeak; },
  get audio() { return debugState(); },
};

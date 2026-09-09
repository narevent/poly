/* ============================================================
   Poly Circles — store
   What gets saved, under the localStorage key 'poly.circles.v2':

     { bpm: <number>, voices: [voice, ...] }

   `bpm` is the rate of the SLOWEST voice in cycles per minute, not
   the fastest — so 45 bpm means the big shape turns once every
   4/3 seconds, and a 3:5 pair reads as calm breathing, not a blur.

   A voice is:
     { id, pulses, sound, level, muted, solo, color }
   `pulses` is how many evenly-spaced beats that voice hits per
   cycle; drawn, that count IS the shape — 3 is a triangle, 5 a
   pentagon.
   ============================================================ */
import { VOICES } from '../../shared/voices.js';

/* ---------- constants ---------- */
export const MAX_VOICES = 6;
export const MAX_PULSES = 12;
export const MIN_BPM = 8, MAX_BPM = 120;

/* Voice colours, as raw hex (a <canvas> cannot paint 'var(--x)'). */
export const VOICE_COLORS = [
  '#ffab6b', /* amber  — the circles app hue, first voice wears it */
  '#9b8cff', /* violet — the trainer hue                          */
  '#6ea8ff', /* blue   — the metronome hue                        */
  '#57c98a', /* green                                            */
  '#e6c465', /* gold                                             */
  '#e07a7a', /* rose                                             */
];

export const SOUNDS = new Set(VOICES.map(v => v.id));

/* ---------- presets ----------
   Each is a list of pulse counts; the app builds voices from it.
   Labels read as the ratio, e.g. "3 : 5". */
export const PRESETS = [
  { name: '2 : 3', pulses: [2, 3] },
  { name: '3 : 4', pulses: [3, 4] },
  { name: '3 : 5', pulses: [3, 5] },
  { name: '4 : 5', pulses: [4, 5] },
  { name: '5 : 7', pulses: [5, 7] },
  { name: '3 : 4 : 5', pulses: [3, 4, 5] },
  { name: '2 : 3 : 4', pulses: [2, 3, 4] },
];

/* ---------- voice ---------- */
export function makeVoice(pulses, over = {}) {
  return {
    id: over.id ?? uid(),
    pulses: clampPulses(pulses),
    sound: over.sound ?? 'click',
    level: over.level ?? 0.8,
    /* semitones, −12…+12; 0 = the sample's own pitch. Lets overlapping
       voices be told apart by ear, not just by ring position. */
    pitch: clampPitch(over.pitch ?? 0),
    muted: over.muted ?? false,
    solo: over.solo ?? false,
    color: over.color ?? VOICE_COLORS[colorIndexFor(pulses)],
  };
}

function colorIndexFor(pulses) {
  /* same pulse count keeps its colour across edits and reloads */
  return ((pulses - 1) % VOICE_COLORS.length + VOICE_COLORS.length) % VOICE_COLORS.length;
}

export function clampPitch(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.min(12, Math.max(-12, v));
}
const colorIndex = colorIndexFor;
export { colorIndex };

/* ---------- defaults ---------- */
/* 3 against 5 — the pair the hub card shows. */
export function defaultState() {
  return {
    bpm: 45,
    voices: [
      makeVoice(3, { color: VOICE_COLORS[0] }),
      makeVoice(5, { color: VOICE_COLORS[1] }),
    ],
  };
}

/* ---------- persistence ---------- */
const KEY = 'poly.circles.v3';   /* v3 adds per-voice pitch */

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { /* private mode / quota: run without memory */ }
}

/* Shallow-validated load: numbers coerced and clamped, ids kept so a
   voice keeps its colour and its audio phase across edits, anything
   unreadable falling back to defaults. */
export function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { raw = {}; }
  if (typeof raw !== 'object' || !raw) raw = {};

  const d = defaultState();
  const st = {
    bpm: clampInt(raw.bpm, MIN_BPM, MAX_BPM, d.bpm),
    voices: [],
  };

  const list = Array.isArray(raw.voices) ? raw.voices : [];
  for (const v of list.slice(0, MAX_VOICES)) {
    if (!v || typeof v !== 'object') continue;
    const pulses = clampInt(v.pulses, 1, MAX_PULSES, 0);
    if (!pulses) continue;
    st.voices.push(makeVoice(pulses, {
      id: typeof v.id === 'string' && v.id ? v.id : undefined,
      sound: SOUNDS.has(v.sound) ? v.sound : 'click',
      level: clamp(v.level, 0, 1, 0.8),
      pitch: clampPitch(v.pitch),
      muted: !!v.muted,
      solo: !!v.solo,
      color: typeof v.color === 'string' && v.color ? v.color : undefined,
    }));
  }
  if (!st.voices.length) st.voices = d.voices;
  return st;
}

/* ---------- helpers ---------- */
let uidCounter = 0;
function uid() {
  uidCounter += 1;
  return 'vc' + Date.now().toString(36) + uidCounter.toString(36);
}

export function clampPulses(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_PULSES, Math.max(1, v));
}

function clamp(x, lo, hi, fb) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(x, lo, hi, fb) {
  const n = Math.round(Number(x));
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
}

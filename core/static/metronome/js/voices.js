/* ============================================================
   voices.js — the metronome's sound presets
   Five voices, each built from oscillators + filtered noise so
   the articulations differ in TIMBRE, not only in level:
   an accent is brighter and longer, a ghost is duller and shorter.

   A voice is a pure scheduling function:
       play(ctx, dest, time, art, opts)
   Everything is scheduled against `time` on the audio clock —
   no node is ever started "now", so the engine stays sample
   accurate. Nodes are one-shot and garbage collect themselves
   once they have stopped.
   ============================================================ */

/* One second of white noise, built once per AudioContext and reused by
   every transient. Building it per hit would allocate on the audio path. */
const _noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let buf = _noiseCache.get(ctx);
  if (!buf) {
    const n = Math.ceil(ctx.sampleRate);
    buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    _noiseCache.set(ctx, buf);
  }
  return buf;
}

/* A noise burst starting at `time`, read from a random offset so repeated
   hits never phase-lock into an audible pitch. */
function noise(ctx, time, dur) {
  const src = ctx.createBufferSource();
  const buf = noiseBuffer(ctx);
  src.buffer = buf;
  src.loop = true;
  const start = Math.random() * (buf.duration - dur - 0.01);
  src.start(time, Math.max(0, start), dur + 0.02);
  src.stop(time + dur + 0.02);
  return src;
}

function osc(ctx, type, freq, time, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, time);
  o.start(time);
  o.stop(time + dur + 0.02);
  return o;
}

function filter(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (q != null) f.Q.value = q;
  return f;
}

/* Percussive envelope: near-instant attack, exponential decay.
   Exponential ramps can never reach 0, so we floor at -80 dB and then
   snap to silence — that removes the tail click a plain ramp leaves. */
const FLOOR = 0.0001;
function env(ctx, time, peak, attack, decay) {
  const g = ctx.createGain();
  const p = g.gain;
  const top = Math.max(peak, FLOOR * 2);
  p.setValueAtTime(FLOOR, time);
  p.exponentialRampToValueAtTime(top, time + attack);
  p.exponentialRampToValueAtTime(FLOOR, time + attack + decay);
  p.setValueAtTime(0, time + attack + decay + 0.001);
  return g;
}

const semis = n => Math.pow(2, (n || 0) / 12);

/* ------------------------------------------------------------
   The voices.
   Each has a per-articulation parameter table. `cross` is kept as
   an alias of `normal` so older saved patterns still make a sound.
   ------------------------------------------------------------ */

/* Click — the hard studio metronome tick. A short square blip with a
   noise transient on top; the accent jumps an octave and gets brighter.
   Cuts through a loud room, and stays legible at 32nd-note speeds. */
function click(ctx, dest, time, a, tone) {
  const P = {
    accent: { f: 2000, gain: 0.55, dec: 0.028, tick: 0.30, hp: 5000 },
    normal: { f: 1400, gain: 0.36, dec: 0.024, tick: 0.17, hp: 4000 },
    ghost:  { f: 1400, gain: 0.12, dec: 0.016, tick: 0.06, hp: 3000 },
  }[a];
  const f = P.f * tone;

  const body = env(ctx, time, P.gain, 0.0006, P.dec);
  const lp = filter(ctx, 'lowpass', Math.min(f * 3.2, 17000), 0.9);
  osc(ctx, 'square', f, time, P.dec).connect(lp);
  lp.connect(body); body.connect(dest);

  const tickG = env(ctx, time, P.tick, 0.0004, 0.005);
  const hp = filter(ctx, 'highpass', P.hp, 0.7);
  noise(ctx, time, 0.006).connect(hp);
  hp.connect(tickG); tickG.connect(dest);
}

/* Wood — clave / rim. A pitched resonant body around 2.5 kHz with a
   dry noise attack. Warmer than Click and easy to hear underneath a
   busier layer, which makes it a good "downbeat" voice. */
function wood(ctx, dest, time, a, tone) {
  const P = {
    accent: { f: 2500, gain: 0.50, dec: 0.075, hit: 0.30 },
    normal: { f: 2050, gain: 0.34, dec: 0.058, hit: 0.18 },
    ghost:  { f: 2050, gain: 0.12, dec: 0.034, hit: 0.06 },
  }[a];
  const f = P.f * tone;

  // body: fundamental plus an inharmonic partial — that ratio is what
  // reads as "struck wood" rather than "sine beep"
  const body = env(ctx, time, P.gain, 0.001, P.dec);
  const o1 = osc(ctx, 'sine', f, time, P.dec);
  o1.frequency.exponentialRampToValueAtTime(f * 0.86, time + P.dec);
  o1.connect(body);
  const pg = ctx.createGain();
  pg.gain.value = 0.28;
  osc(ctx, 'sine', f * 2.74, time, P.dec * 0.6).connect(pg);
  pg.connect(body);
  body.connect(dest);

  // attack: a narrow band of noise at the body pitch
  const hitG = env(ctx, time, P.hit, 0.0005, 0.012);
  const bp = filter(ctx, 'bandpass', f, 6);
  noise(ctx, time, 0.02).connect(bp);
  bp.connect(hitG); hitG.connect(dest);
}

/* Cowbell — the 808 recipe: two detuned squares (587 / 845 Hz) through a
   band-pass. The long-ish metallic ring makes it the clearest voice for a
   slow cross-rhythm layer, where a short click would get lost. */
function cowbell(ctx, dest, time, a, tone) {
  const P = {
    accent: { gain: 0.40, dec: 0.30, q: 1.1 },
    normal: { gain: 0.26, dec: 0.18, q: 1.3 },
    ghost:  { gain: 0.09, dec: 0.09, q: 1.6 },
  }[a];

  const body = env(ctx, time, P.gain, 0.0008, P.dec);
  const bp = filter(ctx, 'bandpass', 2640 * tone, P.q);
  const lp = filter(ctx, 'lowpass', 6000 * tone, 0.7);
  osc(ctx, 'square', 587 * tone, time, P.dec).connect(bp);
  osc(ctx, 'square', 845 * tone, time, P.dec).connect(bp);
  bp.connect(lp); lp.connect(body); body.connect(dest);
}

/* Beep — a clean sine with a soft attack. No transient, no noise: the
   least fatiguing voice for long practice sessions and for headphones. */
function beep(ctx, dest, time, a, tone) {
  const P = {
    accent: { f: 1760, gain: 0.36, dec: 0.075, atk: 0.0015 },
    normal: { f: 880,  gain: 0.28, dec: 0.065, atk: 0.0020 },
    ghost:  { f: 880,  gain: 0.10, dec: 0.045, atk: 0.0030 },
  }[a];
  const f = P.f * tone;

  const g = env(ctx, time, P.gain, P.atk, P.dec);
  osc(ctx, 'sine', f, time, P.dec + P.atk).connect(g);
  // a touch of second harmonic keeps it from disappearing in a mix
  const h = ctx.createGain();
  h.gain.value = 0.12;
  osc(ctx, 'sine', f * 2, time, P.dec * 0.5).connect(h);
  h.connect(g);
  g.connect(dest);
}

/* Tick — band-passed noise, no pitch at all. Because it has no
   fundamental it never clashes with the music being played over it,
   which is why it survives against a full band. */
function tick(ctx, dest, time, a, tone) {
  const P = {
    accent: { f: 6000, q: 1.1, gain: 0.48, dec: 0.020 },
    normal: { f: 4000, q: 1.4, gain: 0.32, dec: 0.016 },
    ghost:  { f: 3000, q: 1.8, gain: 0.11, dec: 0.010 },
  }[a];

  const g = env(ctx, time, P.gain, 0.0004, P.dec);
  const bp = filter(ctx, 'bandpass', P.f * tone, P.q);
  const hp = filter(ctx, 'highpass', 1200, 0.7);
  noise(ctx, time, P.dec + 0.01).connect(bp);
  bp.connect(hp); hp.connect(g); g.connect(dest);
}

const IMPL = { click, wood, cowbell, beep, tick };

export const VOICES = [
  { id: 'click',   name: 'Click',   desc: 'Hard studio tick — cuts through a loud room' },
  { id: 'wood',    name: 'Wood',    desc: 'Clave / rim — warm, dry, good for downbeats' },
  { id: 'cowbell', name: 'Cowbell', desc: 'Metallic ring — clearest for slow cross-rhythms' },
  { id: 'beep',    name: 'Beep',    desc: 'Clean sine — soft, easy on the ears' },
  { id: 'tick',    name: 'Tick',    desc: 'Filtered noise — no pitch, never clashes' },
];

export const DEFAULT_VOICE = 'click';
const VALID = new Set(VOICES.map(v => v.id));
export const isVoice = id => VALID.has(id);

/* Play one hit. `art` is an articulation name; anything unknown is treated
   as `normal`. `dest` is normally the layer's mixer channel, which already
   carries its volume — `gain` is only for callers that want a one-off trim
   (an audition, say), and at 1 it costs no extra node. */
export function playVoice(ctx, dest, time, voiceId, art, gain = 1, pitchOffset = 0) {
  const impl = IMPL[voiceId] || IMPL[DEFAULT_VOICE];
  const a = (art === 'accent' || art === 'ghost') ? art : 'normal';
  if (gain <= 0.0005) return;

  let out = dest;
  if (gain !== 1) {
    out = ctx.createGain();
    out.gain.value = gain;
    out.connect(dest);
  }
  impl(ctx, out, time, a, semis(pitchOffset));
}

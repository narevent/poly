/* ============================================================
   voices.js — the metronome's sound presets
   Five voices, each built from oscillators + filtered noise so
   the articulations differ in TIMBRE, not only in level:
   an accent is brighter and longer, a ghost is duller and shorter.

   Each voice is a small synth graph — oscillators, filtered noise,
   an envelope. That graph is built ONCE PER SOUND, not once per
   hit: at startup every voice is rendered offline into an
   AudioBuffer, and a hit is then a single AudioBufferSourceNode
   playing that buffer. See "Why hits are samples" below — it is
   the difference between eight live nodes per click and one, and
   on a phone that is the difference between working and not.

   Everything is still scheduled against `time` on the audio clock,
   so the engine stays sample accurate.
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

/* Bell — a struck glass bell. A sine carrier frequency-modulated by an
   inharmonic partner (ratio 1.41, near root 2) gives the shimmering, slightly
   detuned spectrum a real bell has. The modulation index decays much faster
   than the body does, so the strike is bright and the ring that follows is
   nearly pure — which is why it stays musical under a slow cross-rhythm
   where a longer metallic voice would just clang. */
function bell(ctx, dest, time, a, tone) {
  const P = {
    accent: { f: 880, gain: 0.34, dec: 0.50, idx: 8.0, ting: 0.26 },
    normal: { f: 660, gain: 0.24, dec: 0.36, idx: 6.0, ting: 0.16 },
    ghost:  { f: 660, gain: 0.09, dec: 0.16, idx: 4.0, ting: 0.05 },
  }[a];
  const f = P.f * tone;

  // carrier is built by hand rather than via osc(), because its frequency
  // param has to be wired up before it starts
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(f, time);
  const modG = env(ctx, time, f * P.idx, 0.001, P.dec * 0.34);
  osc(ctx, 'sine', f * 1.41, time, P.dec * 0.34).connect(modG);
  modG.connect(carrier.frequency);
  carrier.start(time);
  carrier.stop(time + P.dec + 0.05);

  const body = env(ctx, time, P.gain, 0.002, P.dec);
  const lp = filter(ctx, 'lowpass', Math.min(9000 * tone, 17000), 0.7);
  carrier.connect(body); body.connect(lp); lp.connect(dest);

  // a high partial that dies almost at once — the "ting" of the mallet,
  // before the fundamental settles into its ring
  const ting = env(ctx, time, P.gain * P.ting, 0.0008, P.dec * 0.16);
  osc(ctx, 'sine', f * 3.46, time, P.dec * 0.16).connect(ting);
  ting.connect(dest);
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

const IMPL = { click, wood, bell, beep, tick };

/* ------------------------------------------------------------
   Releasing a hit once it has finished.

   Nothing above disconnects itself, and a node still connected to the
   destination stays reachable, so it can never be collected. Desktop engines
   reclaim finished nodes anyway and hide this completely; mobile ones do not.
   Measured on the trainer at 90 BPM with both pads being tapped: 55 nodes a
   second created, and 3756 of the first 4838 still alive after 88 seconds.
   The graph grows until the audio thread gives up and playback stops dead —
   which is why it took "a certain number of bars", was worse while tapping
   (taps add hits of their own), hit both apps, and never showed on a laptop.

   The fix is structural: every node a hit builds hangs off that hit's own
   `hub` gain, so the whole subgraph is released by disconnecting one node.
   ------------------------------------------------------------ */

/* How long after `time` a hit of each voice can still be sounding: its
   longest decay plus tail, rounded up. Only used to decide when the nodes are
   safe to release, so erring long costs nothing but a little memory. */
const TAIL = { click: 0.15, wood: 0.2, bell: 0.8, beep: 0.2, tick: 0.15 };
const TAIL_MAX = 0.8;

/* One sweeper per AudioContext, on one timer, which stops itself as soon as
   there is nothing left to release — a timer per hit would be 55 a second.

   It watches two clocks. ctx.currentTime is the right one: while the context
   is suspended it does not advance, and those hits genuinely have not played
   yet. But a suspended — or interrupted, or dead — context stops that clock
   for good, and then the queue could never drain and the timer could never
   stop. So a wall-clock deadline with two seconds of slack backs it up: if
   that much real time has gone by, the hit either sounded long ago or the
   context is no longer making sound at all, and either way the nodes belong
   to nobody. */
const sweepers = new WeakMap();
function releaseAfter(ctx, hub, when, action) {
  let s = sweepers.get(ctx);
  if (!s) { s = { queue: [], timer: null }; sweepers.set(ctx, s); }
  const slack = Math.max(0, when - ctx.currentTime) * 1000 + 2000;
  s.queue.push({ hub, when, action, wall: Date.now() + slack });
  if (s.timer !== null) return;
  s.timer = setInterval(() => {
    const now = ctx.currentTime;
    const wall = Date.now();
    // a closed context holds nothing: let the whole queue go and stop
    const dead = ctx.state === 'closed';
    let kept = 0;
    for (const item of s.queue) {
      if (!dead && item.when > now && item.wall > wall) { s.queue[kept++] = item; continue; }
      if (item.action) { try { item.action(); } catch (e) { /* already gone */ } }
      else { try { item.hub.disconnect(); } catch (e) { /* already gone */ } }
    }
    s.queue.length = kept;
    if (!kept) { clearInterval(s.timer); s.timer = null; }
  }, 500);
}

export const VOICES = [
  { id: 'click',   name: 'Click',   desc: 'Hard studio tick — cuts through a loud room' },
  { id: 'wood',    name: 'Wood',    desc: 'Clave / rim — warm, dry, good for downbeats' },
  { id: 'bell',    name: 'Bell',    desc: 'Struck glass — a clear ring for slow cross-rhythms' },
  { id: 'beep',    name: 'Beep',    desc: 'Clean sine — soft, easy on the ears' },
  { id: 'tick',    name: 'Tick',    desc: 'Filtered noise — no pitch, never clashes' },
];

export const DEFAULT_VOICE = 'click';
const VALID = new Set(VOICES.map(v => v.id));

/* Voices that used to exist, mapped to the one that replaced them. Saved
   patterns and trainer settings keep their old id forever, so every read of a
   stored voice goes through resolveVoice() and comes back current. */
const RETIRED = { cowbell: 'bell' };
export const resolveVoice = id => RETIRED[id] || id;
export const isVoice = id => VALID.has(resolveVoice(id));

/* ------------------------------------------------------------
   Why hits are samples

   The five functions above are synth graphs: five to eight nodes each,
   with scheduled envelopes on their gain params. Building one of those
   PER HIT is what used to kill this app on a phone. Measured on the
   trainer at 90 BPM with both pads being tapped: 55 nodes a second, and
   3756 of the first 4838 still alive after 88 seconds. The audio thread
   eventually gives up and playback stops dead — while the animation,
   which runs on a completely different thread, carries on as if nothing
   had happened. It never showed on a laptop, because desktop engines
   reclaim finished nodes eagerly enough to hide it.

   Disconnecting the subgraph after each hit (the previous fix) made
   those nodes collectable, but it did not stop them being built, and it
   left the app depending on how promptly a particular engine collects.
   That is not a guarantee, and audio here needs to be a guarantee.

   So a voice is now rendered once, offline, into an AudioBuffer, and a
   hit is one AudioBufferSourceNode reading it. One node instead of
   eight; no oscillators, no biquads and no parameter automation on the
   audio thread while playing; and a definite end, because a buffer
   source fires `onended` and is disconnected there and then rather than
   waiting for a sweeper to guess. The same five functions do the
   rendering, so there is exactly one description of each sound.

   Pitch comes from playbackRate, which is what a sampler does and costs
   nothing. Level does not: a source node has no gain of its own, so a
   caller that wants anything other than unity gets one gain node back.
   Both apps therefore keep persistent level buses and ask for unity —
   see the trainer's `bus` and the metronome's per-layer channels.
   ------------------------------------------------------------ */

/* Rendered sounds, per context: 'voice|articulation' -> AudioBuffer[].
   Keyed by context because a buffer has to be at that context's sample
   rate, and because a rebuilt context must not reuse the old one's.

   An array rather than one buffer because three of the voices put a
   noise transient on the attack, read from a random offset so repeated
   hits never settle into a texture of their own. Rendering once would
   freeze that into the same burst every time. So each sound is rendered
   a few times and a hit takes one at random — the variation is back, at
   no cost on the audio thread, because picking from an array is free.
   Voices with no noise in them render identically every time, and the
   duplicates are dropped rather than kept and never told apart. */
const rendered = new WeakMap();
const rendering = new WeakMap();
const VARIANTS = 3;

/* Two renders of the same sound, sample for sample. */
function sameBuffer(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const x = a.getChannelData(0), y = b.getChannelData(0);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const OfflineCtx = (typeof OfflineAudioContext !== 'undefined') ? OfflineAudioContext
                 : (typeof webkitOfflineAudioContext !== 'undefined') ? webkitOfflineAudioContext : null;

function renderOne(sampleRate, id, art) {
  const seconds = (TAIL[id] || TAIL_MAX) + 0.02;
  const off = new OfflineCtx(1, Math.ceil(seconds * sampleRate), sampleRate);
  // the voice functions do not care what kind of context they are given
  (IMPL[id] || IMPL[DEFAULT_VOICE])(off, off.destination, 0, art, 1);
  const out = off.startRendering();
  // older WebKit resolves this through oncomplete rather than a promise
  if (out && typeof out.then === 'function') return out;
  return new Promise(res => { off.oncomplete = e => res(e.renderedBuffer); });
}

/* Render every voice and articulation for this context. Cheap — fifteen
   buffers, none longer than 0.8 s — and done once, off the audio path.
   Safe to call repeatedly; the second call gets the first one's promise. */
export function prepare(ctx) {
  if (!ctx || !OfflineCtx) return Promise.resolve(false);
  const started = rendering.get(ctx);
  if (started) return started;

  const store = new Map();
  rendered.set(ctx, store);
  const jobs = [];
  for (const v of VOICES) {
    for (const art of ['accent', 'normal', 'ghost']) {
      const takes = [];
      for (let i = 0; i < VARIANTS; i++) takes.push(renderOne(ctx.sampleRate, v.id, art));
      jobs.push(
        Promise.all(takes)
          .then(bufs => {
            // a voice with no noise in it renders the same every time
            const varied = bufs.filter((b, i) => i === 0 || !sameBuffer(b, bufs[0]));
            store.set(v.id + '|' + art, varied.length ? varied : [bufs[0]]);
          })
          .catch(() => { /* that one voice stays on the live path */ })
      );
    }
  }
  const done = Promise.all(jobs).then(() => true);
  rendering.set(ctx, done);
  return done;
}

/* A ceiling on hits sounding at once. Nothing musical comes near it —
   four layers of 32nds at 240 BPM is about 30 — so reaching it means
   something has gone wrong, and dropping a hit there is much cheaper
   than letting a runaway take the audio thread down with it. */
const MAX_VOICES = 96;
const liveCount = new WeakMap();

function countUp(ctx) {
  const n = (liveCount.get(ctx) || 0) + 1;
  liveCount.set(ctx, n);
  return n;
}
function countDown(ctx) {
  liveCount.set(ctx, Math.max(0, (liveCount.get(ctx) || 1) - 1));
}

/* How many hits are sounding right now — for the __poly handles. */
export function voiceLoad(ctx) { return ctx ? (liveCount.get(ctx) || 0) : 0; }

/* Play one hit. `art` is an articulation name; anything unknown is treated
   as `normal`. `dest` is normally a persistent level bus, which already
   carries the volume — `gain` is only for callers that want a one-off trim,
   and at 1 it costs no extra node at all. */
export function playVoice(ctx, dest, time, voiceId, art, gain = 1, pitchOffset = 0) {
  const id = resolveVoice(voiceId);
  const a = (art === 'accent' || art === 'ghost') ? art : 'normal';
  if (gain <= 0.0005) return;

  const store = rendered.get(ctx);
  const takes = store && store.get(id + '|' + a);
  const buf = takes && (takes.length === 1 ? takes[0] : takes[(Math.random() * takes.length) | 0]);
  if (!buf) {
    // the buffers are still rendering, or this engine has no offline
    // context: fall back to building the graph live, which is what this
    // did for its whole life before
    prepare(ctx);
    playLive(ctx, dest, time, id, a, gain, pitchOffset);
    return;
  }

  if (countUp(ctx) > MAX_VOICES) { countDown(ctx); return; }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const rate = semis(pitchOffset);
  if (rate !== 1) src.playbackRate.value = rate;

  let head = src;
  if (gain !== 1) {
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    head = g;
  }
  head.connect(dest);

  /* A definite end, taken once. onended is the fast path; the sweeper is
     the backstop for when it never fires, which is what a suspended or
     interrupted context does to it. */
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    src.onended = null;
    countDown(ctx);
    try { head.disconnect(); } catch (e) { /* already gone */ }
  };
  src.onended = finish;
  src.start(time);
  releaseAfter(ctx, head, time + buf.duration / rate + 0.05, finish);
}

/* The original path: build the voice's graph for this one hit. Only
   reached before the buffers are ready, or on an engine with no
   OfflineAudioContext. Everything it makes hangs off one `hub` gain, so
   the sweeper can let the whole subgraph go by disconnecting one node. */
function playLive(ctx, dest, time, id, a, gain, pitchOffset) {
  const impl = IMPL[id] || IMPL[DEFAULT_VOICE];
  const hub = ctx.createGain();
  hub.gain.value = gain;
  hub.connect(dest);
  impl(ctx, hub, time, a, semis(pitchOffset));
  releaseAfter(ctx, hub, time + (TAIL[id] || TAIL_MAX));
}

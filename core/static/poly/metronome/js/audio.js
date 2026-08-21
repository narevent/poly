/* ============================================================
   audio.js — sample-accurate poly-metronome engine

   TIMING MODEL
   Every layer is described by an anchor and a beat counter, never by
   an accumulating cursor:

       time of beat k  =  layer._anchor + k * (60 / bpm)

   so a layer's 10000th beat is computed in one multiply from its
   anchor and cannot drift, however long it runs. The anchor is only
   re-based when that layer's tempo changes, and it is re-based to the
   time of the beat that was about to sound — so a tempo change never
   moves a note that was already due.

   PHASE
   All layers share one anchor when playback starts, so they are phase
   locked by construction. Two things used to break that and no longer
   can:
     - a muted layer keeps counting (it just emits nothing), so
       unmuting drops it back in exactly where it would have been;
     - if the scheduler is starved (background tab, a long GC pause)
       the layer fast-forwards through the missed beats with modular
       arithmetic instead of resetting its clock. Phase survives.
   A layer added mid-run joins on the next beat of the shared grid.

   CLOCK
   The look-ahead scheduler is driven by an AudioWorklet that ticks on
   the audio thread (~11 ms), which browsers do not throttle in a
   background tab. setTimeout is the fallback and the bootstrap.

   UI PULSE
   Visual events go into one time-ordered queue drained by a single
   requestAnimationFrame loop. The previous code created a setTimeout
   per scheduled slice — at speed that was ~100 timers/sec competing
   with the scheduler's own timer.

   Two playback modes:
     - free run : start() — the current layers loop forever.
     - sequence : playSequence(items) — a list of { layers, bpm, bars }
                  played back to back on the audio clock.
   ============================================================ */

import { playVoice, DEFAULT_VOICE } from '../../shared/voices.js';

const A = (typeof AudioContext !== 'undefined') ? AudioContext
        : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;

const EPS = 1e-6;

/* Ticks on the audio thread every 512 frames (~10.7 ms at 48 kHz).
   Loaded from a Blob so the app stays a single-directory static site. */
const CLOCK_WORKLET = `
class ClockProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._n = 0; }
  process() {
    this._n += 128;
    if (this._n >= 512) { this._n = 0; this.port.postMessage(0); }
    return true;
  }
}
registerProcessor('metronome-clock', ClockProcessor);
`;

export class MetronomeEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.mix = null;
    this._channels = new Map();   // layer id -> its persistent mixer channel
    this.layers = [];
    this.running = false;
    this._timer = null;
    this._clock = null;      // AudioWorkletNode once it is ready
    this._ahead = 0.140;     // schedule-ahead window (s)
    this._tick = 0.020;      // fallback lookahead interval (s)
    this._globalBpm = 120;

    /* the shared phase grid — a virtual layer at the global tempo that
       every mid-run join is quantised to */
    this._grid = { bpm: null, _anchor: 0, _k: 0, _bpm: 120 };

    this.onTick = null;         // (info) => void  — per-slice UI pulse
    this.onItemChange = null;   // (index) => void — sequence advanced
    this.onSequenceEnd = null;  // () => void      — sequence finished

    /* UI pulse queue, ordered by time */
    this._ticks = [];
    this._raf = 0;

    /* sequence state */
    this._seq = null;
    this._seqIdx = -1;
    this._itemStart = 0;
    this._itemEnd = 0;
    this._seqEnded = false;
    this._seqEndTime = 0;
  }

  ensureCtx() {
    if (!this.ctx) {
      if (!A) throw new Error('Web Audio not supported');
      this.ctx = new A({ latencyHint: 'interactive' });

      /* Mixer: each layer gets a persistent channel gain, all channels feed one
         normalised bus, then the master and a safety limiter.

             voice hits -> channel[layer] -> mix (1/√Σv²) -> master -> limiter

         The bus gain is what stops the metronome getting louder every time a
         layer is added: it is the equal-power mixdown law, so summed power —
         and therefore perceived loudness — stays put as layers come and go.
         The limiter is now only a backstop for coincident downbeats. */
      this.mix = this.ctx.createGain();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.mix.connect(this.master);
      const lim = this.ctx.createDynamicsCompressor();
      lim.threshold.value = -3;
      lim.knee.value = 0;
      lim.ratio.value = 12;
      lim.attack.value = 0.001;
      lim.release.value = 0.08;
      this.master.connect(lim);
      lim.connect(this.ctx.destination);

      this._initClock();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        });
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /* Upgrade the scheduler clock from setTimeout to the audio thread.
     Async and entirely optional — if it fails we keep the timer. */
  _initClock() {
    const ctx = this.ctx;
    if (!ctx.audioWorklet || this._clock) return;
    const url = URL.createObjectURL(new Blob([CLOCK_WORKLET], { type: 'application/javascript' }));
    ctx.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'metronome-clock');
      // it must stay connected to be pulled by the graph, but must not
      // be heard: route it through a muted gain
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      node.port.onmessage = () => { if (this.running) this._schedule(); };
      this._clock = node;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }).catch(() => { URL.revokeObjectURL(url); });
  }

  /* Clone the scheduling-relevant parts so we never mutate UI state mid-loop.
     While free-running we carry each layer's phase across the swap (matched
     by id) so editing a pattern does not restart or re-phase it. A layer we
     have not seen before joins on the next beat of the shared grid. */
  setLayers(layers) {
    const prev = new Map(this.layers.map(l => [l.id, l]));
    const carry = this.running && !this._seq;
    const join = carry ? this._gridJoinTime() : 0;

    this.layers = (layers || []).map(l => {
      const pattern = (l.beatPattern || []).map(b => b.slice());
      const p = carry ? prev.get(l.id) : null;
      return {
        id: l.id,
        enabled: l.enabled !== false,
        bpm: l.bpm != null ? l.bpm : null,
        volume: l.volume,
        pitchOffset: l.pitchOffset,
        sound: l.sound || DEFAULT_VOICE,
        pattern,
        _beat: p && pattern.length ? Math.min(p._beat, pattern.length - 1) : 0,
        _anchor: p ? p._anchor : join,
        _k: p ? p._k : 0,
        _bpm: p ? p._bpm : this._bpmFor(l),
        _chan: null,
      };
    });
    this._syncChannels();
  }

  /* ============================================================
     mixer
     ============================================================ */

  /* Give every current layer a channel, retire the ones that went away, and
     re-balance the bus. Channel gains are ramped rather than set, so moving a
     volume slider during playback does not click — and because the channel is
     persistent, the move is heard on notes that were already scheduled. */
  _syncChannels() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const live = new Set(this.layers.map(l => l.id));

    for (const [id, ch] of [...this._channels]) {
      if (live.has(id)) continue;
      this._channels.delete(id);
      // hits already scheduled inside the look-ahead still play through it,
      // so let it finish before tearing it down
      ch.gain.setTargetAtTime(0, now, 0.05);
      setTimeout(() => { try { ch.disconnect(); } catch (e) { /* already gone */ } }, 1000);
    }

    for (const l of this.layers) {
      const v = l.volume != null ? l.volume : 1;
      let ch = this._channels.get(l.id);
      if (!ch) {
        ch = this.ctx.createGain();
        ch.gain.value = v;          // set, not ramped: a new layer must not fade in
        ch.connect(this.mix);
        this._channels.set(l.id, ch);
      } else {
        ch.gain.setTargetAtTime(v, now, 0.01);
      }
      l._chan = ch;
    }

    this._updateMixGain();
  }

  /* Equal-power mixdown: divide the bus by √(Σ volume²) across the audible
     layers. Two identical layers each land at 1/√2, so the pair sums back to
     the level one layer had on its own — adding a layer redistributes the
     available loudness instead of adding to it. Never boosts (a single quiet
     layer stays quiet); that is the user's volume decision, not ours. */
  _updateMixGain() {
    if (!this.mix) return;
    let power = 0;
    for (const l of this.layers) {
      if (!l.enabled) continue;
      const v = l.volume != null ? l.volume : 1;
      power += v * v;
    }
    const norm = Math.sqrt(power);
    const g = norm > 1 ? 1 / norm : 1;
    this.mix.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  setBpm(bpm) { this._globalBpm = bpm; }

  /* ---- free run ---- */
  start() {
    this.ensureCtx();
    this._syncChannels();   // layers may have been set before the ctx existed
    const t0 = this.ctx.currentTime + 0.08;
    this._seq = null;
    this._seqIdx = -1;
    this._seqEnded = false;
    this._ticks.length = 0;
    this.running = true;
    this._grid = { bpm: null, _anchor: t0, _k: 0, _bpm: this._globalBpm };
    for (const l of this.layers) {
      l._anchor = t0; l._k = 0; l._beat = 0; l._bpm = this._bpmFor(l);
    }
    this._startClock();
    this._startVisual();
  }

  /* ---- sequence ----
     items: [{ layers, bpm, bars, ...anything the caller wants back }] */
  playSequence(items) {
    if (!items || !items.length) return false;
    this.ensureCtx();
    this.stop();
    this._syncChannels();
    this._seq = items;
    this._seqEnded = false;
    this.running = true;
    this._applyItem(0, this.ctx.currentTime + 0.08);
    this._startClock();
    this._startVisual();
    return true;
  }

  stop() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._ticks.length = 0;
    this._seq = null;
    this._seqIdx = -1;
    this._seqEnded = false;
  }

  /* Where the sequence is right now — for progress UI. */
  sequenceProgress() {
    if (!this._seq || !this.ctx || this._seqIdx < 0) return null;
    const item = this._seq[this._seqIdx];
    const dur = this._itemEnd - this._itemStart;
    const frac = dur > EPS
      ? Math.min(1, Math.max(0, (this.ctx.currentTime - this._itemStart) / dur))
      : 0;
    const bars = Math.max(1, item.bars || 1);
    return {
      index: this._seqIdx,
      total: this._seq.length,
      item,
      frac,
      bars,
      bar: Math.min(bars, Math.floor(frac * bars) + 1),
    };
  }

  /* ============================================================
     clock
     ============================================================ */
  _startClock() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    // the worklet drives itself; the timer is only the fallback/bootstrap
    if (this._clock) this._schedule();
    else this._loop();
  }

  _loop() {
    if (!this.running || this._clock) return;
    this._schedule();
    if (this.running && !this._clock) {
      this._timer = setTimeout(() => this._loop(), this._tick * 1000);
    }
  }

  /* ============================================================
     scheduling
     ============================================================ */
  _bpmFor(l) {
    const b = l.bpm != null ? l.bpm : this._globalBpm;
    return Math.max(1, b || 120);
  }

  _beatSec(l) { return 60 / this._bpmFor(l); }

  /* Time of the layer's next unscheduled beat. Derived, never accumulated. */
  _nextTime(l) { return l._anchor + l._k * (60 / l._bpm); }

  /* A tempo change re-bases the anchor onto the beat that is about to
     sound, so that beat keeps its time and only the ones after it move. */
  _syncTempo(l) {
    const bpm = this._bpmFor(l);
    if (Math.abs(bpm - l._bpm) < 1e-9) return;
    l._anchor = this._nextTime(l);
    l._k = 0;
    l._bpm = bpm;
  }

  /* The scheduler was starved (hidden tab, long stall). Skip the beats we
     missed with modular arithmetic instead of resetting the clock: the
     layer stays exactly on its original grid and in phase with the others.
     O(1) however far behind we are. */
  _catchUp(l, ctxNow) {
    const behind = ctxNow - this._nextTime(l);
    if (behind <= 0) return;
    const n = Math.ceil(behind / (60 / l._bpm));
    l._k += n;
    l._beat = ((l._beat + n) % l.pattern.length + l.pattern.length) % l.pattern.length;
  }

  /* Advance the shared grid to the present, same arithmetic. */
  _advanceGrid(ctxNow) {
    const g = this._grid;
    this._syncTempo(g);
    const sec = 60 / g._bpm;
    const behind = ctxNow - this._nextTime(g);
    if (behind > 0) g._k += Math.ceil(behind / sec);
  }

  /* The next grid beat a new layer may join on. */
  _gridJoinTime(lead = 0.05) {
    if (!this.ctx) return 0;
    const g = this._grid;
    this._advanceGrid(this.ctx.currentTime + lead);
    return this._nextTime(g);
  }

  _schedule() {
    if (!this.running || !this.ctx) return;
    const ctxNow = this.ctx.currentTime;
    const horizon = ctxNow + this._ahead;
    if (this._seq) this._scheduleSequence(ctxNow, horizon);
    else this._scheduleFree(ctxNow, horizon);
    // the audio clock is the one driver that cannot be throttled away, so the
    // pulse rides along with it (~11 ms, finer than a 60 Hz frame)
    this._drainTicks();
  }

  _scheduleFree(ctxNow, horizon) {
    this._advanceGrid(ctxNow);
    for (const l of this.layers) {
      if (!l.pattern.length) continue;
      this._syncTempo(l);
      // NB: muted layers are scheduled too — they simply emit nothing.
      // That is what keeps unmuting in phase.
      this._catchUp(l, ctxNow);
      let guard = 0;
      while (this._nextTime(l) < horizon && guard++ < 128) this._emitBeat(l, Infinity);
    }
  }

  _scheduleSequence(ctxNow, horizon) {
    let guard = 0;
    while (this.running && guard++ < 256) {
      if (this._seqEnded) {
        if (ctxNow >= this._seqEndTime) {
          this.stop();
          if (this.onSequenceEnd) this.onSequenceEnd();
        }
        return;
      }

      const end = this._itemEnd;
      const limit = Math.min(horizon, end);
      for (const l of this.layers) {
        if (!l.pattern.length) continue;
        this._syncTempo(l);
        let g = 0;
        while (this._nextTime(l) < limit - EPS && g++ < 256) this._emitBeat(l, end);
      }

      // still inside the current item — nothing more to fill this pass
      if (horizon < end) return;

      // the item is fully scheduled: hand the clock to the next one
      if (this._seqIdx + 1 < this._seq.length) this._applyItem(this._seqIdx + 1, end);
      else { this._seqEnded = true; this._seqEndTime = end; }
    }
  }

  _applyItem(idx, startTime) {
    const item = this._seq[idx];
    this._seqIdx = idx;
    if (item.bpm != null) this._globalBpm = item.bpm;
    this.setLayers(item.layers);
    for (const l of this.layers) {
      l._beat = 0; l._k = 0; l._anchor = startTime; l._bpm = this._bpmFor(l);
    }
    this._grid = { bpm: null, _anchor: startTime, _k: 0, _bpm: this._globalBpm };
    this._itemStart = startTime;
    this._itemEnd = startTime + this._itemDuration(item);

    if (this.onItemChange) {
      const delay = Math.max(0, (startTime - this.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (this.running && this._seq && this._seqIdx === idx) this.onItemChange(idx);
      }, delay);
    }
  }

  /* One item lasts `bars` bars of its master layer (the first enabled one),
     which is what makes parts play in series instead of stepping on each
     other. Layers that do not divide evenly into that span are truncated at
     the boundary, so the next part always starts exactly on time. */
  _itemDuration(item) {
    const layers = item.layers || [];
    const master = layers.find(l => l.enabled !== false) || layers[0];
    if (!master) return 0;
    const bpm = Math.max(1, (master.bpm != null ? master.bpm : item.bpm) || 120);
    const beats = (master.beatPattern || []).length || 4;
    return (60 / bpm) * beats * Math.max(1, item.bars || 1);
  }

  /* Schedule every slice of the layer's current beat, then advance its
     counter by one beat. Slices at or past `hardEnd` are dropped. */
  _emitBeat(l, hardEnd) {
    const t0 = this._nextTime(l);
    const beat = l.pattern[l._beat];
    const beatSec = 60 / l._bpm;

    if (beat && beat.length) {
      const sliceSec = beatSec / beat.length;
      for (let s = 0; s < beat.length; s++) {
        const t = t0 + s * sliceSec;
        if (t >= hardEnd - EPS) break;
        if (!l.enabled) continue;

        const art = beat[s];
        // level lives on the layer's mixer channel now, not on the hit
        if (art && art !== 'silent' && (l.volume == null || l.volume > 0.0005)) {
          playVoice(this.ctx, l._chan || this.mix, t, l.sound, art, 1, l.pitchOffset || 0);
        }
        if (this.onTick) {
          this._pushTick(t, { id: l.id, beat: l._beat, sub: s, time: t, isBeat: s === 0 });
        }
      }
    }

    l._k += 1;
    l._beat = (l._beat + 1) % l.pattern.length;
  }

  /* ============================================================
     UI pulse — one queue, one rAF loop
     ============================================================ */
  _pushTick(time, info) {
    const q = this._ticks;
    // rAF is suspended while the tab is hidden, so nothing drains the queue.
    // Drop what is already too late to be a pulse rather than let it pile up.
    if (q.length > 64) {
      const cutoff = this.ctx.currentTime - 0.25;
      let d = 0;
      while (d < q.length && q[d].t < cutoff) d++;
      if (d) q.splice(0, d);
      if (q.length > 512) return;
    }
    let i = q.length;
    while (i > 0 && q[i - 1].t > time) i--;
    q.splice(i, 0, { t: time, info });
  }

  /* Fire every queued pulse that is now due. Splices what it dispatches, so
     it is safe to call from several drivers — whichever gets there first
     wins and the other finds an empty queue. */
  _drainTicks() {
    const q = this._ticks;
    if (!q.length || !this.ctx) return;
    const now = this.ctx.currentTime;
    let n = 0;
    while (n < q.length && q[n].t <= now) n++;
    if (!n) return;
    const due = q.splice(0, n);
    if (!this.onTick) return;
    // anything badly late is stale, not a pulse — don't fire a burst
    for (const e of due) if (now - e.t < 0.25) this.onTick(e.info);
  }

  /* rAF alone is NOT enough to drive the UI pulse. Browsers throttle and
     suspend it freely — iOS Safari especially, and any browser once the page
     is not the visible compositing target — and when it stops, the metronome
     keeps sounding while the display silently freezes. So the scheduler
     (which runs on the audio thread and is never throttled) drains the queue
     as well; rAF stays purely as the smooth path when it is available. */
  _startVisual() {
    if (this._raf || typeof requestAnimationFrame !== 'function') return;
    const step = () => {
      this._raf = 0;
      if (!this.running) return;
      this._drainTicks();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
}

/* ============================================================
   audio-session.js — keeping a Web Audio context alive on a phone

   THE BUG THIS EXISTS FOR
   Sound worked, and then after a while it did not — on the phone only,
   and once it had gone it stayed gone across a reload and across
   browsers. Three separate iOS behaviours add up to that:

   1. `state` is not just running/suspended. WebKit has a third value,
      `interrupted`, which a phone call, an alarm, a Siri invocation or a
      route change (headphones in or out) drops the context into. Code
      that reads `if (state === 'suspended') resume()` never fires for it,
      so the app keeps scheduling into a context that makes no sound and
      has no idea anything is wrong.

   2. A context that is never closed is never reclaimed. WebKit caps how
      many live AudioContexts a process may hold; past the cap, `new
      AudioContext()` still hands back an object, it just never produces
      sound. Poly is three separate pages — hub, metronome, trainer — so
      every navigation between them minted another context and left the
      old one running. That is the "different browsers" part: on iOS they
      are all WebKit talking to the same media daemon, so once it is
      exhausted a fresh tab inherits the silence.

   3. A context can survive a hardware route change as a corpse: state
      still says `running`, currentTime stops advancing, nothing plays.
      Nothing short of building a new one gets the sound back.

   4. And the one that actually bites a metronome: a phone puts the audio
      route to sleep when nothing is coming out of it. A click track is
      more than ninety per cent silence — a few tens of milliseconds of
      sound every half second — so between hits the graph renders zeroes,
      the platform decides the output is idle and lets the audio unit go,
      and the next hits land on a stream that is no longer awake. The
      context is fine. `state` says `running`, `currentTime` advances, the
      scheduler is scheduling, the animation keeps going — and there is no
      sound, until something wakes the route again, which is why it
      sometimes came back on its own. That is what a keep-alive tone is
      for, below: while a context exists it is never allowed to render
      pure silence.

   WHAT THIS DOES ABOUT IT
   An owner registers its context with attach() and says how to tell
   whether audio is wanted right now (`isActive`) and what to do when the
   context is beyond saving (`onLost`). This module then:

     - resumes on every user gesture and on becoming visible, for ANY
       non-running state, `interrupted` included;
     - watches the clock and declares a context lost when currentTime
       stalls while it is supposed to be playing, or when resume() will
       not take for several seconds running;
     - closes the context when the page is hidden or left with nothing
       playing, so navigating between the three pages releases the audio
       session instead of hoarding it;
     - suspends an idle context after a few seconds, so a page sitting
       stopped in a background tab is not holding the phone's audio
       session open for nothing.

   Closing is always a deliberate, reported event: the owner hears about
   it through onLost and simply builds a new context next time it needs
   one. Nothing here ever closes a context that is actually playing.
   ============================================================ */

const entries = new Map();   // AudioContext -> entry

let wired = false;
let watchdog = null;
let hiddenTimer = null;

/* How long a context may sit unwanted before we let the phone have its
   audio session back. Long enough that pausing to change a setting does
   not tear anything down, short enough that a backgrounded page is not
   holding hardware. */
const IDLE_SUSPEND_MS = 8000;
const HIDDEN_CLOSE_MS = 30000;

/* A stalled audio clock is only believed after this many consecutive
   watchdog passes see it. One pass is not evidence: a phone that is busy,
   throttled or mid-interruption can freeze the clock for a moment and
   come back on its own, and tearing the context down for that is worse
   than the blip it was meant to cure. */
const STALL_STRIKES = 3;

const WATCH_MS = 1000;

/* Resume is asked for at most this often. It is called from every gesture,
   from every state change and from the watchdog, and on a phone that can
   be many times a second — a call per pointer move is not free and does
   not help. */
const RESUME_THROTTLE_MS = 250;

/* The keep-alive: a tone below the bottom of hearing, at about -80 dBFS.
   It exists to be non-zero, not to be heard. 30 Hz is under what a phone
   speaker can even reproduce, and at this level it is inaudible on
   headphones too — but it is enough that the output is never digital
   silence, which is what stops the platform parking the audio route
   between clicks. */
const KEEP_HZ = 30;
const KEEP_GAIN = 0.0001;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* A short ring of what the audio layer has been through, so a dropout on
   someone else's phone can be read back instead of guessed at. See the
   `audio` handle on window.__poly. */
const log = [];
function note(kind, detail) {
  log.push({ at: Math.round(now()), kind, detail });
  if (log.length > 60) log.shift();
}

/* ------------------------------------------------------------
   creating
   ------------------------------------------------------------ */

/* The constructor with the options bag is not universally accepted —
   older WebKit throws on it rather than ignoring it. */
export function createContext(options = { latencyHint: 'interactive' }) {
  const AC = (typeof AudioContext !== 'undefined') ? AudioContext
           : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
  if (!AC) return null;
  try { return new AC(options); } catch (e) { return new AC(); }
}

/* ------------------------------------------------------------
   registering
   ------------------------------------------------------------ */

/* attach(ctx, { isActive, onLost })
     isActive() -> is this context supposed to be making sound right now?
     onLost()   -> the context is gone (closed, or unrecoverable). Drop your
                   reference to it and rebuild on demand.
   Returns a detach function. */
export function attach(ctx, { isActive = () => false, onLost = () => {} } = {}) {
  if (!ctx) return () => {};
  const e = {
    ctx,
    isActive,
    onLost,
    stalls: 0,          // consecutive watchdog passes with a frozen clock
    lastResume: 0,      // when resume() was last asked for
    idleSince: now(),   // when this context last had nothing to do
    clockWall: 0,       // wall time of the last clock sample
    clockAudio: 0,      // ctx.currentTime at that sample
    keep: null,         // the keep-alive tone
  };
  entries.set(ctx, e);
  keepAlive(e);

  /* React to a state change the moment it happens rather than up to a
     watchdog pass later. On an interruption that is the difference
     between a gap you hear and one you do not. */
  ctx.onstatechange = () => {
    note('state', ctx.state);
    if (ctx.state !== 'running' && ctx.state !== 'closed' && e.isActive()) ping(ctx);
  };

  wire();
  note('attach', ctx.sampleRate);
  return () => { entries.delete(ctx); stopKeep(e); };
}

/* Hold an inaudible tone into the destination for as long as the context
   lives, so the graph never renders pure silence. Rebuilt on demand: an
   oscillator can be ended out from under us by an interruption, and a
   keep-alive that has quietly stopped is no keep-alive at all. */
function keepAlive(e) {
  const ctx = e.ctx;
  if (e.keep || ctx.state === 'closed') return;
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = KEEP_HZ;
    g.gain.value = KEEP_GAIN;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.onended = () => { if (e.keep && e.keep.osc === osc) { e.keep = null; keepAlive(e); } };
    osc.start();
    e.keep = { osc, g };
  } catch (err) { note('keep-failed', String(err)); }
}

function stopKeep(e) {
  if (!e.keep) return;
  const { osc, g } = e.keep;
  e.keep = null;
  try { osc.onended = null; osc.stop(); } catch (err) { /* never started */ }
  try { osc.disconnect(); g.disconnect(); } catch (err) { /* already gone */ }
}

/* Nudge a context back to running. Safe to call at any time and from any
   state — crucially including `interrupted`, which is the state iOS uses
   and which the usual `=== 'suspended'` check silently skips. */
export function ping(ctx) {
  const e = entries.get(ctx);
  if (!ctx || ctx.state === 'closed') return;
  const t = now();
  if (ctx.state !== 'running') {
    if (!e || t - e.lastResume > RESUME_THROTTLE_MS) {
      if (e) e.lastResume = t;
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }
  if (e) {
    e.idleSince = t;
    keepAlive(e);   // no-op unless it has gone away
    /* Deliberately does NOT touch the clock sampling. ping() runs on
       every gesture, and in the trainer a gesture is every tap — clearing
       the stall evidence here would switch the detector off for exactly
       the person hitting the pads hardest. Resuming from suspend is
       already covered: that path clears the sample in sweep(). */
  }
}

function pingAll() { for (const ctx of entries.keys()) ping(ctx); }

/* Give the context up. The owner is told, so it can rebuild later. */
function release(e, reason) {
  note('release', reason);
  entries.delete(e.ctx);
  stopKeep(e);
  try { e.ctx.onstatechange = null; } catch (err) { /* closing */ }
  try { e.ctx.close(); } catch (err) { /* already closing */ }
  try { e.onLost(reason); } catch (err) { /* owner's problem, not ours */ }
}

/* ------------------------------------------------------------
   the global wiring — one set of listeners for every context
   ------------------------------------------------------------ */
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;

  /* Any gesture is permission to make sound, and on iOS it is also the
     only moment an interrupted context will accept a resume. Capture and
     passive so this can never interfere with the app's own handlers. */
  for (const type of ['pointerdown', 'touchend', 'mousedown', 'keydown']) {
    document.addEventListener(type, pingAll, { capture: true, passive: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
    if (document.hidden) {
      // a page nobody is looking at, with nothing playing, has no claim on
      // the audio hardware
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        if (!document.hidden) return;
        for (const e of [...entries.values()]) if (!e.isActive()) release(e, 'hidden');
      }, HIDDEN_CLOSE_MS);
    } else {
      pingAll();
    }
  });

  window.addEventListener('pageshow', pingAll);

  /* Leaving the page — including into the back/forward cache, which is how
     moving between Poly's three pages usually goes. Every context goes,
     playing or not: this is the case that was piling them up until WebKit
     stopped handing out working ones, and a page you have navigated away
     from should not still be counting time at you from the trainer.

     Playing in the background is a different event and keeps working —
     that is `visibilitychange`, below, which only closes what is idle. */
  const leave = () => {
    for (const e of [...entries.values()]) release(e, 'pagehide');
  };
  window.addEventListener('pagehide', leave);
  document.addEventListener('freeze', leave);

  watchdog = setInterval(sweep, WATCH_MS);
}

function sweep() {
  for (const e of [...entries.values()]) {
    const ctx = e.ctx;

    if (ctx.state === 'closed') { entries.delete(ctx); try { e.onLost('closed'); } catch (err) {} continue; }

    const active = !!e.isActive();

    if (!active) {
      e.stalls = 0;
      e.clockWall = 0;
      /* Idle and running: hand the audio session back until it is wanted.
         The keep-alive is torn down at exactly this moment and not a
         moment sooner — while the context is merely stopped it keeps
         holding the route awake, so pressing play again is instant.
         Suspending would stop the tone anyway; doing it explicitly is
         what makes it come back cleanly on the next ping. */
      if (ctx.state === 'running') {
        if (now() - e.idleSince > IDLE_SUSPEND_MS) {
          stopKeep(e);
          const p = ctx.suspend();
          if (p && p.catch) p.catch(() => {});
        }
      } else {
        e.idleSince = now();
      }
      continue;
    }

    e.idleSince = now();
    keepAlive(e);   // rebuilds it if an interruption ended the tone

    /* Supposed to be playing but not running — `suspended` after an
       autoplay block, `interrupted` after a call or a route change. Keep
       asking, and keep asking for as long as it takes.

       This used to give up after four seconds and replace the context.
       That was wrong on a phone twice over: an interruption is usually
       temporary and ends by itself or on the next touch, and while one is
       in progress a replacement context is born into the same
       interruption anyway. So there is no giving up here any more —
       resume() is retried, every gesture retries it, and the state change
       that ends the interruption retries it immediately. */
    if (ctx.state !== 'running') {
      ping(ctx);
      e.clockWall = 0;
      continue;
    }

    /* Running, and playing, and yet the audio clock is not moving: the
       context outlived the hardware it was bound to. Only believed after
       several passes in a row — see STALL_STRIKES. */
    const w = now(), a = ctx.currentTime;
    if (e.clockWall) {
      const dw = (w - e.clockWall) / 1000;
      const da = a - e.clockAudio;
      if (dw > 1.2 && da < dw * 0.2) {
        if (++e.stalls >= STALL_STRIKES) { release(e, 'clock-stalled'); continue; }
      } else if (e.stalls) {
        note('stall-cleared', e.stalls);
        e.stalls = 0;
      }
    }
    e.clockWall = w;
    e.clockAudio = a;
  }
}

/* For the console: what the session layer currently believes. */
export function debugState() {
  return {
    contexts: [...entries.values()].map(e => ({
      state: e.ctx.state,
      currentTime: Math.round(e.ctx.currentTime * 1000) / 1000,
      sampleRate: e.ctx.sampleRate,
      active: !!e.isActive(),
      stalls: e.stalls,
      keepAlive: !!e.keep,
    })),
    log: log.slice(),
  };
}

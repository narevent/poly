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

/* A resume() that has not taken after this many watchdog passes means the
   context is not coming back and needs replacing. */
const RESUME_GRACE = 4;

const WATCH_MS = 1000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
  entries.set(ctx, {
    ctx,
    isActive,
    onLost,
    failures: 0,        // consecutive watchdog passes with a refused resume
    idleSince: now(),   // when this context last had nothing to do
    clockWall: 0,       // wall time of the last clock sample
    clockAudio: 0,      // ctx.currentTime at that sample
  });
  wire();
  return () => { entries.delete(ctx); };
}

/* Nudge a context back to running. Safe to call at any time and from any
   state — crucially including `interrupted`, which is the state iOS uses
   and which the usual `=== 'suspended'` check silently skips. */
export function ping(ctx) {
  const e = entries.get(ctx);
  if (!ctx || ctx.state === 'closed') return;
  if (ctx.state !== 'running') {
    const p = ctx.resume();
    if (p && p.catch) p.catch(() => {});
  }
  if (e) { e.idleSince = now(); e.clockWall = 0; }
}

function pingAll() { for (const ctx of entries.keys()) ping(ctx); }

/* Give the context up. The owner is told, so it can rebuild later. */
function release(e, reason) {
  entries.delete(e.ctx);
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
      e.failures = 0;
      e.clockWall = 0;
      // idle and running: hand the audio session back until it is wanted
      if (ctx.state === 'running') {
        if (now() - e.idleSince > IDLE_SUSPEND_MS) {
          const p = ctx.suspend();
          if (p && p.catch) p.catch(() => {});
        }
      } else {
        e.idleSince = now();
      }
      continue;
    }

    e.idleSince = now();

    /* Supposed to be playing but not running — `suspended` after an
       autoplay block, `interrupted` after a call or a route change. Keep
       asking; if it will not come back it is a dead context, not a paused
       one, and the only cure is a new one. */
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
      if (++e.failures >= RESUME_GRACE) release(e, 'stuck-' + ctx.state);
      continue;
    }
    e.failures = 0;

    /* Running, and playing, and yet the audio clock is not moving: the
       context outlived the hardware it was bound to. It will never make a
       sound again however long we wait on it. */
    const w = now(), a = ctx.currentTime;
    if (e.clockWall) {
      const dw = (w - e.clockWall) / 1000;
      const da = a - e.clockAudio;
      if (dw > 1.2 && da < dw * 0.2) { release(e, 'clock-stalled'); continue; }
    }
    e.clockWall = w;
    e.clockAudio = a;
  }
}

/* For the console: what the session layer currently believes. */
export function debugState() {
  return [...entries.values()].map(e => ({
    state: e.ctx.state,
    currentTime: e.ctx.currentTime,
    active: !!e.isActive(),
    failures: e.failures,
  }));
}

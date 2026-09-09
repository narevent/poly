/* The regression this exists for: on a phone the circles scheduler could be
   starved (throttled timers), and it answered by re-anchoring to
   `currentTime + 0.02` — inside the engine's render-ahead, where a hit is
   rendered as silence. Sound stopped; the animation, on another thread and
   another clock, carried on as if nothing had happened.

   So: drive the scheduler by hand, stall the clock hard and repeatedly, and
   assert that every hit is still booked with a real lead AND still lands on
   the shared cycle grid. */
import './circles-stub.cjs';

/* Take every timer callback rather than letting them free-run, so the test
   owns the clock completely. */
const ticks = [];
globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
globalThis.clearInterval = () => {};
const tick = () => { for (const fn of ticks) fn(); };

/* An offline context, so voices.js takes its production path: one buffer
   source per hit, started at exactly the scheduled time. Must exist before
   voices.js is imported — it captures the constructor at module scope. */
const RealAC = globalThis.AudioContext;
globalThis.OfflineAudioContext = function (ch, len, rate) {
  const o = new RealAC();
  o.length = len;
  o.sampleRate = rate;
  o.startRendering = () => Promise.resolve({
    length: len, sampleRate: rate, duration: len / rate,
    numberOfChannels: 1, getChannelData: () => new Float32Array(len),
  });
  return o;
};

/* record every hit as (booked-for time, clock when it was booked) */
const starts = [];
globalThis.AudioContext = function (...a) {
  const ctx = new RealAC(...a);
  const make = ctx.createBufferSource.bind(ctx);
  ctx.createBufferSource = (...args) => {
    const n = make(...args);
    const s = n.start.bind(n);
    n.start = (t) => { starts.push({ t, at: ctx.currentTime }); return s(t); };
    return n;
  };
  globalThis.__appCtx = ctx;   /* the app's own context — NOT __audioCtx, which
                                  the offline renders overwrite */
  return ctx;
};

await import('../core/static/poly/circles/js/circles.js');

/* A dense grid, so a stall landing inside the render-ahead is likely rather
   than a one-in-twenty fluke: at 120 bpm the 5-voice pulses are 100 ms
   apart, and a fifth of all possible stall phases put the next pulse inside
   the lead. That is the case the old scheduler silently swallowed. */
const bpm = document.getElementById('bpmSlider');
bpm.value = '120';
bpm.fire('input');

document.getElementById('playBtn').click();
const ctx = globalThis.__appCtx;
if (!ctx) { console.error('FAIL: play built no audio context'); process.exit(1); }

/* let prepare() settle so hits take the buffer path, then measure */
await new Promise((r) => setTimeout(r, 20));
starts.length = 0;

const LEAD = 0.020;              // startLead()'s floor for a running context
const CYC = 60 / 120;            // the tempo set above, one cycle
const STEPS = [CYC / 3, CYC / 5];
const ANCHOR = LEAD;             // stub clock starts at 0, so anchor = lead

/* `run` is the timer behaving; `stall` is the phone throttling it away for
   a while and then letting one callback through. The old scheduler survived
   `run` and went permanently silent on `stall`. */
const run = (secs) => {
  for (let i = 0; i < Math.round(secs / 0.025); i++) { ctx.currentTime += 0.025; tick(); }
};
const stall = (secs) => { ctx.currentTime += secs; tick(); };

run(2);
/* stall lengths chosen to walk the phase of the grid, so the pulse after a
   stall lands everywhere including inside the render-ahead */
for (let i = 0; i < 40; i++) { stall(0.317 + i * 0.041); run(0.3); }
stall(30.0);
run(2);

let late = 0, offGrid = 0;
for (const s of starts) {
  if (s.t - s.at < LEAD - 1e-9) late++;
  const onGrid = STEPS.some((st) => {
    const r = Math.abs((s.t - ANCHOR) / st) % 1;
    return Math.min(r, 1 - r) < 1e-6;
  });
  if (!onGrid) offGrid++;
}

const afterStall = starts.filter((s) => s.at > 5).length;
console.log('hits booked        :', starts.length);
console.log('inside render-ahead:', late, '(must be 0)');
console.log('off the cycle grid :', offGrid, '(must be 0)');
console.log('booked after stalls:', afterStall, '(must be > 0)');

const ok = starts.length > 0 && late === 0 && offGrid === 0 && afterStall > 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

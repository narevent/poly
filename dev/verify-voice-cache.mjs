/* voices.js used to key its rendered buffers by CONTEXT, so every rebuilt
   context and every navigation between Poly's pages re-rendered the whole
   set: 45 OfflineAudioContexts, constructed all at once. audio-session.js's
   own header explains why that is fatal on a phone — WebKit caps how many
   audio contexts a process may hold, and past the cap a context is handed
   back as an object that never makes a sound.

   So: rendered once per SAMPLE RATE, and never more than a few offline
   contexts alive at a time. */
import './circles-stub.cjs';

const RealAC = globalThis.AudioContext;

let built = 0;      // offline contexts ever constructed
let alive = 0;      // ...and how many at once
let peakAlive = 0;
globalThis.OfflineAudioContext = function (ch, len, rate) {
  built++; alive++;
  peakAlive = Math.max(peakAlive, alive);
  const o = new RealAC();
  o.length = len;
  o.sampleRate = rate;
  o.startRendering = () => new Promise((res) => setTimeout(() => {
    alive--;
    res({ length: len, sampleRate: rate, duration: len / rate,
          numberOfChannels: 1, getChannelData: () => new Float32Array(len) });
  }, 0));
  return o;
};

const { prepare, playVoice } = await import('../core/static/poly/shared/voices.js');

const at = (rate) => { const c = new RealAC(); c.sampleRate = rate; return c; };

/* first page: one context at 48k */
const a = at(48000);
await prepare(a);
const afterFirst = built;

/* the context is rebuilt, and the user visits the other three pages — four
   more contexts, same hardware, same rate */
for (const c of [at(48000), at(48000), at(48000), at(48000)]) await prepare(c);
const afterSameRate = built;

/* a genuinely different rate does have to be rendered */
await prepare(at(44100));
const afterNewRate = built;

/* a buffer rendered for one context must play on another at the same rate */
let usedBuffer = false;
const b = at(48000);
b.createBufferSource = () => { usedBuffer = true; return { connect(){}, disconnect(){}, start(){}, stop(){}, onended:null, playbackRate:{value:1}, buffer:null }; };
playVoice(b, {}, 0.5, 'click', 'normal', 1, 0);

const VOICES = 5, ARTS = 3, VARIANTS = 3;
const expected = VOICES * ARTS * VARIANTS;

console.log('offline contexts for the first prepare :', afterFirst, '(expected', expected + ')');
console.log('after four more contexts at 48 kHz     :', afterSameRate, '(must not grow)');
console.log('after one at 44.1 kHz                  :', afterNewRate, '(expected', expected * 2 + ')');
console.log('most alive at any one moment           :', peakAlive, '(must be <= 3)');
console.log('a fresh context reuses the buffers     :', usedBuffer);

const ok = afterFirst === expected
        && afterSameRate === afterFirst
        && afterNewRate === expected * 2
        && peakAlive <= 3
        && usedBuffer;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

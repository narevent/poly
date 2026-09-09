// Minimal DOM + Canvas2D stub so circles.js can run headlessly in Node.
// Purpose: surface the real runtime error the browser sees, in a readable stack.
const listeners = new Map();

function makeCtx2d(canvasEl) {
  const store = { lineWidth: 1, strokeStyle: '', fillStyle: '', globalAlpha: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic' };
  const ops = [];
  const rec = (name) => (...a) => { ops.push([name, ...a]); };
  const ctx = {
    setTransform: rec('setTransform'), clearRect: rec('clearRect'), beginPath: rec('beginPath'), arc: rec('arc'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'),
    stroke: rec('stroke'), fill: rec('fill'), fillText: rec('fillText'),
    save: rec('save'), restore: rec('restore'),
  };
  for (const k of ['lineWidth','strokeStyle','fillStyle','globalAlpha','font','textAlign','textBaseline']) {
    Object.defineProperty(ctx, k, {
      get: () => store[k],
      set: (v) => { store[k] = v; ops.push(['set:' + k, v]); },
      configurable: true,
      enumerable: true,
    });
  }
  ctx.canvas = canvasEl;
  ctx.ops = ops;
  return ctx;
}

class El {
  constructor(id, tag) {
    this.id = id; this.tagName = (tag || 'div').toUpperCase();
    this.style = {}; this.dataset = {}; this.children = [];
    this._ctx = makeCtx2d(this);
    this._rect = { width: 640, height: 640, x: 0, y: 0 };
    this.disabled = false; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this._cls = new Set();
  }
  get classList() {
    const s = this._cls;
    return {
      add: (c) => s.add(c), remove: (c) => s.delete(c),
      toggle: (c, f) => (f === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : f ? s.add(c) : s.delete(c)),
      contains: (c) => s.has(c),
    };
  }
  setAttribute() {}
  getAttribute() { return null; }
  removeAttribute() {}
  addEventListener(t, fn) {
    this._ev = this._ev || new Map();
    if (!this._ev.has(t)) this._ev.set(t, []);
    this._ev.get(t).push(fn);
  }
  removeEventListener() {}
  fire(type, ev = {}) {
    const fns = (this._ev && this._ev.get(type)) || [];
    for (const f of fns) {
      try { f({ preventDefault() {}, stopPropagation() {}, pointerId: 1, target: this, ...ev }); }
      catch (e) { console.error('handler THREW:', e && e.stack || e); process.exit(1); }
    }
  }
  click() { this.fire('click'); }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); return c[0]; }
  remove() {}
  contains() { return false; }
  getBoundingClientRect() { return this._rect; }
  getContext() { return this._ctx; }
  get width() { return 640; }
  set width(v) {}
  get height() { return 640; }
  set height(v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {} blur() {}
  click() {
    const fns = (this._ev && this._ev.get('click')) || [];
    fns.forEach((f) => f({ preventDefault() {}, target: this }));
  }
}

const els = new Map();
function ensure(id) {
  if (!els.has(id)) els.set(id, new El(id));
  return els.get(id);
}
for (const id of ['playBtn','bpmReadout','bpmSlider','stage','stageFrame','voiceRows','voicesLegend','addVoice','presetChips','statusPos','statusRatio','ratioBadge','statusBpm','cycleInfo']) ensure(id);

globalThis.document = {
  getElementById: (id) => els.get(id) || null,
  createElement: (t) => new El('anon', t),
  createTextNode: (s) => ({ nodeValue: s, textContent: s }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new El('body'),
  documentElement: new El('html'),
  head: new El('head'),
  fonts: { ready: Promise.resolve() },
};
globalThis.window = globalThis;
globalThis.addEventListener = (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.innerWidth = 600; globalThis.innerHeight = 900;
let rafCount = 0;
globalThis.requestAnimationFrame = (fn) => {
  if (rafCount++ > 200) return 1;   // total frame budget for a test run
  queueMicrotask(() => {
    try { fn(0); }
    catch (e) { console.error('rAF THREW:', e && e.stack || e); process.exit(1); }
  });
  return 1;
};
/* bound setInterval: after ~40 ticks stop re-arming, so test runs end */
const __setInterval = globalThis.setInterval.bind(globalThis);
globalThis.setInterval = (fn, ms) => {
  let n = 0;
  return __setInterval(() => { if (n++ < 40) fn(); }, ms);
};
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() {} unobserve() {} disconnect() {} };
globalThis.navigator = { maxTouchPoints: 1, userAgent: 'stub' };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } };
globalThis.AudioContext = function () {
  const ctx = {
    currentTime: 0, state: 'running', sampleRate: 44100,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => makeNode(),
    createBiquadFilter: () => makeNode(),
    createOscillator: () => makeNode(),
    createBuffer: (ch, len, rate) => ({ getChannelData: () => new Float32Array(len), length: len, sampleRate: rate, duration: len / rate }),
    createBufferSource: () => makeNode(),
    createDynamicsCompressor: () => makeNode({
      threshold: makeParam(-24), knee: makeParam(30), ratio: makeParam(12),
      attack: makeParam(0.003), release: makeParam(0.25), reduction: 0,
    }),
    createWaveShaper: () => makeNode(),
    createDelay: () => makeNode({ delayTime: makeParam(0) }),
    createAnalyser: () => makeNode({ getFloatTimeDomainData() {}, fftSize: 2048 }),
  };
  globalThis.__audioCtx = ctx;
  return ctx;
};

function makeParam(v) {
  return {
    value: v ?? 1,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    cancelScheduledValues() {}, cancelAndHoldAtTime() {}, setTargetAtTime() {},
  };
}
function makeNode(extra = {}) {
  return Object.assign({
    connect() { return arguments[0]; }, disconnect() {}, stop() {}, start() {}, onended: null,
    frequency: makeParam(440), detune: makeParam(0), gain: makeParam(1), Q: makeParam(1),
    type: 'sine', playbackRate: makeParam(1), detuneX: null,
  }, extra);
}
globalThis.performance = { now: () => 0 };
globalThis.__els = els;
globalThis.__listeners = listeners;
/* capture every playVoice call so tests can assert scheduling */
globalThis.__playVoiceLog = globalThis.__playVoiceLog || [];
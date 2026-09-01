/* ============================================================
   app.js — Poly Metronome  ·  controller + views
   Views:  main (tempo + layers as rows)  |  presets  |  song
   ============================================================ */

import { MetronomeEngine } from './audio.js';
import {
  load, save, makeLayer, uid, setBeatSubdiv, addBeat, removeBeat, LAYER_COLOR_OPTIONS,
} from './store.js';
import { VOICES, DEFAULT_VOICE } from '../../shared/voices.js';
import * as haptics from '../../shared/haptics.js';
import { debugState as audioDebug } from '../../shared/audio-session.js';

const ART_CYCLE = ['accent', 'normal', 'ghost', 'silent'];
/* Every subdivision the beat menu offers is reachable by tapping the hub too —
   5 and 7 used to be skipped here, which on touch (where the right-click menu
   is unreachable) meant quintuplets and septuplets could not be set at all. */
const SUBDIV_CYCLE = [1, 2, 3, 4, 5, 6, 7, 8];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
/* bpm is a normal number; keep the precision the user typed */
function formatBpm(v) { return Math.round(v * 100) / 100; }

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function btn(cls, txt, title, onClick) {
  const b = el('button', cls, txt);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
const $ = id => document.getElementById(id);
const persist = () => save(app.state);

/* ---------------- app state ---------------- */
const app = {
  state: load(),
  engine: new MetronomeEngine(),
  view: 'main',
  song: {
    playing: false,   // a section / part / whole-song sequence is running
    items: null,      // the flat playlist handed to the engine
    index: 0,         // which item is sounding right now
    snapshot: null,   // the user's main-view setup, restored when we stop
    label: '',
  },
  _raf: 0,
};

/* ---------------- bpm / tempo ---------------- */
function tempoName(b) {
  if (b < 24) return 'Grave';
  if (b < 40) return 'Largo';
  if (b < 60) return 'Larghetto';
  if (b < 66) return 'Adagio';
  if (b < 76) return 'Adagietto';
  if (b < 108) return 'Andante';
  if (b < 120) return 'Moderato';
  if (b < 156) return 'Allegro';
  if (b < 176) return 'Vivace';
  if (b < 200) return 'Presto';
  return 'Prestissimo';
}

/* Push the current bpm into every place that shows it. Skips whatever the
   user is actively typing in so the caret never jumps. */
function updateTempoDisplays() {
  const v = app.state.bpm;
  app.$.bpmReadout.textContent = formatBpm(v);
  const big = document.querySelector('.bpm-input');
  const slider = document.querySelector('.bpm-slider');
  const mark = document.querySelector('.tempo-mark');
  if (big && document.activeElement !== big) big.value = formatBpm(v);
  if (slider && document.activeElement !== slider) slider.value = clamp(v, 20, 280);
  if (mark) mark.textContent = tempoName(v);
}

function setBpm(v, rebuild = true) {
  v = clamp(isNaN(v) ? 120 : v, 0, 999);
  app.state.bpm = v;
  app.engine.setBpm(v);
  if (rebuild) buildEngineLayers();
  updateTempoDisplays();
  persist();
  updateStatus();
}

function nudgeBpm(delta) { setBpm(formatBpm(app.state.bpm + delta)); }

/* ---------------- engine sync ---------------- */
function buildEngineLayers() {
  // during song playback the engine owns its own layer program
  if (app.song.playing) return;
  app.engine.setBpm(app.state.bpm);
  app.engine.setLayers(app.state.layers);
}

function startPlayback() {
  app.engine.ensureCtx();
  app.engine.onTick = onEngineTick;
  app.engine.setBpm(app.state.bpm);
  app.engine.setLayers(app.state.layers);
  app.engine.start();
  app.$.playBtn.classList.add('playing');
  updateStatus();
}

function stopPlayback() {
  const wasSong = app.song.playing;
  app.engine.stop();
  app.engine.onItemChange = null;
  app.engine.onSequenceEnd = null;
  app.song.playing = false;
  app.song.items = null;
  app.$.playBtn.classList.remove('playing');
  haptics.cancel();
  clearPulse();
  stopProgressLoop();

  if (wasSong && app.song.snapshot) {
    app.state.bpm = app.song.snapshot.bpm;
    app.state.layers = app.song.snapshot.layers;
    app.song.snapshot = null;
    updateTempoDisplays();
    if (app.view === 'main') render();
  }
  buildEngineLayers();
  if (app.view === 'song') updateSongHighlight();
  updateStatus();
}

function togglePlay() {
  if (app.engine.running) stopPlayback();
  else startPlayback();
}

/* ---- pulse highlight ---- */
function clearPulse() {
  document.querySelectorAll('.pie-slice.active, .beat-pie.active')
    .forEach(e => e.classList.remove('active'));
}

/* How long a pulse should stay lit: the slice's own duration, so the
   highlight tracks the music instead of blinking for a fixed 110 ms. At 60 BPM
   with no subdivision that is a whole second of "this one is sounding"; at 200
   BPM in sixteenths it shortens to a strobe. Clamped so it can neither smear
   into the next slice nor vanish. */
function pulseMs(info) {
  const l = app.state.layers.find(x => x.id === info.id);
  const bpm = ((l && l.bpm != null) ? l.bpm : app.state.bpm) || 120;
  const beat = l && l.beatPattern ? l.beatPattern[info.beat] : null;
  const n = beat && beat.length ? beat.length : 1;
  const beatMs = 60000 / Math.max(1, bpm);
  return {
    slice: clamp((beatMs / n) * 0.85, 60, 900),
    // the ring around the beat holds for the whole beat, so "which beat"
    // stays readable while the slice marker travels inside it
    beat: clamp(beatMs * 0.9, 90, 2000),
  };
}

/* Which layer the phone is allowed to tap along with.

   Every layer sends its own beats, and a hand cannot feel three grids at
   once — three motors' worth of pulses inside one beat arrives as a single
   smear and the pulse stops meaning anything. So the haptic follows ONE
   layer: the first audible one, which is the layer the bar is counted in
   and the same one the song sequencer treats as master. Read off the
   engine rather than off the state, so it is still right while a song is
   playing a programme the state does not describe. */
function hapticLayerId() {
  const ls = app.engine.layers;
  const l = ls.find(x => x.enabled) || ls[0];
  return l ? l.id : null;
}

function onEngineTick(info) {
  /* Before the early return below: the pulse is about the beat, not about
     whether that layer's row happens to be on screen. */
  if (info.isBeat && info.id === hapticLayerId()) {
    haptics.pulse(info.beat === 0 ? 'accent' : 'beat');
  }

  const row = document.querySelector(`.layer-row[data-id="${info.id}"]`);
  if (!row) return;
  const slice = row.querySelector(`.pie-slice[data-beat="${info.beat}"][data-sub="${info.sub}"]`);
  const pie = row.querySelector(`.beat-pie[data-beat="${info.beat}"]`);
  const ms = pulseMs(info);

  /* Only ONE slice per layer is lit at a time. Clearing the previous pulse
     here rather than leaving it to its own timer is what makes the playhead
     read as a single travelling marker — stray timers used to leave two lit
     at once whenever the tempo changed under them. */
  row.querySelectorAll('.pie-slice.active').forEach(e => e.classList.remove('active'));
  if (slice) {
    slice.classList.add('active');
    clearTimeout(slice._pulse);
    slice._pulse = setTimeout(() => slice.classList.remove('active'), ms.slice);
  }
  if (pie) {
    row.querySelectorAll('.beat-pie.active').forEach(e => {
      if (e !== pie) e.classList.remove('active');
    });
    pie.classList.add('active');
    clearTimeout(pie._pulse);
    pie._pulse = setTimeout(() => pie.classList.remove('active'), ms.beat);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  const main = app.$.main;
  main.innerHTML = '';
  // the main view manages its own scrolling so the tempo strip stays pinned
  main.classList.toggle('pinned', app.view === 'main');
  if (app.view === 'main') renderMain(main);
  else if (app.view === 'presets') renderPresets(main);
  else if (app.view === 'song') renderSong(main);
  updateNav();
  updateStatus();
}

function updateNav() {
  document.querySelectorAll('[data-view]').forEach(b => {
    const on = b.dataset.view === app.view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function switchView(v) {
  app.view = v;
  render();
}

function sectionHead(title, sub) {
  const h = el('div', 'view-head');
  const t = el('div', 'view-head-text');
  t.appendChild(el('h2', '', title));
  if (sub) t.appendChild(el('p', 'view-sub', sub));
  h.appendChild(t);
  return h;
}

/* ---------------- MAIN view (tempo + layers) ----------------
   Laid out as three grid rows — tempo strip, layers bar, layer list —
   where only the layer list scrolls. The tempo and the layer headings
   stay put, so the running pattern is always in view. */
function renderMain(host) {
  const wrap = el('div', 'view view-main');

  /* --- tempo strip: one horizontal band --- */
  const tempo = el('section', 'tempo-bar');

  const readout = el('div', 'tempo-readout-main');
  const numWrap = el('div', 'bpm-num');
  const bpmInput = el('input', 'bpm-input');
  bpmInput.type = 'number';
  bpmInput.min = 0; bpmInput.max = 999; bpmInput.step = 'any';
  bpmInput.inputMode = 'decimal';
  bpmInput.value = formatBpm(app.state.bpm);
  bpmInput.title = 'Tempo in BPM';
  bpmInput.setAttribute('aria-label', 'Tempo in BPM');
  bpmInput.addEventListener('input', () => {
    const v = parseFloat(bpmInput.value);
    if (!isNaN(v) && v >= 0 && v <= 999) setBpm(v);
  });
  bpmInput.addEventListener('blur', () => { bpmInput.value = formatBpm(app.state.bpm); });
  numWrap.appendChild(bpmInput);
  numWrap.appendChild(el('span', 'bpm-unit', 'BPM'));
  readout.appendChild(numWrap);
  readout.appendChild(el('span', 'tempo-mark', tempoName(app.state.bpm)));
  tempo.appendChild(readout);

  const slide = el('div', 'tempo-slide');
  slide.appendChild(btn('bpm-step', '−', 'Slower (hold Shift for 10)', e => nudgeBpm(e.shiftKey ? -10 : -1)));
  const slider = el('input', 'slider bpm-slider');
  slider.type = 'range'; slider.min = 20; slider.max = 280; slider.step = 1;
  slider.value = clamp(app.state.bpm, 20, 280);
  slider.setAttribute('aria-label', 'Tempo slider');
  slider.addEventListener('input', () => setBpm(parseInt(slider.value, 10)));
  slide.appendChild(slider);
  slide.appendChild(btn('bpm-step', '+', 'Faster (hold Shift for 10)', e => nudgeBpm(e.shiftKey ? 10 : 1)));
  tempo.appendChild(slide);

  const actions = el('div', 'tempo-actions');
  const tapTimes = [];
  actions.appendChild(btn('tap-btn', 'Tap', 'Tap a few times to set the tempo (T)', () => {
    const bpm = registerTap(tapTimes);
    if (bpm) setBpm(bpm);
  }));
  [-5, 5].forEach(d => {
    actions.appendChild(btn('tempo-chip', (d > 0 ? '+' : '') + d, `${d > 0 ? 'Increase' : 'Decrease'} by ${Math.abs(d)} BPM`, () => nudgeBpm(d)));
  });
  tempo.appendChild(actions);
  wrap.appendChild(tempo);

  /* --- layers bar: heading, legend and add button on one line --- */
  const lh = el('div', 'layers-bar');
  const h = el('h2', '', 'Layers');
  h.title = 'Click a slice to cycle its articulation · click the centre to cycle subdivision · right-click or long-press a beat for the full menu';
  lh.appendChild(h);
  lh.appendChild(renderLegend());
  lh.appendChild(renderInitBtn());
  lh.appendChild(btn('btn btn-primary', '+ Add layer', 'Add a new layer', () => {
    app.state.layers.push(makeLayer('Layer ' + (app.state.layers.length + 1)));
    persist(); buildEngineLayers(); render();
  }));
  wrap.appendChild(lh);

  const rows = el('div', 'layer-rows');
  app.state.layers.forEach((layer, idx) => rows.appendChild(renderLayerRow(layer, idx)));
  wrap.appendChild(rows);

  host.appendChild(wrap);
}

/* Reset the main view to a clean slate: 120 BPM, one default layer.
   Presets and the song are left alone — they live in their own views.
   Arms on the first click and resets on the second, so a stray click
   cannot wipe a setup. */
function renderInitBtn() {
  let armed = false;
  let timer = 0;
  const b = btn('btn btn-ghost init-btn', 'Init',
    'Reset the tempo and layers to a clean starting point', () => {
      if (!armed) {
        armed = true;
        b.textContent = 'Reset everything?';
        b.classList.add('armed');
        timer = setTimeout(() => {
          armed = false;
          b.textContent = 'Init';
          b.classList.remove('armed');
        }, 3500);
        return;
      }
      clearTimeout(timer);
      stopPlayback();
      app.state.layers = [makeLayer('Main', '#6ea8ff')];
      setBpm(120);   // syncs the engine, every readout, and storage
      render();
    });
  return b;
}

function registerTap(store) {
  const t = performance.now();
  let times = store.filter(x => t - x < 2500);
  times.push(t);
  while (times.length > 6) times.shift();
  store.length = 0; times.forEach(x => store.push(x));
  if (times.length < 2) return null;
  const iv = [];
  for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
  const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
  return clamp(Math.round(60000 / avg), 20, 400);
}

/* A layer's name is derived, never typed. The only thing about a layer worth
   naming is how long its bar is, and that is already the one number the track
   below it is drawing — so it names itself and the rail gets its width back. */
const layerLabel = l => `${(l.beatPattern || []).length}/4`;

function renderLayerRow(layer, idx) {
  const row = el('section', 'layer-row');
  row.dataset.id = layer.id;
  row.style.setProperty('--layer-color', layer.color);

  /* left rail — everything about the layer except its pattern, on one
     line so a layer costs a single row of height */
  const rail = el('div', 'layer-rail');

  const enWrap = el('label', 'layer-toggle');
  const en = el('input', 'layer-enable');
  en.type = 'checkbox'; en.checked = layer.enabled;
  en.setAttribute('aria-label', `Enable layer ${layerLabel(layer)}`);
  en.addEventListener('change', () => {
    layer.enabled = en.checked;
    row.classList.toggle('disabled', !layer.enabled);
    persist(); buildEngineLayers(); updateStatus();
  });
  enWrap.appendChild(en);
  enWrap.title = 'Mute / unmute this layer';
  rail.appendChild(enWrap);

  const dot = btn('layer-color-dot', '', 'Change layer colour', () => {
    const i = LAYER_COLOR_OPTIONS.indexOf(layer.color);
    layer.color = LAYER_COLOR_OPTIONS[(i + 1) % LAYER_COLOR_OPTIONS.length];
    // the slices read --layer-color straight from the row, so recolouring
    // them by hand is both unnecessary and harmful: an inline stroke would
    // outrank the stylesheet and block the playback highlight
    row.style.setProperty('--layer-color', layer.color);
    dot.style.background = layer.color;
    persist();
  });
  dot.style.background = layer.color;
  rail.appendChild(dot);

  const name = el('span', 'layer-name', layerLabel(layer));
  name.title = 'Bar length — add or remove beats on the track to change it';
  rail.appendChild(name);

  /* Compact, unlabelled controls: the pattern is the thing worth looking at,
     so these stay quiet. Beats are added and removed on the track itself.
     They share a wrapper that is `display: contents` on wide screens (so the
     rail stays one line) and a flex row on phones (so they drop to a second
     line together instead of breaking wherever they happen to run out). */
  const ctrls = el('div', 'layer-controls');

  const sound = el('select', 'layer-sound');
  sound.setAttribute('aria-label', `Sound for layer ${layerLabel(layer)}`);
  VOICES.forEach(v => {
    const o = el('option', '', v.name);
    o.value = v.id;
    o.title = v.desc;
    if (v.id === (layer.sound || DEFAULT_VOICE)) o.selected = true;
    sound.appendChild(o);
  });
  const soundTitle = id => {
    const v = VOICES.find(x => x.id === id);
    return v ? `Sound — ${v.name}: ${v.desc}` : 'Layer sound';
  };
  sound.title = soundTitle(layer.sound);
  sound.addEventListener('change', () => {
    layer.sound = sound.value;
    sound.title = soundTitle(layer.sound);
    persist(); buildEngineLayers();
  });
  ctrls.appendChild(sound);

  const volInput = el('input', 'vol-slider');
  volInput.type = 'range'; volInput.min = 0; volInput.max = 1; volInput.step = 0.05;
  volInput.value = layer.volume;
  const volTitle = v => `Layer volume — ${Math.round(v * 100)}%`;
  volInput.title = volTitle(layer.volume);
  volInput.setAttribute('aria-label', 'Layer volume');
  volInput.addEventListener('input', () => {
    layer.volume = parseFloat(volInput.value);
    volInput.title = volTitle(layer.volume);
    persist(); buildEngineLayers();
  });
  ctrls.appendChild(volInput);
  rail.appendChild(ctrls);

  const del = btn('icon-btn danger layer-del', '×', 'Delete layer', () => {
    if (app.state.layers.length <= 1) return;
    app.state.layers.splice(idx, 1);
    persist(); buildEngineLayers(); render();
  });
  del.disabled = app.state.layers.length <= 1;
  rail.appendChild(del);

  row.appendChild(rail);

  /* right — the beat pies */
  const grid = el('div', 'layer-grid');
  layer.beatPattern.forEach((_, beatIdx) => grid.appendChild(renderBeatPie(layer, beatIdx)));
  grid.appendChild(makeAddBeatBtn(layer));
  row.appendChild(grid);

  if (!layer.enabled) row.classList.add('disabled');
  return row;
}

function makeAddBeatBtn(layer) {
  return btn('beat-add', '+', 'Add a beat', () => {
    addBeat(layer);
    layer.beats = layer.beatPattern.length;
    persist(); buildEngineLayers(); renderPiesOnly();
  });
}

/* ---- pie circle for one beat ---- */
function renderBeatPie(layer, beatIdx) {
  const beat = layer.beatPattern[beatIdx];
  const n = beat.length;
  /* R is the radius of a slice at FULL size, i.e. while it is sounding.
     At rest the slices are drawn at --slice-rest (0.93) of this, which is
     what makes the playback lift possible without anything ever growing
     past the dial: the biggest a slice can get is R + half its stroke,
     which still sits inside the 60-unit viewBox. 28 × 0.93 ≈ 26, so the
     resting pie is the same size it has always been. */
  const R = 28, CX = 30, CY = 30;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 60 60');
  svg.classList.add('pie');
  svg.dataset.beat = beatIdx;

  /* The downbeat sits at 12 o'clock, so slice 1 must be CENTRED there rather
     than starting there — otherwise the beat visually lands half a slice late,
     and by a different amount for every subdivision. Backing the whole pie up
     by half a slice (π/n) puts the centre of slice 1 exactly on top and makes
     every subdivision read the same way. */
  const START = -Math.PI / 2 - Math.PI / n;
  const wedge = (i) => {
    if (n === 1) return `M${CX},${CY - R} A${R},${R} 0 1 1 ${CX - 0.01},${CY - R} Z`;
    const a0 = START + (i / n) * 2 * Math.PI;
    const a1 = START + ((i + 1) / n) * 2 * Math.PI;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    return `M${CX},${CY} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z`;
  };

  beat.forEach((art, sIdx) => {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', wedge(sIdx));
    p.classList.add('pie-slice', 'art-' + art);
    p.dataset.beat = beatIdx; p.dataset.sub = sIdx;
    // stroke comes from --layer-color in the stylesheet, NOT an inline style:
    // inline paint outranks every rule, which silently disabled the white
    // outline on the sounding slice

    p.addEventListener('click', (e) => { e.stopPropagation(); onSliceClick(layer, beatIdx, sIdx); });
    p.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showBeatMenu(layer, beatIdx, e); });
    svg.appendChild(p);
  });

  // centre hub — click to cycle the subdivision count
  const hub = document.createElementNS(ns, 'circle');
  hub.setAttribute('cx', CX); hub.setAttribute('cy', CY); hub.setAttribute('r', 10);
  hub.classList.add('pie-hub');
  svg.appendChild(hub);

  const lbl = document.createElementNS(ns, 'text');
  lbl.setAttribute('x', CX); lbl.setAttribute('y', CY + 4);
  lbl.setAttribute('text-anchor', 'middle');
  lbl.classList.add('pie-n');
  lbl.textContent = n;
  svg.appendChild(lbl);

  /* .beat-pie is the flex slot (an equal share of the track); .beat-dial is
     the square that actually holds the circle, so the badges stay pinned to
     the corners of the dial however wide the slot gets. */
  const wrap = el('div', 'beat-pie');
  wrap.dataset.beat = beatIdx;
  wrap.title = `Beat ${beatIdx + 1} · ${n} subdivision${n > 1 ? 's' : ''}\n`
    + 'Slice: cycle articulation · Centre: cycle subdivision · Right-click or long-press: full menu';

  const dial = el('div', 'beat-dial');
  dial.appendChild(svg);
  dial.appendChild(el('span', 'beat-num', String(beatIdx + 1)));
  wrap.appendChild(dial);

  hub.addEventListener('click', (e) => { e.stopPropagation(); onCenterClick(layer, beatIdx); });
  lbl.addEventListener('click', (e) => { e.stopPropagation(); onCenterClick(layer, beatIdx); });
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); showBeatMenu(layer, beatIdx, e); });
  // touch equivalent of the right-click menu
  attachLongPress(wrap, (pt) => showBeatMenu(layer, beatIdx, pt));

  if (layer.beatPattern.length > 1) {
    dial.appendChild(btn('beat-rm', '×', 'Remove this beat', (e) => {
      e.stopPropagation();
      removeBeat(layer, beatIdx);
      layer.beats = layer.beatPattern.length;
      persist(); buildEngineLayers(); renderPiesOnly();
    }));
  }

  return wrap;
}

/* slice click: cycle articulation accent → normal → ghost → silent */
function onSliceClick(layer, beatIdx, sIdx) {
  if (consumeLongPress()) return;   // the hold already opened the menu
  const cur = layer.beatPattern[beatIdx][sIdx];
  layer.beatPattern[beatIdx][sIdx] = ART_CYCLE[(ART_CYCLE.indexOf(cur) + 1) % ART_CYCLE.length];
  persist(); buildEngineLayers(); renderPiesOnly();
}
/* centre click: cycle subdivision count 1→2→3→4→6→8→1 */
function onCenterClick(layer, beatIdx) {
  if (consumeLongPress()) return;
  const cur = layer.beatPattern[beatIdx].length;
  const i = SUBDIV_CYCLE.indexOf(cur);
  setBeatSubdiv(layer, beatIdx, SUBDIV_CYCLE[(i + 1) % SUBDIV_CYCLE.length]);
  persist(); buildEngineLayers(); renderPiesOnly();
}

/* re-render just the pie grids, so typing in a text field is never interrupted */
function renderPiesOnly() {
  const host = app.$.main;
  if (!host || app.view !== 'main') { render(); return; }
  app.state.layers.forEach(layer => {
    const grid = host.querySelector(`.layer-row[data-id="${layer.id}"] .layer-grid`);
    if (!grid) return;
    const scroll = grid.scrollLeft;
    grid.innerHTML = '';
    layer.beatPattern.forEach((_, beatIdx) => grid.appendChild(renderBeatPie(layer, beatIdx)));
    grid.appendChild(makeAddBeatBtn(layer));
    grid.scrollLeft = scroll;
    // the name IS the bar length, so it has to follow a beat being added
    const nm = host.querySelector(`.layer-row[data-id="${layer.id}"] .layer-name`);
    if (nm) nm.textContent = layerLabel(layer);
  });
}

/* ---- long press ----
   Touch has no right-click, so the full beat menu was unreachable on a phone.
   A press held past LONG_MS opens it at the finger. The press is abandoned if
   the finger travels (that is a scroll, not a hold), and the click that would
   normally follow is swallowed so the beat does not also cycle. */
const LONG_MS = 450;
const LONG_SLOP = 10;      // px of travel still counted as "held still"
let _longFired = 0;        // timestamp, so the click right after is ignored

function consumeLongPress() {
  if (performance.now() - _longFired > 700) return false;
  _longFired = 0;
  return true;
}

function attachLongPress(node, handler) {
  let timer = 0, x0 = 0, y0 = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } };

  node.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;   // let real right-clicks through
    x0 = e.clientX; y0 = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      _longFired = performance.now();
      if (navigator.vibrate) navigator.vibrate(15);
      handler({ clientX: x0, clientY: y0 });
    }, LONG_MS);
  });
  node.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - x0) > LONG_SLOP || Math.abs(e.clientY - y0) > LONG_SLOP)) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t =>
    node.addEventListener(t, cancel));
}

/* ---- beat popup menu (subdivision + per-slice articulation) ---- */
let _menuEl = null;
const isSheet = () => window.matchMedia('(max-width: 560px)').matches;

function closeBeatMenu() {
  if (!_menuEl) return;
  _menuEl.remove();
  _menuEl = null;
  document.removeEventListener('pointerdown', onMenuAway, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuAway(e) { if (_menuEl && !_menuEl.contains(e.target)) closeBeatMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') closeBeatMenu(); }

function showBeatMenu(layer, beatIdx, ev) {
  closeBeatMenu();
  const beat = layer.beatPattern[beatIdx];
  const m = el('div', 'beat-menu');

  const title = el('div', 'bm-title');
  title.appendChild(el('span', '', `${layerLabel(layer)} · beat ${beatIdx + 1}`));
  title.appendChild(btn('bm-close', '×', 'Close', closeBeatMenu));
  m.appendChild(title);

  const subRow = el('div', 'bm-sub');
  subRow.appendChild(el('span', 'bm-label', 'Subdivision'));
  const chips = el('div', 'bm-chips');
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(n => {
    const c = btn('bm-chip' + (n === beat.length ? ' sel' : ''), String(n), `${n} per beat`, () => {
      setBeatSubdiv(layer, beatIdx, n);
      persist(); buildEngineLayers(); renderPiesOnly();
      closeBeatMenu();
      showBeatMenu(layer, beatIdx, ev);
    });
    chips.appendChild(c);
  });
  subRow.appendChild(chips);
  m.appendChild(subRow);

  const fill = el('div', 'bm-sub');
  fill.appendChild(el('span', 'bm-label', 'Fill all slices'));
  const fillChips = el('div', 'bm-chips bm-fills');
  ART_CYCLE.forEach(a => {
    /* each chip carries its own colour swatch, so this row doubles as the
       articulation key — which is what lets the main view drop the legend
       on small screens without the colours becoming a guessing game */
    const c = btn('bm-fill art-' + a, '', `Set every slice to ${a}`, () => {
      layer.beatPattern[beatIdx] = beat.map(() => a);
      persist(); buildEngineLayers(); renderPiesOnly();
      closeBeatMenu();
    });
    c.appendChild(el('span', 'bm-sw art-' + a));
    c.appendChild(el('span', 'bm-fill-label', a));
    fillChips.appendChild(c);
  });
  fill.appendChild(fillChips);
  m.appendChild(fill);

  const sl = el('div', 'bm-slices');
  sl.appendChild(el('span', 'bm-label', 'Per slice'));
  beat.forEach((art, sIdx) => {
    const pick = el('div', 'bm-slicepick');
    pick.appendChild(el('span', 'bm-idx', String(sIdx + 1)));
    const sw = el('span', 'bm-sw art-' + art);
    pick.appendChild(sw);
    const sel = el('select', 'bm-art');
    ART_CYCLE.forEach(a => {
      const o = el('option', '', a);
      o.value = a;
      if (a === art) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      layer.beatPattern[beatIdx][sIdx] = sel.value;
      sw.className = 'bm-sw art-' + sel.value;
      persist(); buildEngineLayers(); renderPiesOnly();
    });
    pick.appendChild(sel);
    sl.appendChild(pick);
  });
  m.appendChild(sl);

  /* Removing a beat lives here as well as on the dial's own × badge. The badge
     is small and hover-revealed on a desktop, and a bar dense enough to be hard
     to hit is exactly the bar you most want to shorten — so the one action that
     undoes "I added too many" gets a second, always-reachable route. */
  if (layer.beatPattern.length > 1) {
    const rm = btn('btn btn-ghost bm-rm', 'Remove beat ' + (beatIdx + 1),
      'Delete this beat from the bar', () => {
        closeBeatMenu();
        removeBeat(layer, beatIdx);
        layer.beats = layer.beatPattern.length;
        persist(); buildEngineLayers(); renderPiesOnly();
      });
    m.appendChild(rm);
  }

  /* On a phone this is a bottom sheet — a 264px popover anchored to a finger
     lands half off-screen and under the hand. CSS owns the sheet's geometry,
     so we must not write inline coordinates in that case. */
  if (isSheet()) m.classList.add('bm-sheet');
  document.body.appendChild(m);
  if (!isSheet()) {
    const r = m.getBoundingClientRect();
    m.style.left = clamp(ev.clientX, 8, window.innerWidth - r.width - 8) + 'px';
    m.style.top = clamp(ev.clientY, 8, window.innerHeight - r.height - 8) + 'px';
  }
  _menuEl = m;
  setTimeout(() => {
    // pointerdown, not mousedown: touch only synthesises mouse events late
    document.addEventListener('pointerdown', onMenuAway, true);
    document.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

/* ---- articulation legend ---- */
function renderLegend() {
  const leg = el('div', 'legend');
  [
    ['accent', 'Accent'],
    ['normal', 'Normal'],
    ['ghost', 'Ghost'],
    ['silent', 'Silent'],
  ].forEach(([art, label]) => {
    const it = el('div', 'leg-item');
    it.appendChild(el('span', 'leg-sw art-' + art));
    it.appendChild(el('span', '', label));
    leg.appendChild(it);
  });
  return leg;
}

/* ---------------- PRESETS view ---------------- */
function presetSummary(p) {
  const beats = p.layers[0] ? p.layers[0].beatPattern.length : 0;
  return `${formatBpm(p.bpm)} BPM · ${p.layers.length} layer${p.layers.length > 1 ? 's' : ''} · ${beats} beats`;
}

function renderPresets(host) {
  const wrap = el('div', 'view view-presets');
  wrap.appendChild(sectionHead('Presets', 'Save the current tempo and layers, then build parts from them in the Song view.'));

  const saveBar = el('div', 'savebar');
  const nameI = el('input', 'text-input grow');
  nameI.placeholder = 'Preset name';
  nameI.setAttribute('aria-label', 'Preset name');
  const doSave = () => {
    const auto = `${formatBpm(app.state.bpm)} BPM · ${app.state.layers.length} layer${app.state.layers.length > 1 ? 's' : ''}`;
    const name = (nameI.value || auto).trim();
    app.state.presets.push({
      id: uid('preset'),
      name,
      bpm: app.state.bpm,
      layers: JSON.parse(JSON.stringify(app.state.layers)),
    });
    nameI.value = '';
    persist(); render();
  };
  nameI.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  saveBar.appendChild(nameI);
  saveBar.appendChild(btn('btn btn-primary', 'Save current setup', 'Save the current tempo and layers as a preset', doSave));
  wrap.appendChild(saveBar);

  const list = el('div', 'card-list');
  if (!app.state.presets.length) {
    list.appendChild(el('div', 'empty', 'No presets yet — set up your layers in the Main view and save them here.'));
  }
  app.state.presets.forEach((p, i) => {
    const row = el('div', 'list-row');
    const info = el('div', 'list-info');
    const nm = el('input', 'inline-name');
    nm.value = p.name;
    nm.setAttribute('aria-label', 'Preset name');
    nm.addEventListener('input', () => { p.name = nm.value; persist(); });
    info.appendChild(nm);
    info.appendChild(el('div', 'list-desc', presetSummary(p)));
    row.appendChild(info);

    const acts = el('div', 'list-acts');
    acts.appendChild(btn('btn btn-ghost', 'Load', 'Load this preset into the Main view', () => {
      stopPlayback();
      app.state.bpm = p.bpm;
      app.state.layers = JSON.parse(JSON.stringify(p.layers));
      app.state.layers.forEach(l => { l.id = l.id || uid('layer'); });
      persist(); buildEngineLayers(); switchView('main');
    }));
    acts.appendChild(btn('icon-btn', '⧉', 'Duplicate preset', () => {
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid('preset');
      copy.name = p.name + ' copy';
      copy.layers.forEach(l => { l.id = uid('layer'); });
      app.state.presets.splice(i + 1, 0, copy);
      persist(); render();
    }));
    acts.appendChild(btn('icon-btn danger', '×', 'Delete preset', () => {
      app.state.presets = app.state.presets.filter(x => x.id !== p.id);
      persist(); render();
    }));
    row.appendChild(acts);
    list.appendChild(row);
  });
  wrap.appendChild(list);
  host.appendChild(wrap);
}

/* ---------------- SONG view ---------------- */
function ensureSections() {
  if (!app.state.song.sections) app.state.song.sections = [];
  return app.state.song.sections;
}
const presetById = id => app.state.presets.find(p => p.id === id) || null;

function renderSong(host) {
  const wrap = el('div', 'view view-song');
  wrap.appendChild(sectionHead('Song', 'Parts play one after another inside a section; sections play in order through the whole song.'));

  const bar = el('div', 'savebar');
  const nameI = el('input', 'text-input grow');
  nameI.value = app.state.song.name || '';
  nameI.placeholder = 'Song name';
  nameI.setAttribute('aria-label', 'Song name');
  nameI.addEventListener('input', () => { app.state.song.name = nameI.value; persist(); });
  bar.appendChild(nameI);

  const playAll = btn('btn btn-primary song-playall', '', 'Play every section in order', () => {
    if (app.song.playing) stopPlayback();
    // rebuilt on click: repeats are edited without a re-render, so a
    // playlist captured at render time would be stale
    else startSong(buildSongItems(), app.state.song.name || 'Song');
  });
  playAll.disabled = !buildSongItems().length && !app.song.playing;
  bar.appendChild(playAll);
  bar.appendChild(btn('btn btn-ghost', '+ Section', 'Add a section', () => {
    ensureSections().push({ id: uid('sec'), name: 'Section ' + (ensureSections().length + 1), parts: [] });
    persist(); render();
  }));
  wrap.appendChild(bar);

  if (!app.state.presets.length) {
    wrap.appendChild(el('div', 'notice', 'Save at least one preset first — parts are built from presets.'));
  }

  const secList = el('div', 'card-list');
  const secs = ensureSections();
  if (!secs.length) {
    secList.appendChild(el('div', 'empty', 'No sections yet. Add one to start building the song.'));
  }
  secs.forEach((sec, si) => secList.appendChild(renderSection(sec, si)));
  wrap.appendChild(secList);

  host.appendChild(wrap);
  updateSongHighlight();
}

function renderSection(sec, si) {
  const card = el('section', 'section-card');
  card.dataset.si = si;

  const head = el('div', 'section-head');
  head.appendChild(el('span', 'section-index', String(si + 1)));

  const nm = el('input', 'inline-name grow');
  nm.value = sec.name;
  nm.setAttribute('aria-label', 'Section name');
  nm.addEventListener('input', () => { sec.name = nm.value; persist(); });
  head.appendChild(nm);

  const acts = el('div', 'section-acts');
  const playSec = btn('btn btn-ghost', '▶ Section', 'Play every part of this section in order',
    () => startSong(buildSongItems(si), sec.name));   // rebuilt on click, see above
  playSec.disabled = !buildSongItems(si).length;
  acts.appendChild(playSec);

  const secs = ensureSections();
  const up = btn('icon-btn', '↑', 'Move section up', () => {
    [secs[si - 1], secs[si]] = [secs[si], secs[si - 1]];
    persist(); render();
  });
  up.disabled = si === 0;
  const down = btn('icon-btn', '↓', 'Move section down', () => {
    [secs[si + 1], secs[si]] = [secs[si], secs[si + 1]];
    persist(); render();
  });
  down.disabled = si === secs.length - 1;
  acts.appendChild(up); acts.appendChild(down);

  acts.appendChild(btn('icon-btn danger', '×', 'Delete section', () => {
    stopPlayback();
    secs.splice(si, 1);
    persist(); render();
  }));
  head.appendChild(acts);
  card.appendChild(head);

  const parts = el('div', 'section-parts');
  const list = sec.parts || [];
  if (!list.length) parts.appendChild(el('div', 'empty small', 'No parts yet.'));
  list.forEach((part, pi) => parts.appendChild(renderPart(sec, si, part, pi)));
  card.appendChild(parts);

  card.appendChild(btn('part-add', '+ Part', 'Add a part to this section', () => {
    if (!sec.parts) sec.parts = [];
    sec.parts.push({ presetId: app.state.presets[0]?.id || '', repeats: 1 });
    persist(); render();
  }));
  return card;
}

function renderPart(sec, si, part, pi) {
  const row = el('div', 'part-row');
  row.dataset.si = si; row.dataset.pi = pi;

  const progress = el('div', 'part-progress');
  row.appendChild(progress);

  const body = el('div', 'part-body');
  body.appendChild(el('span', 'part-index', String(pi + 1)));

  const selWrap = el('div', 'part-select');
  const sel = el('select', 'field-input grow');
  sel.setAttribute('aria-label', 'Preset for this part');
  const none = el('option', '', '— choose a preset —');
  none.value = '';
  sel.appendChild(none);
  app.state.presets.forEach(p => {
    const o = el('option', '', p.name);
    o.value = p.id;
    if (p.id === part.presetId) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { part.presetId = sel.value; persist(); render(); });
  selWrap.appendChild(sel);
  const preset = presetById(part.presetId);
  selWrap.appendChild(el('span', 'part-desc', preset ? presetSummary(preset) : 'No preset selected — this part is skipped'));
  body.appendChild(selWrap);

  const repField = el('div', 'part-repeat');
  repField.appendChild(el('span', 'field-label', 'Repeats'));
  const stepper = el('div', 'stepper');
  const setRep = (n) => {
    part.repeats = clamp(isNaN(n) ? 1 : n, 1, 99);
    repInput.value = part.repeats;
    persist();
  };
  const down = btn('stepper-btn', '−', 'One repeat fewer', () => setRep((part.repeats || 1) - 1));
  const repInput = el('input', 'field-input stepper-input');
  repInput.type = 'number'; repInput.min = 1; repInput.max = 99;
  repInput.value = part.repeats || 1;
  repInput.setAttribute('aria-label', 'Repeats');
  repInput.addEventListener('change', () => setRep(parseInt(repInput.value, 10)));
  const up = btn('stepper-btn', '+', 'One repeat more', () => setRep((part.repeats || 1) + 1));
  stepper.appendChild(down); stepper.appendChild(repInput); stepper.appendChild(up);
  repField.appendChild(stepper);
  body.appendChild(repField);

  const acts = el('div', 'part-acts');
  const play = btn('icon-btn', '▶', 'Play just this part', () => {
    const items = buildSongItems(si, pi);
    startSong(items, `${sec.name} · part ${pi + 1}`);
  });
  play.disabled = !preset;
  acts.appendChild(play);

  const mv = sec.parts;
  const pu = btn('icon-btn', '↑', 'Move part up', () => {
    [mv[pi - 1], mv[pi]] = [mv[pi], mv[pi - 1]]; persist(); render();
  });
  pu.disabled = pi === 0;
  const pd = btn('icon-btn', '↓', 'Move part down', () => {
    [mv[pi + 1], mv[pi]] = [mv[pi], mv[pi + 1]]; persist(); render();
  });
  pd.disabled = pi === mv.length - 1;
  acts.appendChild(pu); acts.appendChild(pd);

  acts.appendChild(btn('icon-btn danger', '×', 'Delete part', () => {
    stopPlayback();
    sec.parts.splice(pi, 1);
    persist(); render();
  }));
  body.appendChild(acts);

  row.appendChild(body);
  return row;
}

/* ============================================================
   SONG PLAYBACK
   Every part becomes one sequence item that occupies exactly
   `repeats` bars on the audio clock. The engine plays the items
   back to back, so parts run in series within a section and
   sections run in series through the song.
   ============================================================ */

/* buildSongItems()            → the whole song
   buildSongItems(si)          → one section
   buildSongItems(si, pi)      → one part                        */
function buildSongItems(si, pi) {
  const secs = ensureSections();
  const items = [];
  secs.forEach((sec, s) => {
    if (si != null && s !== si) return;
    (sec.parts || []).forEach((part, p) => {
      if (pi != null && p !== pi) return;
      const preset = presetById(part.presetId);
      if (!preset || !preset.layers || !preset.layers.length) return;
      items.push({
        secIdx: s,
        partIdx: p,
        preset,
        bpm: preset.bpm,
        layers: preset.layers,
        bars: clamp(part.repeats || 1, 1, 99),
      });
    });
  });
  return items;
}

function startSong(items, label) {
  if (!items || !items.length) return;
  stopPlayback();

  app.engine.ensureCtx();
  app.song.snapshot = {
    bpm: app.state.bpm,
    layers: JSON.parse(JSON.stringify(app.state.layers)),
  };
  app.song.playing = true;
  app.song.items = items;
  app.song.index = 0;
  app.song.label = label || '';

  app.engine.onTick = onEngineTick;
  app.engine.onItemChange = (idx) => {
    app.song.index = idx;
    showItem(items[idx]);
    updateSongHighlight();
    updateStatus();
  };
  app.engine.onSequenceEnd = () => { stopPlayback(); };

  showItem(items[0]);
  app.engine.playSequence(items);
  app.$.playBtn.classList.add('playing');
  startProgressLoop();
  updateSongHighlight();
  updateStatus();
}

/* Mirror the sounding part into the visible state. Deliberately does NOT
   persist — the user's own Main-view setup is restored when playback ends. */
function showItem(item) {
  if (!item) return;
  app.state.bpm = item.preset.bpm;
  app.state.layers = JSON.parse(JSON.stringify(item.preset.layers));
  app.state.layers.forEach(l => { l.id = l.id || uid('layer'); });
  updateTempoDisplays();
  if (app.view === 'main') render();
}

function updateSongHighlight() {
  const cur = app.song.playing && app.song.items ? app.song.items[app.song.index] : null;
  const playAll = document.querySelector('.song-playall');
  if (playAll) {
    playAll.textContent = app.song.playing ? '■ Stop' : '▶ Play song';
    playAll.classList.toggle('is-stop', app.song.playing);
  }
  document.querySelectorAll('.section-card').forEach(c => {
    c.classList.toggle('playing', !!cur && +c.dataset.si === cur.secIdx);
  });
  document.querySelectorAll('.part-row').forEach(r => {
    const on = !!cur && +r.dataset.si === cur.secIdx && +r.dataset.pi === cur.partIdx;
    r.classList.toggle('playing', on);
    if (!on) {
      const bar = r.querySelector('.part-progress');
      if (bar) bar.style.transform = 'scaleX(0)';
    }
  });
}

function startProgressLoop() {
  stopProgressLoop();
  const step = () => {
    if (!app.song.playing) return;
    const p = app.engine.sequenceProgress();
    if (p) {
      const cur = app.song.items[p.index];
      const row = document.querySelector(`.part-row[data-si="${cur.secIdx}"][data-pi="${cur.partIdx}"]`);
      const bar = row && row.querySelector('.part-progress');
      if (bar) bar.style.transform = `scaleX(${p.frac})`;
      app.$.statusPos.textContent =
        `${app.song.label} · ${p.index + 1}/${p.total} · bar ${p.bar}/${p.bars}`;
    }
    app._raf = requestAnimationFrame(step);
  };
  app._raf = requestAnimationFrame(step);
}

function stopProgressLoop() {
  if (app._raf) cancelAnimationFrame(app._raf);
  app._raf = 0;
  document.querySelectorAll('.part-progress').forEach(b => { b.style.transform = 'scaleX(0)'; });
}

/* ---------------- status bar ---------------- */
function updateStatus() {
  const active = app.state.layers.filter(l => l.enabled).length;
  app.$.statusLayers.textContent = `${active}/${app.state.layers.length} layers`;
  app.$.statusBpm.textContent = formatBpm(app.state.bpm) + ' BPM';
  if (app.song.playing) {
    // the rAF loop refines this with a live bar counter while the tab is visible
    app.$.statusPos.textContent =
      `${app.song.label} · ${app.song.index + 1}/${app.song.items.length}`;
  } else {
    app.$.statusPos.textContent = app.engine.running ? 'playing' : 'stopped';
  }
}

/* ---------------- keyboard ---------------- */
const _taps = [];
function onKey(e) {
  if (e.target.matches('input,select,textarea')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 't' || e.key === 'T') {
    const bpm = registerTap(_taps);
    if (bpm) setBpm(bpm);
  }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeBpm(e.shiftKey ? -10 : -1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeBpm(e.shiftKey ? 10 : 1); }
  else if (e.key === 'Escape') { closeBeatMenu(); }
  else if (/^[1-9]$/.test(e.key)) {
    const l = app.state.layers[parseInt(e.key, 10) - 1];
    if (l) {
      l.enabled = !l.enabled;
      persist(); buildEngineLayers();
      const row = document.querySelector(`.layer-row[data-id="${l.id}"]`);
      if (row) {
        row.classList.toggle('disabled', !l.enabled);
        const cb = row.querySelector('.layer-enable');
        if (cb) cb.checked = l.enabled;
      }
      updateStatus();
    }
  }
}

/* ---------------- init ---------------- */
function init() {
  app.$ = {
    main: $('main'),
    playBtn: $('playBtn'),
    bpmReadout: $('bpmReadout'),
    statusBar: $('statusBar'),
    statusPos: $('statusPos'),
    statusLayers: $('statusLayers'),
    statusBpm: $('statusBpm'),
  };
  app.engine.onTick = onEngineTick;
  /* The audio context can die under a phone — a call, headphones pulled,
     the OS taking the audio session away. The engine rebuilds itself
     where it can; when it cannot, the transport has to stop looking like
     it is playing, because the one thing worse than silence is a lit play
     button over it. */
  app.engine.onAudioLost = (reason, deliberate) => {
    stopPlayback();
    if (!deliberate) app.$.statusPos.textContent = 'audio interrupted — press play';
  };
  app.engine.setBpm(app.state.bpm);
  buildEngineLayers();

  app.$.playBtn.addEventListener('click', togglePlay);
  document.querySelectorAll('[data-view]').forEach(b => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', closeBeatMenu);

  render();
  updateTempoDisplays();
}

/* A read-only window onto the engine, for checking from the console that
   the audio context is still alive — the trainer carries the same handle. */
window.__poly = {
  get running() { return app.engine.running; },
  get ctxState() { return app.engine.ctx ? app.engine.ctx.state : null; },
  get ctxTime() { return app.engine.ctx ? app.engine.ctx.currentTime : null; },
  get audio() { return audioDebug(); },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

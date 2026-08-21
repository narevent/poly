/* ============================================================
   store.js — central state + persistence (localStorage)
   Data model: each layer has `beatPattern` = array of beats.
   Each beat is an array of articulations whose LENGTH is that
   beat's subdivision (so every step can have its own subdiv).
   ============================================================ */

import { DEFAULT_VOICE, isVoice, resolveVoice } from '../../shared/voices.js';

const KEY = 'poly-metronome-v2';

let _idc = 1;
export function uid(p='id') { return `${p}_${Date.now().toString(36)}_${(_idc++).toString(36)}`; }

const LAYER_COLORS = ['#6ea8ff','#7c84ff','#5fe3a1','#ffb86b','#ff6b81','#9b8cff'];
export const LAYER_COLOR_OPTIONS = LAYER_COLORS;

function makeBeat(subdiv) {
  const slices = [];
  for (let s = 0; s < subdiv; s++) slices.push('normal');
  return slices;
}

export function makeLayer(name, color) {
  const beats = 4, subdiv = 1;
  const beatPattern = [];
  for (let b = 0; b < beats; b++) {
    const beat = makeBeat(subdiv);
    if (b === 0) beat[0] = 'accent';
    beatPattern.push(beat);
  }
  return {
    id: uid('layer'),
    name,
    color: color || LAYER_COLORS[Math.floor(Math.random()*LAYER_COLORS.length)],
    enabled: true,
    bpm: null,              // null => follow global bpm
    beats,
    defaultSubdiv: subdiv,  // subdiv used when adding a new step
    volume: 1,
    pitchOffset: 0,
    sound: DEFAULT_VOICE,   // which voice from voices.js this layer plays
    beatPattern,
    _beatIdx: 0, _subIdx: 0, _nextTime: 0,
  };
}

export const defaultState = {
  bpm: 120,
  selectedLayerId: null,
  layers: [ makeLayer('Main', '#6ea8ff') ],
  presets: [],
  song: { name: '', sections: [] },
};

function migrateLayer(l) {
  l._beatIdx = 0; l._subIdx = 0; l._nextTime = 0;
  if (l.defaultSubdiv == null) l.defaultSubdiv = 1;
  if (l.tuplet) { /* legacy: fold into per-beat length */ delete l.tuplet; }
  if (typeof l.subdiv === 'number' && !l.beatPattern) { delete l.subdiv; }
  // layers saved before voices existed fall back to the default one; a layer
  // on a voice that has since been retired is moved to its replacement
  l.sound = isVoice(l.sound) ? resolveVoice(l.sound) : DEFAULT_VOICE;
  // Per-layer BPM is gone. A value left in a saved layer would still be
  // honoured by the engine with nothing on screen to show or undo it, so it
  // is cleared here rather than left as invisible state.
  l.bpm = null;
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaultState);
    const s = JSON.parse(raw);
    // hydrate runtime fields + migrate any v1 layers, in the main state
    // and inside every saved preset (presets store full layer copies)
    (s.layers || []).forEach(migrateLayer);
    (s.presets || []).forEach(p => (p.layers || []).forEach(migrateLayer));
    if (!s.song) s.song = { name: '', sections: [] };
    return s;
  } catch (e) {
    console.warn('load failed', e);
    return structuredClone(defaultState);
  }
}

export function save(state) {
  try {
    const slim = JSON.parse(JSON.stringify(state));
    for (const l of slim.layers) {
      delete l._beatIdx; delete l._subIdx; delete l._nextTime;
    }
    localStorage.setItem(KEY, JSON.stringify(slim));
  } catch (e) { console.warn('save failed', e); }
}

/* ---- Derived helpers ---- */

// total slices across the whole bar (sum of every beat's subdivision)
export function layerTotalSlices(layer) {
  return (layer.beatPattern || []).reduce((a, beat) => a + beat.length, 0);
}

// resize one beat's subdivision, preserving existing articulations
export function setBeatSubdiv(layer, beatIdx, subdiv) {
  const beat = layer.beatPattern[beatIdx] || [];
  const out = [];
  for (let s = 0; s < subdiv; s++) out.push(beat[s] !== undefined ? beat[s] : 'normal');
  layer.beatPattern[beatIdx] = out;
}

export function addBeat(layer) {
  layer.beatPattern.push(makeBeat(layer.defaultSubdiv || 1));
  layer.beats = layer.beatPattern.length;
}

export function removeBeat(layer, beatIdx) {
  if (layer.beatPattern.length <= 1) return;
  layer.beatPattern.splice(beatIdx, 1);
  layer.beats = layer.beatPattern.length;
}
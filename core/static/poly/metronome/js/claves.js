/* ============================================================
   claves.js — articulation presets
   Each preset mutates/returns a beatPattern: array of beats where
   each beat is an array of articulations. Beat lengths may differ
   (per-step subdivision) so we always work against the existing
   lengths rather than assuming a uniform grid.
   ============================================================ */

export const CLAVES = {
  none:        { name: '— clear —',          apply: (l) => clearPattern(l) },
  straight:    { name: 'Straight (all normal)', apply: (l) => allArtic(l, 'normal') },
  backbeat:    { name: 'Backbeat (2 & 4)',   apply: backbeat },
  accentDown:  { name: 'Downbeats accented', apply: downbeatsAccent },
  sonClave:    { name: 'Son clave (3-2)',    apply: (l) => clavePattern(l, [0, 3, 6, 10, 12]) },
  rumbaClave:  { name: 'Rumba clave (3-2)',  apply: (l) => clavePattern(l, [0, 3, 7, 10, 12]) },
  bossa:       { name: 'Bossa nova clave',   apply: (l) => clavePattern(l, [0, 3, 6, 10, 12]) },
  tresillo:    { name: 'Tresillo (3-3-2)',   apply: tresillo },
  charleston:  { name: 'Charleston (hats on &)', apply: charleston },
  ghost:       { name: 'Ghost notes (alternating)', apply: ghostNotes },
};

function clone(p) { return p.map(b => b.slice()); }

function clearPattern(l) {
  const p = l.beatPattern.map(() => []);
  // keep lengths, set all to normal except silent-ish: actually clear = all normal
  return l.beatPattern.map(b => b.map(() => 'normal'));
}

function allArtic(l, art) {
  return l.beatPattern.map(b => b.map(() => art));
}

function backbeat(l) {
  const p = allArtic(l, 'normal');
  for (let b = 1; b < p.length; b += 2) p[b] = p[b].map(() => 'accent');
  return p;
}

function downbeatsAccent(l) {
  const p = allArtic(l, 'normal');
  if (p[0]) p[0] = p[0].map((_, i) => i === 0 ? 'accent' : 'normal');
  for (let b = 1; b < p.length; b++) p[b] = p[b].map(() => 'silent');
  return p;
}

function clavePattern(l, hitSlices) {
  // hitSlices are positions on a 16-step reference grid (4 beats x 4 subdiv).
  // We map proportionally onto the layer's flattened grid (whatever the
  // per-beat subdivision), only turning on the nearest slice.
  const flat = l.beatPattern.flatMap(b => b.map(() => 'silent'));
  const total = flat.length;
  for (const h of hitSlices) {
    const idx = Math.round((h / 16) * total);
    if (flat[idx] !== undefined) flat[idx] = 'accent';
  }
  // re-chunk using original per-beat lengths
  const out = [];
  let i = 0;
  for (const b of l.beatPattern) { out.push(flat.slice(i, i + b.length)); i += b.length; }
  return out;
}

function tresillo(l) {
  const flat = l.beatPattern.flatMap(b => b.map(() => 'silent'));
  const total = flat.length;
  [0, 3, 5].forEach(ref => {
    const idx = Math.round((ref / 8) * total);
    if (flat[idx] !== undefined) flat[idx] = 'normal';
  });
  const out = []; let i = 0;
  for (const b of l.beatPattern) { out.push(flat.slice(i, i + b.length)); i += b.length; }
  return out;
}

function charleston(l) {
  const p = allArtic(l, 'silent');
  for (const b of p) { if (b.length >= 2) b[1] = 'accent'; }
  return p;
}

function ghostNotes(l) {
  const p = allArtic(l, 'normal');
  for (const b of p) { for (let i = 0; i < b.length; i++) if (i % 2 === 1) b[i] = 'ghost'; }
  return p;
}

export const CLAVE_LIST = Object.entries(CLAVES).map(([id, c]) => ({ id, name: c.name }));
import './circles-stub.cjs';
const app = await import('../core/static/poly/circles/js/circles.js');
const canvas = globalThis.document.getElementById('stage');
const g = canvas.getContext('2d');
console.log('ops total:', g.ops.length);
console.log('ops sample:', g.ops.slice(0, 12));
const arcCount = g.ops.filter(o => o[0] === 'arc').length;
console.log('arcs:', arcCount);
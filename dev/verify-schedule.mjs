import './circles-stub.cjs';
const app = await import('../core/static/poly/circles/js/circles.js');
const cv = document.getElementById('stage');
const g = cv.getContext('2d');
const before = g.ops.length;
document.getElementById('playBtn').click();
setTimeout(() => {
  const ops = g.ops;
  console.log('ops while playing:', ops.length - before, '(total', ops.length + ')');
  console.log('arcs:', ops.filter(o => o[0] === 'arc').length,
              '| lines:', ops.filter(o => o[0] === 'lineTo').length,
              '| labels:', ops.filter(o => o[0] === 'fillText').length);
  process.exit(0);
}, 600);
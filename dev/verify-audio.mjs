import './circles-stub.cjs';
await import('../core/static/poly/circles/js/circles.js');
const play = document.getElementById('playBtn');
play.click();
setTimeout(() => {
  const ctx = globalThis.__audioCtx;
  console.log('audio ctx created:', !!ctx, 'currentTime:', ctx ? ctx.currentTime.toFixed(2) : 'n/a');
  const status = document.getElementById('statusPos').textContent;
  console.log('status:', status);
  process.exit(0);
}, 500);

// Load the stub, then the real app module. Any runtime error prints plainly.
import('./circles-stub.cjs')
  .then(() => import('../core/static/poly/circles/js/circles.js'))
  .then((mod) => {
    console.log('MODULE LOADED OK — no runtime error at import/init time');
    process.exit(0);
  })
  .catch((err) => {
    console.error('RUNTIME ERROR:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
import './circles-stub.cjs';
localStorage.removeItem('poly.circles.v3');
await import('../core/static/poly/circles/js/circles.js');
const rows = document.getElementById('voiceRows');
const colB = rows.children[0].children[2];
const pitchRow = colB.children[1];
console.log('pitch row class:', pitchRow.className);
const pit = pitchRow.children[2];
console.log('default value:', pit.value, '(centre of -12..12) | readout:', pitchRow.children[1].textContent);
// and a saved non-zero pitch still restores correctly
pit.value = '-5'; pit.fire('input'); pit.fire('change');
const saved = JSON.parse(localStorage.getItem('poly.circles.v3'));
console.log('after drag to -5, saved pitch:', saved.voices[0].pitch);
// rebuild from saved state and confirm the slider returns to -5, not 0
const rows2 = document.getElementById('voiceRows');
const pit2 = rows2.children[0].children[2].children[1].children[2];
console.log('after re-render, slider value:', pit2.value, '| readout:', rows2.children[0].children[2].children[1].children[1].textContent);
process.exit(0);

/* ============================================================
   transport.js — making play happen when the finger lands

   Two small things sit between pressing play and hearing the first
   beat, and neither of them is audio:

   1. `click` is a touch-END event. On a phone the browser will not
      dispatch it until the finger lifts and it is satisfied the gesture
      was not a scroll or a double-tap, so binding play to it puts the
      whole duration of the tap — commonly 60-120 ms, more if the finger
      lingers — between the gesture and the sound. `pointerdown` fires
      when the finger lands, which is the moment the player means.

   2. The audio context is built on first use. Creating it, wiring the
      graph and resuming it is work that used to happen inside the press
      of play; a brand-new context is also `suspended`, so the first
      start had to book its downbeat far enough ahead to survive an
      asynchronous resume. Doing all of that on the first touch anywhere
      on the page instead means play is pressed against a context that
      is already running, with a warm audio route.

   Both pages want both behaviours, so they live here.
   ============================================================ */

/* Bind a transport control so it fires on finger-down, while still
   working for a keyboard.

   A button activated by Enter or Space emits a `click` with no
   preceding `pointerdown`, so click stays bound — it is simply ignored
   when a pointer press has just handled the same activation. The window
   is generous because a slow tap can hold the two events apart. */
export function bindTransport(el, fn) {
  let viaPointer = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;             // right/middle click is not play
    viaPointer = performance.now();
    fn(e);
  });

  el.addEventListener('click', (e) => {
    if (performance.now() - viaPointer < 1000) return;
    fn(e);
  });

  /* Nothing here calls preventDefault: the button must keep its focus,
     its :active styling and its accessibility behaviour. Suppressing the
     duplicate is a matter for the click handler above. */
}

/* Run `fn` once, on the first user gesture on the page — the first
   moment a context may legally be created and resumed. */
export function warmOnFirstGesture(fn) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    for (const type of types) document.removeEventListener(type, go, opts);
    try { fn(); } catch (e) { /* the first real press will try again */ }
  };
  const types = ['pointerdown', 'touchstart', 'keydown'];
  const opts = { capture: true, passive: true };
  for (const type of types) document.addEventListener(type, go, opts);
}

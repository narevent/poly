/* ============================================================
   haptics.js — an optional physical pulse, shared by both apps

   Off unless asked for. It is switched on once, on the hub, and both
   apps read the same key — so the setting follows you from the launcher
   into whichever app you open, and a change made in one tab reaches the
   other through the storage event.

   WHAT THE HARDWARE WILL ACTUALLY DO
   `navigator.vibrate` is the real API and it works on Android. iOS does
   not implement it at all — no vibration, no error, just a function that
   is not there. The one lever a web page has on an iPhone is the haptic
   Safari plays when a `<input type="checkbox" switch>` is toggled (17.4
   and up), so that is used as the fallback: a hidden switch, flipped.
   It is a genuine tap on iOS 18 but it is a side effect of a control, not
   a vibration API, and it is coarser and less reliable than the Android
   path. The UI says so rather than promising something the phone will
   not deliver.

   WHY EVERYTHING IS RATE LIMITED
   A vibration motor takes tens of milliseconds to spin up and settle. Ask
   for one every 16th note at 180 BPM and it does not produce sixteen
   taps a second, it produces one long smear that drowns the beats you
   could feel. So a pulse inside MIN_GAP of the previous one is dropped —
   the beat survives, the mush does not. Callers pass what the pulse MEANS
   ('beat', 'accent', 'tap', 'miss') and the strength is decided here.
   ============================================================ */

const KEY = 'poly-haptics-v1';

/* Milliseconds of vibration per kind. Short: these are meant to be felt
   as an edge, in time with a click, not as a buzz. */
const PATTERN = {
  accent: 22,       // the downbeat
  beat:   11,       // everything else on the click track
  tap:    9,        // the player's own hit, so touch and sight line up
  miss:   [16, 34, 16],
};

/* Two pulses closer together than this are one pulse as far as the motor
   is concerned, so the second is dropped rather than queued. */
const MIN_GAP = 55;

let enabled = false;
let last = 0;
const listeners = new Set();

/* ------------------------------------------------------------
   support
   ------------------------------------------------------------ */
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

/* Safari 17.4+ ships the `switch` presentation for checkboxes, and toggling
   one plays a haptic on iPhone. Nothing else on the platform will. */
const canSwitch = (() => {
  if (canVibrate || typeof document === 'undefined') return false;
  try { return 'switch' in document.createElement('input'); } catch (e) { return false; }
})();

let switchEl = null;
function switchTap() {
  if (!switchEl) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;' +
                          'opacity:0;pointer-events:none;overflow:hidden';
    switchEl = document.createElement('input');
    switchEl.type = 'checkbox';
    switchEl.setAttribute('switch', '');
    switchEl.tabIndex = -1;
    label.appendChild(switchEl);
    document.body.appendChild(label);
  }
  // the haptic rides on the toggle, so it has to actually change state
  switchEl.click();
}

export function isSupported() { return canVibrate || canSwitch; }

/* One honest sentence for the UI, because "haptics" means three different
   amounts of hardware depending on what you are holding. */
export function supportNote() {
  // The API existing says nothing about there being a motor behind it:
  // desktop Chrome and Firefox both expose vibrate() and do nothing with
  // it. A touch device is the closest honest proxy for "there is hardware".
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
  if (canVibrate && touch) return 'On · your device supports vibration';
  if (canVibrate) return 'On · this machine most likely has no vibration motor';
  if (canSwitch)  return 'On · iPhone gives a lighter system tap, not a true vibration';
  return 'No vibration API in this browser — this will have no effect';
}

/* ------------------------------------------------------------
   the setting
   ------------------------------------------------------------ */
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    return !!JSON.parse(raw).enabled;
  } catch (e) { return false; }
}

enabled = read();

export function isEnabled() { return enabled; }

export function setEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem(KEY, JSON.stringify({ enabled })); } catch (e) { /* private mode */ }
  emit();
  if (enabled) pulse('accent');   // confirm in the medium the setting is about
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(enabled); } catch (e) {} } }

/* A change in another tab — the hub, most likely, with an app still open
   behind it — is the same change. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    const next = read();
    if (next === enabled) return;
    enabled = next;
    emit();
  });
}

/* ------------------------------------------------------------
   firing
   ------------------------------------------------------------ */

/* `kind` is what happened, not how hard to buzz. Returns whether anything
   was actually asked of the hardware. */
export function pulse(kind = 'beat') {
  if (!enabled) return false;
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (t - last < MIN_GAP) return false;
  last = t;
  const p = PATTERN[kind] || PATTERN.beat;
  if (canVibrate) {
    try { navigator.vibrate(p); return true; } catch (e) { return false; }
  }
  if (canSwitch) {
    try { switchTap(); return true; } catch (e) { return false; }
  }
  return false;
}

/* Stop anything in flight — used when playback stops, so a long miss
   pattern does not outlive the thing that caused it. */
export function cancel() {
  if (canVibrate) { try { navigator.vibrate(0); } catch (e) {} }
}

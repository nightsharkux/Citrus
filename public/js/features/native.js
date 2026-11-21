/**
 * The Citrus Android app (android/), when the page runs inside it. The app hands the top page a private message
 * port right after it loads; frames inside the page never get one, and a port posted by a frame is ignored (only
 * the app itself posts with no source window).
 *
 *   native.available()                  inside the app, with the channel ready
 *   native.send('start', { label, target })   record in the background (see features/keep-awake.js)
 *   native.send('stop')
 *   native.send('save', { name, mime, data }) save a file (base64) to Downloads
 *   native.send('immersive', { on })    hide (or show) the system bars while the study sign is up
 *
 * The app tells the page when it goes off and back on screen with the window events "campus-native-background"
 * and "campus-native-foreground".
 */
let port = null;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.data !== 'campus-native' || event.source !== null || !event.ports?.[0] || port) return;
    port = event.ports[0];
    port.start?.();
  });
}

/** True when the page runs in the Android app (by its user agent), even before the channel is ready. */
export const inApp = () => typeof navigator !== 'undefined' && / (?:Citrus|CampusOS)App\//.test(navigator.userAgent || '');

export const native = {
  available: () => !!port,
  send(cmd, data = {}) {
    if (!port) return false;
    try {
      port.postMessage(JSON.stringify({ cmd, ...data }));
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Keeps the phone awake while Campus listens or records, so the screen does not switch off in the middle of a
 * lecture or meeting (that stops the microphone in the browser). Uses the Screen Wake Lock API: Chrome and Edge on
 * Android and computers, Safari on iPhone (16.4+, and in the home-screen app from iOS 18.4).
 *
 * Inside the Citrus Android app (android/), it also starts the app's recording service, which keeps recording
 * with the screen off, in the background and after the app is closed, and sends the audio to `target` to become
 * transcript lines (features/native.js, android/README.md).
 *
 *   const awake = keepAwake({ label: 'Lecture · Week 5', target: '/api/live/sessions/12/audio' });
 *   awake.release();
 */
import { native } from './native.js';

export const canKeepAwake = () => !!globalThis.navigator?.wakeLock || native.available();
/** True inside the Android app, which records in the background on its own. */
export const recordsInBackground = () => native.available();

export function keepAwake({ label = 'Citrus', target = '' } = {}) {
  let lock = null;
  let released = false;
  const request = async () => {
    if (released || lock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        lock = null;
      });
      if (released) lock.release().catch(() => {});
    } catch {
      lock = null; // low battery mode or not allowed: the recording still runs while the screen is on
    }
  };
  // The browser drops the lock whenever the page is hidden; take it again when it comes back.
  const onVisible = () => document.visibilityState === 'visible' && request();
  document.addEventListener('visibilitychange', onVisible);
  request();
  native.send('start', { label, target });
  return {
    release() {
      if (released) return;
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
      lock = null;
      native.send('stop');
    },
    get held() {
      return !!lock;
    },
  };
}

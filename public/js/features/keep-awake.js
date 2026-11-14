/**
 * Keeps the phone awake while Campus listens or records, so the screen does not switch off in the middle of a
 * lecture or meeting (that stops the microphone in the browser). Uses the Screen Wake Lock API: Chrome and Edge on
 * Android and computers, Safari on iPhone (16.4+, and in the home-screen app from iOS 18.4).
 *
 * Inside the Campus OS Android app (android/), the app also starts its recording service, which keeps recording
 * with the screen off and after the app is closed (window.CampusNative, see android/README.md).
 *
 *   const awake = keepAwake({ label: 'Lecture', target: '/api/live/sessions/12/audio' });
 *   awake.release();
 */
const native = () => globalThis.CampusNative || null;

export const canKeepAwake = () => !!globalThis.navigator?.wakeLock || !!native();
/** True inside the Android app, which records in the background on its own. */
export const recordsInBackground = () => !!native()?.startRecording;

export function keepAwake({ label = 'Campus OS', target = '' } = {}) {
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
  try {
    native()?.startRecording?.(JSON.stringify({ label, target }));
  } catch {
    /* an older app without the recording service */
  }
  return {
    release() {
      if (released) return;
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
      lock = null;
      try {
        native()?.stopRecording?.();
      } catch {
        /* nothing to stop */
      }
    },
    get held() {
      return !!lock;
    },
  };
}

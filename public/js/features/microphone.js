/**
 * Which microphone to record from.
 *
 * Bluetooth headphones switch to their hands-free mode while a page records from their microphone: sound becomes
 * narrow and muffled, like a phone call, for everything they play. So when the computer has a microphone of its
 * own, Citrus records from that one and the headphones keep their full sound. When the headphones are the only
 * microphone, the conversation releases it while Citrus talks (features/conversation.js: microphoneMuffles()).
 *
 * Browsers name devices only after microphone permission, so the first recording may still open the headset;
 * openMicrophone() then moves to the computer's microphone at once.
 */

const BLUETOOTH = /bluetooth|hands-?free|airpods|buds|\bbt\b|^(?:default - |communications - )?headset \(/i;
const VIRTUAL = /stereo mix|virtual|vb-audio|voicemeeter|cable (?:in|out)put|steam streaming|blackhole|soundflower|loopback|nvidia broadcast|krisp|\bobs\b|iriun|droidcam/i;
const BUILT_IN = /built-?in|internal|integrated|macbook|imac|microphone array|mikrofonarray|realtek|intel|\bamd\b/i;

/** What the next recording will use: `deviceId` to ask for (null: the default), and whether either is a headset. */
let route = { deviceId: null, bluetooth: false, defaultBluetooth: false };
export const microphoneRoute = () => route;

export const isBluetoothMicrophone = (label) => BLUETOOTH.test(String(label || ''));

/**
 * Choose from a list of audio inputs (enumerateDevices). The default is the one with id "default" (Chrome),
 * otherwise the first. Returns { deviceId, bluetooth, defaultBluetooth }.
 */
export function pickMicrophone(inputs) {
  const named = (inputs || []).filter((d) => d && d.kind === 'audioinput' && d.label);
  if (!named.length) return { deviceId: null, bluetooth: false, defaultBluetooth: false };
  const standard = named.find((d) => d.deviceId === 'default') || named[0];
  if (!isBluetoothMicrophone(standard.label)) return { deviceId: null, bluetooth: false, defaultBluetooth: false };
  const own = named.filter((d) => !['default', 'communications'].includes(d.deviceId) && !isBluetoothMicrophone(d.label) && !VIRTUAL.test(d.label));
  const choice = own.find((d) => BUILT_IN.test(d.label)) || own[0];
  return choice ? { deviceId: choice.deviceId, bluetooth: false, defaultBluetooth: true } : { deviceId: null, bluetooth: true, defaultBluetooth: true };
}

/** Look at the connected microphones again (cheap; no recording). */
export async function chooseMicrophone(mediaDevices = globalThis.navigator?.mediaDevices) {
  let inputs = [];
  try {
    inputs = await mediaDevices.enumerateDevices();
  } catch {
    /* no list: record from the default */
  }
  route = pickMicrophone(inputs);
  return route;
}

/**
 * getUserMedia for speech recognition, on the computer's own microphone when headphones are connected. It asks at
 * once with the last choice (permission prompts belong to the click that started listening) and checks after.
 */
export async function openMicrophone(getUserMedia, constraints, mediaDevices = globalThis.navigator?.mediaDevices) {
  const request = (deviceId) => ({ audio: { ...constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
  const wanted = route.deviceId;
  let stream;
  try {
    stream = await getUserMedia(request(wanted));
  } catch (error) {
    // The chosen microphone was unplugged in the meantime: take the default.
    if (!wanted || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(error?.name)) throw error;
    route = { ...route, deviceId: null, bluetooth: route.defaultBluetooth };
    return noteMicrophone(await getUserMedia(request(null)));
  }
  if (wanted || !isBluetoothMicrophone(stream.getAudioTracks?.()[0]?.label)) return noteMicrophone(stream);
  // It opened the headset (the first recording on this site, before the browser named the microphones, or
  // headphones connected since): move to the computer's own microphone.
  await chooseMicrophone(mediaDevices);
  if (!route.deviceId) return noteMicrophone(stream);
  stream.getTracks().forEach((track) => track.stop());
  try {
    return noteMicrophone(await getUserMedia(request(route.deviceId)));
  } catch {
    route = { ...route, deviceId: null, bluetooth: true };
    return noteMicrophone(await getUserMedia(request(null)));
  }
}

/** Windows (the page's own platform): where a page with the microphone open can have other sound turned down. */
export const onWindows = (nav = globalThis.navigator) => /windows|win32|win64/i.test(String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || ''));

/** What the browser did with the last microphone it opened: for the trouble report. */
let report = null;
export const microphoneReport = () => report;
export function noteMicrophone(stream) {
  try {
    const track = stream?.getAudioTracks?.()[0];
    const s = track?.getSettings?.() || {};
    report = { echoCancellation: s.echoCancellation ?? null, echoCancellationType: s.echoCancellationType ?? null, noiseSuppression: s.noiseSuppression ?? null, autoGainControl: s.autoGainControl ?? null, sampleRate: s.sampleRate ?? null };
  } catch {
    report = null;
  }
  return stream;
}

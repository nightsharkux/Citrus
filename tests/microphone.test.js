'use strict';
/** Bluetooth headphones keep their full sound: speech recognition records from the computer's own microphone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../public/js/features/microphone.js')).href);
const input = (deviceId, label) => ({ kind: 'audioinput', deviceId, label });

test('a Bluetooth default microphone is replaced by the computer’s own on Windows and macOS', async () => {
  const { pickMicrophone } = await load();
  const windows = [
    input('default', 'Default - Headset (WH-1000XM4 Hands-Free AG Audio)'),
    input('communications', 'Communications - Headset (WH-1000XM4 Hands-Free AG Audio)'),
    input('stereo', 'Stereo Mix (Realtek(R) Audio)'),
    input('array', 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)'),
    input('bt', 'Headset (WH-1000XM4 Hands-Free AG Audio)'),
    { kind: 'audiooutput', deviceId: 'out', label: 'Headphones (WH-1000XM4 Stereo)' },
  ];
  assert.deepEqual(pickMicrophone(windows), { deviceId: 'array', bluetooth: false, defaultBluetooth: true });
  const mac = [input('default', 'Default - AirPods Pro (Bluetooth)'), input('pods', 'AirPods Pro (Bluetooth)'), input('mac', 'MacBook Pro Microphone (Built-in)')];
  assert.equal(pickMicrophone(mac).deviceId, 'mac');
  // Firefox and Safari list the default first, without a "default" entry.
  assert.equal(pickMicrophone([input('a', 'AirPods'), input('b', 'Internal Microphone')]).deviceId, 'b');
});

test('other microphones are left alone, and headphones that are the only microphone are reported', async () => {
  const { pickMicrophone, isBluetoothMicrophone } = await load();
  const none = { deviceId: null, bluetooth: false, defaultBluetooth: false };
  assert.deepEqual(pickMicrophone([input('default', 'Default - Microphone Array (Realtek(R) Audio)'), input('bt', 'Headset (Jabra Hands-Free)')]), none);
  assert.deepEqual(pickMicrophone([input('default', 'Default - Headset Microphone (Jabra Evolve 20)')]), none, 'a wired headset keeps its microphone');
  assert.deepEqual(pickMicrophone([input('x', ''), input('y', '')]), none, 'names hidden before permission: the default');
  assert.deepEqual(pickMicrophone([input('default', 'Default - Galaxy Buds2 Pro'), input('cable', 'CABLE Output (VB-Audio Virtual Cable)')]),
    { deviceId: null, bluetooth: true, defaultBluetooth: true });
  assert.ok(isBluetoothMicrophone('Headset (Pixel Buds Pro)'));
  assert.ok(!isBluetoothMicrophone('USB Audio Device'));
});

test('the first recording moves off the headset once the browser names the microphones', async () => {
  const { openMicrophone, microphoneRoute } = await load();
  let named = false;
  const devices = { enumerateDevices: async () => [input('default', named ? 'Default - AirPods (Bluetooth)' : ''), input('mac', named ? 'MacBook Air Microphone' : '')] };
  const opened = [];
  const stopped = [];
  const getUserMedia = async (constraints) => {
    named = true;
    const deviceId = constraints.audio.deviceId?.exact || 'default';
    opened.push(deviceId);
    return { getAudioTracks: () => [{ label: deviceId === 'mac' ? 'MacBook Air Microphone' : 'AirPods (Bluetooth)' }], getTracks: () => [{ stop: () => stopped.push(deviceId) }] };
  };
  await openMicrophone(getUserMedia, { echoCancellation: true }, devices);
  assert.deepEqual(opened, ['default', 'mac']);
  assert.deepEqual(stopped, ['default'], 'the headset microphone is released at once');
  await openMicrophone(getUserMedia, { echoCancellation: true }, devices);
  assert.deepEqual(opened.slice(2), ['mac'], 'later recordings go straight to the computer’s microphone');
  assert.equal(microphoneRoute().bluetooth, false);
});

test('an unplugged choice falls back to the default microphone', async () => {
  const { openMicrophone, chooseMicrophone, microphoneRoute } = await load();
  const devices = { enumerateDevices: async () => [input('default', 'Default - AirPods (Bluetooth)'), input('usb', 'USB Microphone')] };
  assert.equal((await chooseMicrophone(devices)).deviceId, 'usb');
  const opened = [];
  const getUserMedia = async (constraints) => {
    const deviceId = constraints.audio.deviceId?.exact || 'default';
    opened.push(deviceId);
    if (deviceId === 'usb') throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
    return { getAudioTracks: () => [{ label: 'AirPods (Bluetooth)' }], getTracks: () => [] };
  };
  await openMicrophone(getUserMedia, {}, devices);
  assert.deepEqual(opened, ['usb', 'default']);
  assert.equal(microphoneRoute().bluetooth, true, 'the conversation then pauses the microphone while Citrus talks');
});

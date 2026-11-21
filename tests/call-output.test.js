'use strict';
/**
 * Citrus's voice plays as a (local) WebRTC call stream while the microphone stays open, so the browser's echo
 * canceller has its reference; Windows takes turns by default, because a page with the microphone open gets other
 * sound turned down there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, `../public/js/features/${file}`)).href);

// A pair of fake peers: whatever the first adds as a track arrives on the second once both descriptions are set.
function fakePeers({ fail = false } = {}) {
  const peers = [];
  class Peer {
    constructor() {
      this.tracks = [];
      this.closed = false;
      peers.push(this);
    }
    addTrack(track, stream) { this.tracks.push([track, stream]); }
    async createOffer() { return { type: 'offer', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; this.local = d; }
    async setRemoteDescription(d) {
      this.remote = d;
      if (d.type === 'offer' && !fail) {
        const [track, stream] = peers[0].tracks[0];
        queueMicrotask(() => this.ontrack?.({ track, streams: [stream] }));
      }
    }
    close() { this.closed = true; }
    async addIceCandidate() {}
  }
  Peer.peers = peers;
  return Peer;
}

function fakeContext() {
  const connections = [];
  const dest = { stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
  const output = {};
  const ctx = {
    destination: output,
    createMediaStreamDestination: () => dest,
  };
  const source = {
    connect: (to) => connections.push(['connect', to === dest ? 'call' : 'speakers']),
    disconnect: (to) => connections.push(['disconnect', to === dest ? 'call' : 'speakers']),
  };
  return { ctx, source, connections };
}

class FakeAudio {
  constructor() { this.style = {}; FakeAudio.last = this; }
  play() { return Promise.resolve(); }
  pause() {}
  remove() { this.removed = true; }
}

test('Opus is asked for mono speech with error correction', async () => {
  const { tuneOpus } = await load('call-output.js');
  const tuned = tuneOpus('a=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:111 opus/48000/2\r\n');
  assert.match(tuned, /a=fmtp:111 [^\r\n]*stereo=0/);
  assert.match(tuned, /maxaveragebitrate=64000/);
  assert.match(tuned, /useinbandfec=1/);
  assert.equal((tuned.match(/minptime/g) || []).length, 1, 'no setting is repeated');
  assert.equal(tuneOpus('a=fmtp:96 profile-level-id=1\r\n'), 'a=fmtp:96 profile-level-id=1\r\n', 'other codecs are untouched');
});

test('the voice moves onto the call stream once it is connected, and back to the speakers when released', async () => {
  const { createCallOutput } = await load('call-output.js');
  const { ctx, source, connections } = fakeContext();
  const Peer = fakePeers();
  const out = createCallOutput(ctx, source, { PeerConnection: Peer, AudioElement: FakeAudio, timeout: 500 });
  assert.equal(out.active, false);
  out.engage(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out.active, true, 'connected');
  assert.deepEqual(connections, [['disconnect', 'speakers'], ['connect', 'call']]);
  assert.equal(FakeAudio.last.autoplay, true, 'the remote stream is played by an audio element');
  assert.match(Peer.peers[0].local.sdp, /stereo=0/);

  out.engage(false);
  assert.equal(out.active, false);
  assert.deepEqual(connections.slice(2), [['disconnect', 'call'], ['connect', 'speakers']]);
  assert.ok(Peer.peers.every((p) => p.closed), 'both peers are closed');
  assert.equal(FakeAudio.last.removed, true);
});

test('if the call never connects, the voice stays on the speakers', async () => {
  const { createCallOutput } = await load('call-output.js');
  const { ctx, source, connections } = fakeContext();
  const out = createCallOutput(ctx, source, { PeerConnection: fakePeers({ fail: true }), AudioElement: FakeAudio, timeout: 40 });
  out.engage(true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(out.active, false);
  assert.ok(!connections.some(([, to]) => to === 'call'), 'nothing was moved');
});

test('releasing before it connects never moves the voice', async () => {
  const { createCallOutput } = await load('call-output.js');
  const { ctx, source, connections } = fakeContext();
  const out = createCallOutput(ctx, source, { PeerConnection: fakePeers(), AudioElement: FakeAudio, timeout: 500 });
  out.engage(true);
  out.engage(false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(out.active, false);
  assert.ok(!connections.some(([action, to]) => action === 'connect' && to === 'call'));
});

test('Windows is recognised from the platform, and other computers are not', async () => {
  const { onWindows } = await load('microphone.js');
  assert.equal(onWindows({ userAgentData: { platform: 'Windows' } }), true);
  assert.equal(onWindows({ platform: 'Win32' }), true);
  assert.equal(onWindows({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), true);
  assert.equal(onWindows({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), false);
  assert.equal(onWindows({ platform: 'Linux x86_64', userAgent: 'X11; Linux' }), false);
  assert.equal(onWindows({}), false);
});

test('the browser’s own echo canceller is recorded for the trouble report', async () => {
  const { noteMicrophone, microphoneReport } = await load('microphone.js');
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true, echoCancellationType: 'browser', noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }) }] };
  assert.equal(noteMicrophone(stream), stream, 'the stream is passed on');
  assert.deepEqual(microphoneReport(), { echoCancellation: true, echoCancellationType: 'browser', noiseSuppression: true, autoGainControl: true, sampleRate: 48000 });
  noteMicrophone({ getAudioTracks: () => { throw new Error('gone'); } });
  assert.equal(microphoneReport(), null);
});

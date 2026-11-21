/**
 * Play Citrus's voice the way a video call plays the other person: as a WebRTC audio stream.
 *
 * Meet, Zoom and Teams get clean conversations with the microphone open because the browser's echo canceller knows
 * exactly what is being played: audio that arrives over WebRTC is its reference. Sound produced by the Web Audio
 * API is not always treated that way, and on Windows the canceller then guesses and can squash the voice (and
 * Windows may turn other sound down while a page records). The AI gateway's live voice is a WebSocket, so there is
 * no WebRTC connection to the provider to use. This does the next best thing, entirely inside the browser: the
 * voice goes through a local WebRTC connection (two peers in the page, nothing leaves the computer) and is played
 * by an audio element from the "remote" stream.
 *
 * It is only used while the microphone stays open when Citrus talks. When the microphone is released instead
 * (phones, Windows by default), the direct path is better: no codec and no extra delay.
 */

const SETTINGS = 'minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000';

/** Ask Opus for mono speech at a fixed bitrate, with forward error correction. */
export function tuneOpus(sdp) {
  return String(sdp).replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, pt, params) => (/minptime|useinbandfec/.test(params) ? `a=fmtp:${pt} ${params.split(';').filter((p) => !/^(minptime|useinbandfec|stereo|sprop-stereo|maxaveragebitrate)=/.test(p.trim())).concat(SETTINGS).join(';')}` : line));
}

export const callOutputSupported = () => {
  try {
    if (localStorage.getItem('citrus.callOutput') === 'off') return false;
  } catch { /* no storage: allowed */ }
  return typeof RTCPeerConnection === 'function' && typeof MediaStream === 'function' && typeof Audio === 'function';
};

/**
 * @param ctx     the AudioContext
 * @param source  the last node of the voice graph (it is connected to ctx.destination meanwhile)
 * @param globals { RTCPeerConnection, Audio } for tests
 * Returns { engage(on), active }. engage(true) starts the call path and moves the voice onto it once connected;
 * engage(false) moves it back and closes the connection. If the connection does not come up in time, nothing changes.
 */
export function createCallOutput(ctx, source, { PeerConnection = globalThis.RTCPeerConnection, AudioElement = globalThis.Audio, timeout = 2500 } = {}) {
  let dest = null;
  let a = null;
  let b = null;
  let el = null;
  let on = false;
  let wanted = false;
  let attempt = 0;
  let timer = 0;

  const toCall = () => {
    if (on || !dest) return;
    try { source.disconnect(ctx.destination); } catch { /* not connected */ }
    source.connect(dest);
    on = true;
  };
  const toDirect = () => {
    if (!on) return;
    try { source.disconnect(dest); } catch { /* not connected */ }
    source.connect(ctx.destination);
    on = false;
  };
  const close = () => {
    clearTimeout(timer);
    toDirect();
    for (const pc of [a, b]) {
      try { pc?.close(); } catch { /* already closed */ }
    }
    if (el) {
      el.pause?.();
      el.srcObject = null;
      el.remove?.();
    }
    a = b = el = dest = null;
  };

  async function open() {
    const mine = ++attempt;
    try {
      dest = ctx.createMediaStreamDestination();
      a = new PeerConnection();
      b = new PeerConnection();
      a.onicecandidate = (e) => e.candidate && b?.addIceCandidate(e.candidate).catch(() => {});
      b.onicecandidate = (e) => e.candidate && a?.addIceCandidate(e.candidate).catch(() => {});
      const connected = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('no call connection')), timeout);
        b.ontrack = (e) => {
          el = new AudioElement();
          el.autoplay = true;
          el.srcObject = e.streams[0] || new MediaStream([e.track]);
          el.style.display = 'none';
          globalThis.document?.body?.append?.(el);
          el.play?.().then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
        };
        b.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(b?.connectionState) && on) {
            // The connection dropped while speaking: the direct path keeps Citrus audible.
            toDirect();
            wanted = false;
          }
        };
      });
      connected.catch(() => {}); // handled below; a close before the answer must not leave it unhandled
      for (const track of dest.stream.getAudioTracks()) a.addTrack(track, dest.stream);
      const offer = await a.createOffer();
      await a.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp) });
      await b.setRemoteDescription(a.localDescription);
      const answer = await b.createAnswer();
      await b.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp) });
      await a.setRemoteDescription(b.localDescription);
      await connected;
      if (mine !== attempt || !wanted) return close();
      toCall();
    } catch {
      if (mine === attempt) close();
      wanted = false;
    }
  }

  return {
    engage(flag) {
      if (flag === wanted) return;
      wanted = !!flag;
      if (wanted) open();
      else {
        attempt += 1;
        close();
      }
    },
    get active() {
      return on;
    },
  };
}

/**
 * Meeting recorder: MediaRecorder + a live level meter drawn on a canvas.
 *
 * Every second of audio is also kept on this phone (features/recording-store.js), so closing the app or losing the
 * connection never loses the recording, and the screen is kept awake while it records. When it stops, the recording
 * goes to /api/workspaces/:id/recordings; when the server cannot keep audio (or the upload fails), it is saved to
 * the phone instead and stays listed under "On this phone".
 */
import { api } from '../core/api.js';
import { keepAwake } from './keep-awake.js';
import { beginTake, addChunk, takeBlob, dropTake, takeName } from './recording-store.js';
import { saveFile } from './notes-export.js';

export function createRecorder({ workspaceId, title = 'Meeting', canvas, onTick, onSaved, onKept, onError }) {
  let media = null;
  let stream = null;
  let audioCtx = null;
  let raf = 0;
  let started = 0;
  let timer = 0;
  let awake = null;
  let take = null;

  function draw(analyser) {
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = 36;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6B5CFF';
    const loop = () => {
      analyser.getByteFrequencyData(data);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const w = width / bars;
      for (let i = 0; i < bars; i += 1) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const h = Math.max(4, v * height * 0.9);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35 + v * 0.65;
        const x = i * w + w * 0.2;
        const r = Math.min(w * 0.3, 3);
        ctx.beginPath();
        ctx.roundRect(x, (height - h) / 2, w * 0.6, h, r);
        ctx.fill();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Recording needs a modern browser over HTTPS (or localhost).');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
    media = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    take = await beginTake({ workspaceId, title, mime: media.mimeType || mime || 'audio/webm' });
    media.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      addChunk(take, e.data, Math.floor((Date.now() - started) / 1000)).catch(() => {});
    };
    media.onstop = async () => {
      cleanup();
      const type = (media.mimeType || 'audio/webm').split(';')[0];
      const blob = take ? (await takeBlob(take)) || new Blob(chunks, { type }) : new Blob(chunks, { type });
      try {
        const result = await api.upload(`/workspaces/${workspaceId}/recordings`, blob);
        await api.post(`/workspaces/${workspaceId}/recording-signal`, { active: false }).catch(() => {});
        if (take) await dropTake(take);
        onSaved?.(result);
      } catch (error) {
        // The server has no room for audio (or the upload failed): the recording goes to the phone and stays listed.
        await api.post(`/workspaces/${workspaceId}/recording-signal`, { active: false }).catch(() => {});
        saveFile(blob, takeName({ title, mime: type, started: new Date(started).toISOString() }));
        onKept?.(error);
      }
      take = null;
    };
    media.start(1000);
    started = Date.now();
    awake = keepAwake({ label: `Recording · ${title}` });
    timer = setInterval(() => onTick?.(Math.floor((Date.now() - started) / 1000)), 500);
    await api.post(`/workspaces/${workspaceId}/recording-signal`, { active: true }).catch(() => {});

    if (canvas && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      draw(analyser);
    }
  }

  function cleanup() {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    awake?.release();
    awake = null;
  }

  return {
    start,
    stop: () => media && media.state !== 'inactive' && media.stop(),
    get recording() {
      return !!media && media.state === 'recording';
    },
    destroy() {
      if (media && media.state !== 'inactive') media.stop();
      else cleanup();
    },
  };
}

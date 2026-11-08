/**
 * Meeting recorder: MediaRecorder + a live level meter drawn on a canvas.
 * Uploads to /api/workspaces/:id/recordings when stopped.
 */
import { api } from '../core/api.js';

export function createRecorder({ workspaceId, canvas, onTick, onSaved, onError }) {
  let media = null;
  let stream = null;
  let audioCtx = null;
  let raf = 0;
  let started = 0;
  let timer = 0;

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
    media.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    media.onstop = async () => {
      cleanup();
      const blob = new Blob(chunks, { type: (media.mimeType || 'audio/webm').split(';')[0] });
      try {
        const result = await api.upload(`/workspaces/${workspaceId}/recordings`, blob);
        await api.post(`/workspaces/${workspaceId}/recording-signal`, { active: false }).catch(() => {});
        onSaved?.(result);
      } catch (error) {
        onError?.(error);
      }
    };
    media.start(1000);
    started = Date.now();
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

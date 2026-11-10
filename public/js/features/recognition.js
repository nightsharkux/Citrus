import { openMicrophone } from './microphone.js';

/** Deepgram stream adapted to the Web Speech result shape used by wake word, dictation and captions. */
export const MICROPHONE_AUDIO = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });

export class DeepgramRecognition {
  constructor({ requestSession, getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
    Recorder = globalThis.MediaRecorder, Socket = globalThis.WebSocket, onFailure = () => {}, mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
    Object.assign(this, { requestSession, getUserMedia, Recorder, Socket, onFailure, mediaDevices });
    this.continuous = true;
    this.lang = 'multi';
    this.interimResults = true;
    this.active = false;
  }

  start() {
    if (this.active) throw new Error('Recognition is already running');
    this.active = true;
    this.generation = (this.generation || 0) + 1;
    this.stopping = false;
    this.finals = [];
    this.finalKeys = new Set();
    this.controller = new AbortController();
    this.open(this.generation);
  }

  async open(generation) {
    try {
      const stream = await openMicrophone(this.getUserMedia, MICROPHONE_AUDIO, this.mediaDevices);
      if (!this.active || generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      // Obtain the short-lived grant after microphone permission, which can take longer than its TTL.
      const language = /^de\b/i.test(this.lang) ? 'de' : /^en\b/i.test(this.lang) ? 'en' : 'multi';
      const grant = await this.requestSession(language, this.controller.signal);
      if (!this.active || generation !== this.generation) return;
      const url = new URL(grant.url);
      if (!['api.eu.deepgram.com', 'api.deepgram.com'].includes(url.hostname) || url.protocol !== 'wss:' || url.pathname !== '/v1/listen') throw new Error('Invalid speech endpoint');
      const socket = this.socket = new this.Socket(url.href, ['bearer', grant.token]);
      this.connectTimer = setTimeout(() => this.fail('network'), 10000);
      socket.onopen = () => {
        if (!this.active) return;
        clearTimeout(this.connectTimer);
        try {
          const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => this.Recorder.isTypeSupported(type));
          const recorder = this.recorder = new this.Recorder(stream, mimeType ? { mimeType } : {});
          recorder.ondataavailable = (e) => {
            if (e.data.size && socket.readyState === 1) {
              if (socket.bufferedAmount > 1000000) { this.fail('network'); return; }
              socket.send(e.data);
            }
          };
          recorder.onstop = () => {
            // The recorder's final container fragment must arrive before CloseStream.
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'CloseStream' }));
          };
          recorder.onerror = () => this.fail('audio-capture');
          recorder.start(100);
          this.keepAlive = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'KeepAlive' })); }, 5000);
          this.rotation = setTimeout(() => this.stop(), 120000);
          this.onstart?.();
        } catch { this.fail('audio-capture'); }
      };
      socket.onmessage = (event) => {
        if (!this.active) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'Error') { this.fail('network'); return; }
        if (data.type === 'SpeechStarted') { this.onactivity?.({ speaking: true }); return; }
        if (data.type !== 'Results') return;
        const alternative = data.channel?.alternatives?.[0];
        const transcript = alternative?.transcript?.trim();
        if (transcript) {
          const result = [{ transcript, confidence: alternative.confidence || 0 }];
          result.isFinal = !!data.is_final;
          const resultIndex = this.finals.length;
          const key = `${data.start}:${data.duration}`;
          if (result.isFinal) {
            if (this.finalKeys.has(key)) return;
            this.finalKeys.add(key);
            this.finals.push(result);
          }
          const results = result.isFinal ? [...this.finals] : [...this.finals, result];
          if (result.isFinal || this.interimResults) this.onresult?.({ results, resultIndex });
        }
        if (data.speech_final) this.onactivity?.({ speaking: false });
        if (!this.continuous && data.speech_final && this.finals.length) this.stop();
      };
      socket.onerror = () => this.fail('network');
      socket.onclose = () => {
        if (!this.active) return;
        if (!this.stopping) this.fail('network');
        else this.finish();
      };
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      this.fail(error.name === 'NotAllowedError' ? 'not-allowed' : error.name === 'NotFoundError' ? 'audio-capture' : 'network');
    }
  }

  fail(error) {
    if (!this.active) return;
    if (error === 'network') this.onFailure();
    try { this.onerror?.({ error }); } finally { this.finish(); }
  }

  stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    if (this.recorder?.state === 'recording') {
      this.recorder.stop();
      this.stream?.getTracks().forEach((track) => track.stop());
      this.closeTimer = setTimeout(() => this.finish(), 2500);
    } else this.finish();
  }

  abort() { this.finish(); }

  finish() {
    if (!this.active) return;
    this.active = false;
    this.controller?.abort();
    clearTimeout(this.connectTimer); clearTimeout(this.closeTimer); clearTimeout(this.rotation); clearInterval(this.keepAlive);
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state === 'recording') this.recorder.stop();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
      if (this.socket.readyState < 2) this.socket.close();
    }
    this.onend?.();
  }
}

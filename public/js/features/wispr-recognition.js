import { DeepgramRecognition, MICROPHONE_AUDIO } from './recognition.js';
import { openMicrophone } from './microphone.js';

/** Wispr edits the whole utterance. Commit on a natural pause, then emit its final text exactly once. */
export class WisprRecognition extends DeepgramRecognition {
  constructor(options = {}) {
    super(options);
    this.Audio = options.Audio || globalThis.AudioContext || globalThis.webkitAudioContext;
    this.Worklet = options.Worklet || globalThis.AudioWorkletNode;
  }
  async open(generation) {
    const live = () => this.active && generation === this.generation;
    try {
      const stream = await openMicrophone(this.getUserMedia, MICROPHONE_AUDIO, this.mediaDevices);
      if (!live()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const context = this.context = new this.Audio({ sampleRate: 16000 });
      if (context.sampleRate !== 16000) throw new Error('Unsupported capture rate');
      await context.audioWorklet.addModule('/js/features/pcm-worklet.js');
      if (!live()) return;
      await context.resume();
      if (!live()) return;
      const language = /^de\b/i.test(this.lang) ? 'de' : /^en\b/i.test(this.lang) ? 'en' : 'multi';
      const grant = await this.requestSession(language, this.controller.signal);
      if (!live()) return;
      const url = new URL(grant.url);
      if (url.origin !== 'wss://platform-api.wisprflow.ai' || url.pathname !== '/api/v1/dash/client_ws') throw new Error('Invalid speech endpoint');
      url.searchParams.set('client_key', `Bearer ${grant.token}`);
      const socket = this.socket = new this.Socket(url.href);
      this.connectTimer = setTimeout(() => this.fail('network'), 10000);
      let position = 0; let voiced = 0; let silence = 0; let spoke = false; let committed = false;
      const guarded = (fn) => (...args) => {
        if (!live()) return;
        try { fn(...args); } catch { this.fail('network'); }
      };
      socket.onopen = guarded(() => socket.send(JSON.stringify({ type: 'auth', access_token: grant.token, language: grant.language, context: grant.context })));
      socket.onmessage = guarded(({ data }) => {
        if (!live()) return;
        let response; try { response = JSON.parse(data); } catch { return; }
        if (response.status === 'error' || response.error) { this.fail('network'); return; }
        if (response.status === 'auth') {
          if (this.processor) return;
          clearTimeout(this.connectTimer);
          const processor = this.processor = new this.Worklet(context, 'campus-pcm');
          processor.onprocessorerror = guarded(() => this.fail('network'));
          const source = this.input = context.createMediaStreamSource(stream);
          const silent = this.silent = context.createGain(); silent.gain.value = 0;
          source.connect(processor); processor.connect(silent).connect(context.destination);
          processor.port.onmessage = guarded(({ data: packet }) => {
            if (committed || socket.readyState !== 1) return;
            if (packet.flushed) {
              committed = true;
              socket.send(JSON.stringify({ type: 'commit', total_packets: position }));
              return;
            }
            if (socket.bufferedAmount > 1000000) { this.fail('network'); return; }
            const encoded = btoa(String.fromCharCode(...new Uint8Array(packet.pcm)));
            socket.send(JSON.stringify({ type: 'append', position: position++, audio_packets: { packets: [encoded], volumes: [packet.volume], packet_duration: 0.05, audio_encoding: 'wav', byte_encoding: 'base64' } }));
            if (packet.volume >= 0.012) { voiced++; silence = 0; if (voiced >= 2) spoke = true; }
            else { silence++; voiced = 0; }
            if (!this.stopping && spoke && silence >= 20) this.stop();
          });
          this.rotation = setTimeout(() => spoke ? this.stop() : this.finish(), 90000);
          this.onstart?.();
        } else if (response.status === 'text' && response.final === true) {
          // Wispr's partials can be widely spaced and rewritten. Only a committed result may trigger an app command.
          const transcript = typeof response.body?.text === 'string' ? response.body.text.trim() : '';
          if (!transcript) { this.finish(); return; }
          const result = [{ transcript, confidence: 0 }];
          result.isFinal = true;
          try { this.onresult?.({ results: [result], resultIndex: 0 }); }
          finally { if (live()) this.finish(); }
        }
      });
      socket.onerror = () => this.fail('network');
      socket.onclose = () => { if (live()) this.fail('network'); };
    } catch (error) {
      if (live()) this.fail(error.name === 'NotAllowedError' ? 'not-allowed' : error.name === 'NotFoundError' ? 'audio-capture' : 'network');
    }
  }
  stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (!this.processor || this.socket?.readyState !== 1) { this.finish(); return; }
    this.processor.port.postMessage('flush');
    this.closeTimer = setTimeout(() => this.fail('network'), 8000);
  }
  finish() {
    if (this.processor) {
      this.processor.port.onmessage = this.processor.onprocessorerror = null;
      this.processor.port.close?.(); this.processor.disconnect(); this.processor = null;
    }
    this.input?.disconnect(); this.silent?.disconnect();
    this.input = this.silent = null;
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }
    super.finish();
  }
}

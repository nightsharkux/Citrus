import { WisprRecognition } from './wispr-recognition.js';
import { MICROPHONE_AUDIO } from './recognition.js';
import { openMicrophone } from './microphone.js';
import { gatewaySocket } from './gateway-audio.js';

/** OpenAI live transcription through Gateway, adapted to the app's Web Speech interface. */
export class GatewayRecognition extends WisprRecognition {
  async open(generation) {
    const live = () => this.active && this.generation === generation;
    this.endpointSilenceMs = 0;
    try {
      const stream = await openMicrophone(this.getUserMedia, MICROPHONE_AUDIO, this.mediaDevices);
      if (!live()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const context = this.context = new this.Audio({ sampleRate: 24000 });
      if (context.sampleRate !== 24000) throw new Error('Unsupported capture rate');
      await context.audioWorklet.addModule('/js/features/pcm-worklet.js');
      if (!live()) return;
      await context.resume();
      if (!live()) return;
      const language = /^de\b/i.test(this.lang) ? 'de' : /^en\b/i.test(this.lang) ? 'en' : 'multi';
      const grant = await this.requestSession(language, this.controller.signal);
      if (!live()) return;
      const socket = this.socket = gatewaySocket(grant, 'transcription', this.Socket);
      this.connectTimer = setTimeout(() => this.fail('network'), 10000);
      this.transcripts = new Map();
      const guarded = (fn) => (...args) => {
        if (!live()) return;
        try { fn(...args); } catch { this.fail('network'); }
      };
      socket.onopen = guarded(() => {
        socket.send(JSON.stringify({ type: 'transcription-stream.start', inputAudioFormat: { type: 'audio/pcm', rate: 24000 }, providerOptions: grant.options }));
      });
      let voiced = 0; let silence = 0; let spoke = false;
      socket.onmessage = guarded(({ data }) => {
        const part = JSON.parse(data);
        if (part.type === 'error') return this.fail('network');
        if (part.type === 'stream-start') {
          if (this.processor) return;
          clearTimeout(this.connectTimer);
          const processor = this.processor = new this.Worklet(context, 'campus-pcm', { processorOptions: { frameSamples: 1200 } });
          processor.onprocessorerror = guarded(() => this.fail('network'));
          this.input = context.createMediaStreamSource(stream);
          this.silent = context.createGain(); this.silent.gain.value = 0;
          this.input.connect(processor); processor.connect(this.silent).connect(context.destination);
          processor.port.onmessage = guarded(({ data: packet }) => {
            if (socket.readyState !== 1) return;
            if (packet.flushed) { socket.send(JSON.stringify({ type: 'transcription-stream.audio-done' })); return; }
            if (socket.bufferedAmount > 1000000) return this.fail('network');
            socket.send(packet.pcm);
            // Commit the live transcript after a pause. No browser language guessing or whole-file upload.
            if (packet.volume >= 0.008) { voiced++; silence = 0; if (voiced >= 2) spoke = true; }
            else { silence++; voiced = 0; }
            if (!this.stopping && spoke && silence >= 14) { this.endpointSilenceMs = 700; this.stop(); }
          });
          this.rotation = setTimeout(() => this.stop(), 90000);
          this.onstart?.();
        } else if (['transcript-delta', 'transcript-partial', 'transcript-final'].includes(part.type)) {
          const id = part.id || 'utterance';
          let entry = this.transcripts.get(id);
          if (!entry) { entry = { text: '', final: false }; this.transcripts.set(id, entry); }
          if (entry.final) return;
          if (part.type === 'transcript-delta' && typeof part.delta === 'string') entry.text += part.delta;
          else if (typeof part.text === 'string') entry.text = part.text;
          entry.final = part.type === 'transcript-final';
          this.emitTranscripts([...this.transcripts.keys()].indexOf(id));
          if (!this.continuous && entry.final) this.stop();
        } else if (part.type === 'finish') {
          if (typeof part.text === 'string' && part.text.trim()) {
            // finish.text covers the whole stream. Finalize pending entries without repeating earlier finals.
            if (!this.transcripts.size) this.transcripts.set('complete', { text: part.text, final: false });
            const entries = [...this.transcripts.values()];
            const pending = entries.findIndex((entry) => !entry.final);
            if (pending >= 0) {
              if (entries.length === 1) entries[0].text = part.text;
              entries.forEach((entry) => { entry.final = true; });
              this.emitTranscripts(pending);
            }
          }
          this.finish();
        }
      });
      socket.onerror = () => this.fail('network');
      socket.onclose = () => { if (live()) this.fail('network'); };
    } catch (error) {
      if (live()) this.fail(error.name === 'NotAllowedError' ? 'not-allowed' : error.name === 'NotFoundError' ? 'audio-capture' : 'network');
    }
  }

  emitTranscripts(resultIndex = 0) {
    const results = [...this.transcripts.values()].filter((entry) => entry.text.trim()).map((entry) => {
      const result = [{ transcript: entry.text.trim(), confidence: 0 }];
      result.isFinal = entry.final;
      return result;
    });
    if (!results.length || (!this.interimResults && !results.every((result) => result.isFinal))) return;
    results.silenceMs = this.endpointSilenceMs || 0;
    this.onresult?.({ results, resultIndex });
  }
}

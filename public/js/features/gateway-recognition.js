import { WisprRecognition } from './wispr-recognition.js';
import { MICROPHONE_AUDIO } from './recognition.js';
import { openMicrophone } from './microphone.js';
import { gatewaySocket } from './gateway-audio.js';
import { endOfTurnDelay } from './turns.js';

const SAMPLE_RATE = 24000;
const MAX_QUEUED_BYTES = SAMPLE_RATE * 2 * 10;
const SPEECH_LEVEL = 0.003;

/** Keep capture running across utterances. Only explicit stop/abort or failure releases the microphone. */
export class GatewayRecognition extends WisprRecognition {
  async open(generation) {
    this.segments = new Set(); this.entries = []; this.audioQueue = []; this.queuedBytes = 0;
    this.clock = 0; this.lastVoice = -Infinity; this.speaking = false; this.segmentCount = 0;
    this.segment = this.finalizing = null; this.inputFlushed = false; this.lastSilenceMs = 0;
    const live = () => this.active && this.generation === generation;
    try {
      const stream = await openMicrophone(this.getUserMedia, MICROPHONE_AUDIO, this.mediaDevices);
      if (!live()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const context = this.context = new this.Audio({ sampleRate: SAMPLE_RATE });
      if (context.sampleRate !== SAMPLE_RATE) throw new Error('Unsupported capture rate');
      await context.audioWorklet.addModule('/js/features/pcm-worklet.js');
      if (!live()) return;
      await context.resume();
      if (!live()) return;
      const processor = this.processor = new this.Worklet(context, 'campus-pcm', { processorOptions: { frameSamples: 1200 } });
      processor.onprocessorerror = () => { if (live()) this.fail('network'); };
      processor.port.onmessage = ({ data }) => {
        if (!live()) return;
        try { this.packet(data); } catch { this.fail('network'); }
      };
      this.input = context.createMediaStreamSource(stream);
      this.silent = context.createGain(); this.silent.gain.value = 0;
      this.input.connect(processor); processor.connect(this.silent).connect(context.destination);
      // Capture before requesting a grant: words spoken during setup are queued rather than lost.
      this.onstart?.();
      if (live()) this.connectSegment(generation);
    } catch (error) {
      if (live()) this.fail(error.name === 'NotAllowedError' ? 'not-allowed' : error.name === 'NotFoundError' ? 'audio-capture' : 'network');
    }
  }

  async connectSegment(generation) {
    const live = () => this.active && this.generation === generation;
    if (!live()) return;
    // Bound a very long wake-word session as well as its transcript history.
    if (++this.segmentCount > 128) { this.finish(); return; }
    const segment = { map: new Map(), ready: false, ending: false, done: false, hasSpeech: false, voiced: 0, lastVoice: this.clock, lastText: this.clock, silenceMs: 0 };
    this.segments.add(segment); this.segment = segment;
    for (const packet of this.audioQueue) this.observe(segment, packet);
    try {
      const language = /^de\b/i.test(this.lang) ? 'de' : /^en\b/i.test(this.lang) ? 'en' : 'multi';
      const grant = await this.requestSession(language, this.controller.signal);
      if (!live()) return;
      const socket = this.socket = segment.socket = gatewaySocket(grant, 'transcription', this.Socket);
      segment.timer = setTimeout(() => this.fail('network'), 10000);
      const guarded = (fn) => (...args) => {
        if (!live() || !this.segments.has(segment)) return;
        try { fn(...args); } catch { this.fail('network'); }
      };
      socket.onopen = guarded(() => socket.send(JSON.stringify({ type: 'transcription-stream.start', inputAudioFormat: { type: 'audio/pcm', rate: SAMPLE_RATE }, providerOptions: grant.options })));
      socket.onmessage = guarded(({ data }) => {
        const part = JSON.parse(data);
        if (part.type === 'error') return this.fail('network');
        if (part.type === 'stream-start') {
          if (segment.ready) return;
          clearTimeout(segment.timer); segment.ready = true;
          const queued = this.audioQueue; this.audioQueue = []; this.queuedBytes = 0;
          for (const packet of queued) this.sendAudio(segment, packet.pcm);
          this.rotation = setTimeout(() => this.commit(), 90000);
          if (this.inputFlushed) this.sendDone(segment);
          else if (segment.commitRequested) this.commit();
        } else if (['transcript-delta', 'transcript-partial', 'transcript-final'].includes(part.type)) {
          const id = part.id || 'utterance';
          let entry = segment.map.get(id);
          if (!entry) { entry = { text: '', final: false, index: this.entries.length }; segment.map.set(id, entry); this.entries.push(entry); }
          if (entry.final) return;
          const before = entry.text;
          if (part.type === 'transcript-delta' && typeof part.delta === 'string') entry.text += part.delta;
          else if (typeof part.text === 'string') entry.text = part.text;
          entry.final = part.type === 'transcript-final';
          if (entry.text.trim()) segment.hasSpeech = true;
          if (entry.text !== before && !segment.ending) segment.lastText = this.clock;
          this.emitTranscripts(entry.index);
        } else if (part.type === 'finish') {
          if (!segment.done) return this.fail('network');
          if (typeof part.text !== 'string') return this.fail('network');
          const entries = [...segment.map.values()];
          let changed = this.entries.length;
          if (typeof part.text === 'string' && part.text.trim()) {
            if (!entries.length) {
              const entry = { text: part.text, final: false, index: this.entries.length };
              this.entries.push(entry); entries.push(entry);
            }
            for (const entry of entries) if (!entry.final) {
              if (entries.length === 1) entry.text = part.text;
              entry.final = true; changed = Math.min(changed, entry.index);
            }
          } else for (const entry of entries) if (!entry.final) {
            // An empty final rejects an uncertain partial (for example noise mistaken for words).
            entry.text = ''; entry.final = true; changed = Math.min(changed, entry.index);
          }
          this.lastSilenceMs = segment.silenceMs;
          this.closeSegment(segment);
          if (this.segment === segment) this.segment = null;
          if (this.finalizing === segment) this.finalizing = null;
          const queuedSpeech = this.audioQueue.some((packet) => packet.volume >= SPEECH_LEVEL);
          const continueCapture = !this.stopping && (this.continuous || queuedSpeech);
          const drainBuffered = this.stopping && this.audioQueue.length > 0;
          if (continueCapture || drainBuffered) this.connectSegment(generation);
          this.emitTranscripts(changed);
          if (!continueCapture && !drainBuffered) this.finish();
        }
      });
      socket.onerror = guarded(() => this.fail('network'));
      socket.onclose = guarded(() => this.fail('network'));
    } catch { if (live()) this.fail('network'); }
  }

  observe(segment, packet) {
    if (packet.volume >= SPEECH_LEVEL) {
      segment.lastVoice = packet.at; segment.voiced += packet.duration;
      if (segment.voiced >= 100) segment.hasSpeech = true;
    } else segment.voiced = 0;
  }

  packet(packet) {
    if (packet.flushed || packet.drained) {
      if (packet.flushed) this.inputFlushed = true;
      if (this.segment?.ready) this.sendDone(this.segment);
      return;
    }
    if (!(packet.pcm instanceof ArrayBuffer)) return;
    const duration = packet.pcm.byteLength / (SAMPLE_RATE * 2 / 1000);
    this.clock += duration;
    const frame = { ...packet, duration, at: this.clock };
    if (packet.volume >= SPEECH_LEVEL) this.lastVoice = this.clock;
    const speaking = this.clock - this.lastVoice < 250;
    const activityChanged = speaking !== this.speaking;
    this.speaking = speaking;
    const segment = this.segment;
    if (segment) this.observe(segment, frame);
    if (segment?.ready && !segment.done) this.sendAudio(segment, packet.pcm);
    else {
      this.audioQueue.push(frame); this.queuedBytes += packet.pcm.byteLength;
      if (this.queuedBytes > MAX_QUEUED_BYTES) return this.fail('network');
    }
    if (activityChanged) {
      this.emitTranscripts(this.entries.length);
      this.onactivity?.({ speaking });
    }
    if (!segment?.ready || segment.ending || this.stopping || !segment.hasSpeech) return;
    const text = [...segment.map.values()].map((entry) => entry.text).join(' ').trim();
    const quiet = this.clock - Math.max(segment.lastVoice, segment.lastText);
    const pause = text ? endOfTurnDelay(text) : 5000;
    if (quiet >= pause) { segment.silenceMs = quiet; this.commit(); }
  }

  sendAudio(segment, pcm) {
    if (segment.socket.bufferedAmount > 1000000) throw new Error('Audio connection is too slow');
    segment.socket.send(pcm);
  }

  /** Finish the current transcription turn without closing capture. Used by Send/Space too. */
  commit() {
    if (!this.active) return false;
    const segment = this.segment;
    if (!segment) return !!this.finalizing;
    segment.commitRequested = true;
    if (!segment.ready || segment.ending) return true;
    segment.ending = true;
    segment.timer = setTimeout(() => this.fail('network'), 8000);
    this.processor.port.postMessage('drain');
    return true;
  }

  sendDone(segment) {
    if (segment.done) return;
    clearTimeout(segment.timer);
    clearTimeout(this.rotation); segment.done = true; segment.ending = true;
    if (this.segment === segment) this.segment = null;
    this.finalizing = segment;
    segment.socket.send(JSON.stringify({ type: 'transcription-stream.audio-done' }));
    segment.timer = setTimeout(() => this.fail('network'), 8000);
  }

  emitTranscripts(resultIndex = 0) {
    const visible = this.entries.filter((entry) => entry.text.trim());
    const results = visible.map((entry) => {
      const result = [{ transcript: entry.text.trim(), confidence: 0 }]; result.isFinal = entry.final; return result;
    });
    if ((!results.length && !this.entries.length) || (!this.interimResults && !results.every((result) => result.isFinal))) return;
    results.requiresFinal = true;
    results.audioPending = !!this.finalizing || !!this.segment?.hasSpeech || this.audioQueue.some((packet) => packet.volume >= SPEECH_LEVEL);
    results.silenceMs = this.lastSilenceMs || 0;
    // Result indices count non-empty entries, so blank provider deltas cannot hide later final captions.
    this.onresult?.({ results, resultIndex: visible.filter((entry) => entry.index < resultIndex).length });
  }

  stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (!this.processor) { this.finish(); return; }
    this.processor.port.postMessage('flush');
    this.closeTimer = setTimeout(() => this.fail('network'), 10000);
  }

  closeSegment(segment) {
    clearTimeout(segment.timer);
    if (segment.socket) {
      segment.socket.onopen = segment.socket.onmessage = segment.socket.onerror = segment.socket.onclose = null;
      if (segment.socket.readyState < 2) segment.socket.close();
    }
    this.segments.delete(segment);
  }

  finish() {
    for (const segment of this.segments || []) this.closeSegment(segment);
    this.segment = this.finalizing = null; this.audioQueue = []; this.queuedBytes = 0;
    super.finish();
  }
}

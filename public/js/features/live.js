/**
 * Live voice: GPT-Live through the AI Gateway (docs/SPEECH.md#live-voice).
 *
 * One WebSocket carries the microphone (24 kHz PCM, 50 ms packets) to the model and Campus's voice back. The
 * model hears the person while it talks and decides itself when they have finished, so there is no separate
 * recognise → answer → speak chain to wait for. When an answer needs Citrus (the person's timetable, the
 * university's pages, something to do in the app) it delegates: `onDelegation(id, words, said)` receives what
 * the person said in that turn and what Campus said just before it, and `answer(id, text)` gives the result back
 * to be said aloud.
 *
 *   const live = new LiveSession({ requestPass, onReady, onAudio, onUserText, onReplyText, onDelegation, onEnd });
 *   live.start(); live.mute(true); live.answer(id, text); live.close();
 *
 * `onEnd(reason, { started, trace })` once (trace: what happened, for the server log when it went wrong): closed (asked for), expired, lost (connection dropped), unavailable (it
 * never started: the caller falls back to the standard voice), blocked or no-microphone.
 */
import { MICROPHONE_AUDIO } from './recognition.js';
import { openMicrophone } from './microphone.js';

export const LIVE_URL = 'wss://ai-gateway.vercel.sh/v1/live/sessions';
const RATE = 24000;
const MAX_APPEND = 1800; // a context append holds at most 500 tokens

/** Spoken text from an assistant answer: no citation numbers, links or Markdown. */
export function spokenAnswer(text) {
  return String(text || '')
    .replace(/\[([^\]\n]{1,140})\]\((?:https?:\/\/|\/)[^\s)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The microphone as 24 kHz PCM packets: onPacket(ArrayBuffer). Resolves { stop() }. */
export async function startCapture(onPacket) {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Audio || !globalThis.AudioWorkletNode) throw new Error('No audio capture');
  const stream = await openMicrophone((constraints) => navigator.mediaDevices.getUserMedia(constraints), MICROPHONE_AUDIO);
  let context;
  try {
    context = new Audio({ sampleRate: RATE });
    if (context.sampleRate !== RATE) throw new Error('Unsupported capture rate');
    await context.audioWorklet.addModule('/js/features/pcm-worklet.js');
    await context.resume();
    const processor = new AudioWorkletNode(context, 'campus-pcm', { processorOptions: { frameSamples: 1200 } });
    processor.port.onmessage = ({ data }) => {
      if (data?.pcm) onPacket(data.pcm);
    };
    const input = context.createMediaStreamSource(stream);
    const silent = context.createGain();
    silent.gain.value = 0;
    input.connect(processor);
    processor.connect(silent).connect(context.destination);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    context?.close?.().catch(() => {});
    throw error;
  }
  return {
    stop() {
      stream.getTracks().forEach((track) => track.stop());
      context.close?.().catch(() => {});
    },
  };
}

export class LiveSession {
  constructor({ requestPass, onReady, onAudio, onUserText, onReplyText, onDelegation, onEnd,
    Socket = globalThis.WebSocket, capture = startCapture, startTimeout = 15000, closeTimeout = 5000 } = {}) {
    Object.assign(this, { requestPass, onReady, onAudio, onUserText, onReplyText, onDelegation, onEnd, Socket, capture, startTimeout, closeTimeout });
    this.controller = new AbortController();
    this.started = false;
    this.ended = false;
    this.closing = false;
    this.muted = false;
    this.turn = ''; // what the person said in the current turn
    this.lastTurn = '';
    this.said = ''; // what Campus said since the person last spoke
    this.saidBefore = ''; // what Campus said just before the current turn
    this.campusSpoke = false;
    this.usage = null;
    this.trace = { opened: false, events: {}, sent: 0, closeCode: null, closeReason: '', error: null, at: Date.now() };
  }

  async start() {
    let pass;
    try {
      pass = await this.requestPass(this.controller.signal);
    } catch (error) {
      this.end(error?.name === 'AbortError' ? 'closed' : 'unavailable');
      return;
    }
    if (this.ended) return;
    if (pass?.url !== LIVE_URL || typeof pass.token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(pass.token)) {
      this.end('unavailable');
      return;
    }
    let socket;
    try {
      socket = this.socket = new this.Socket(LIVE_URL, ['ai-gateway-realtime.v1', `ai-gateway-auth.${pass.token}`]);
    } catch {
      this.end('unavailable');
      return;
    }
    this.timer = setTimeout(() => this.end('unavailable'), this.startTimeout);
    socket.onopen = () => {
      this.trace.opened = true;
      this.send({
        type: 'session.start',
        session: { model: pass.model, store: false, delegation: { type: 'client' }, audio: { format: { type: 'audio/pcm', rate: RATE } }, instructions: pass.instructions },
      });
    };
    socket.onmessage = ({ data }) => this.receive(data);
    socket.onerror = () => this.end(this.started ? 'lost' : 'unavailable');
    socket.onclose = (e) => {
      this.trace.closeCode = e?.code ?? null;
      this.trace.closeReason = String(e?.reason || '').slice(0, 200);
      this.end(!this.started ? 'unavailable' : this.closing ? 'closed' : 'lost');
    };
    // The microphone opens while the connection is made; packets wait for session.started.
    try {
      const mic = await this.capture((pcm) => this.audio(pcm));
      if (this.ended) mic.stop();
      else this.mic = mic;
    } catch (error) {
      this.end(error?.name === 'NotAllowedError' ? 'blocked' : error?.name === 'NotFoundError' ? 'no-microphone' : 'unavailable');
    }
  }

  send(event) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  audio(pcm) {
    if (!this.started || this.muted || this.closing || this.ended) return;
    // A connection that cannot keep up would only fall further behind the person.
    if (this.socket.bufferedAmount > 1_000_000) {
      this.end('lost');
      return;
    }
    if (this.send({ type: 'session.input_audio.append', audio: base64(pcm) })) this.trace.sent += 1;
  }

  receive(data) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (this.ended) return;
    const type = String(event.type || '?').slice(0, 60);
    this.trace.events[type] = (this.trace.events[type] || 0) + 1;
    switch (event.type) {
      case 'session.started':
        this.started = true;
        clearTimeout(this.timer);
        this.onReady?.();
        break;
      case 'session.output_audio.delta':
        if (typeof event.delta === 'string' && !this.closing) this.onAudio?.(event.delta);
        break;
      case 'session.output_transcript.delta': {
        const text = String(event.delta || '');
        this.said = `${this.said}${text}`.slice(-600);
        if (this.turn.trim()) this.campusSpoke = true;
        this.onReplyText?.(text);
        break;
      }
      case 'session.input_transcript.delta': {
        const text = String(event.delta || '');
        // Campus answered since the person last spoke: these words begin a new turn.
        if (this.campusSpoke) {
          this.lastTurn = this.turn;
          this.turn = '';
          this.campusSpoke = false;
        }
        if (!this.turn.trim()) {
          this.saidBefore = this.said;
          this.said = '';
        }
        this.turn = `${this.turn}${text}`.slice(-1200);
        this.onUserText?.(text);
        break;
      }
      case 'session.delegation.created': {
        const id = event.delegation?.id;
        if (typeof id !== 'string' || !id) break;
        const words = (this.turn.trim() || this.lastTurn.trim()).slice(-600);
        this.onDelegation?.(id, words, this.saidBefore.trim());
        break;
      }
      case 'session.usage.updated':
        this.usage = event.usage?.seconds ?? this.usage;
        break;
      case 'session.closed':
        this.usage = event.usage?.seconds ?? this.usage;
        this.end(event.reason === 'expired' ? 'expired' : 'closed');
        break;
      case 'error':
        this.trace.error = { type: String(event.error?.type || '').slice(0, 80), code: String(event.error?.code || '').slice(0, 80), message: String(event.error?.message || '').slice(0, 300) };
        // Before startup the model or account was refused; later errors (moderation) do not end the session.
        if (!this.started) this.end('unavailable');
        break;
      default:
        break;
    }
  }

  /** The result of a delegation, for Campus to say in its own words. */
  answer(id, text) {
    const content = String(text || '').trim().slice(0, MAX_APPEND);
    if (content) this.send({ type: 'session.commentary.append', delegation_id: id, content });
  }

  mute(on) {
    this.muted = !!on;
    if (this.started) this.send({ type: on ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }

  /** End the conversation: stop the microphone, ask for the final usage, close within a few seconds. */
  close() {
    if (this.ended) return;
    this.mic?.stop();
    this.mic = null;
    if (!this.started || this.closing || !this.send({ type: 'session.close' })) {
      this.closing = true;
      this.end('closed');
      return;
    }
    this.closing = true;
    this.closeTimer = setTimeout(() => this.end('closed'), this.closeTimeout);
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    this.controller.abort();
    this.mic?.stop();
    this.mic = null;
    const socket = this.socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        if (socket.readyState < 2) socket.close();
      } catch {
        /* already closed */
      }
    }
    this.onEnd?.(reason, { started: this.started, trace: { ...this.trace, reason, ms: Date.now() - this.trace.at } });
  }
}

/** The Gateway audio envelope, without an SDK. Tokens stay in memory and never enter URLs. */
export function gatewaySocket(grant, kind, Socket = globalThis.WebSocket) {
  const url = new URL(grant.url);
  if (url.origin !== 'wss://ai-gateway.vercel.sh' || url.pathname !== `/v4/ai/${kind}-model`
    || url.username || url.password || url.searchParams.get('ai-model-id') !== grant.model
    || !/^vcst_[A-Za-z0-9_.-]+$/.test(grant.token)) throw new Error('Invalid audio session');
  return new Socket(url.href, [`ai-gateway-${kind}.v1`, `ai-gateway-auth.${grant.token}`]);
}

/** Text in, PCM audio out. The caller owns the playback clock and cancellation. */
export class StreamingSpeech {
  constructor({ requestSession, onAudio, onFinish, onError, Socket = globalThis.WebSocket, timeout = 10000 }) {
    Object.assign(this, { requestSession, onAudio, onFinish, onError, Socket, timeout });
    this.controller = new AbortController();
    this.pending = []; this.length = 0; this.closed = false; this.ended = false;
  }

  async start() {
    if (this.closed) return;
    try {
      this.arm();
      const grant = await this.requestSession(this.controller.signal);
      if (this.closed) return;
      const socket = this.socket = gatewaySocket(grant, 'speech', this.Socket);
      socket.onopen = () => {
        if (this.closed) return;
        try {
          this.arm();
          socket.send(JSON.stringify({ type: 'speech-stream.start', voice: grant.voice, speed: grant.speed, outputFormat: grant.outputFormat }));
          this.ready = true;
          this.flush();
        } catch { this.fail(); }
      };
      socket.onmessage = ({ data }) => {
        if (this.closed) return;
        try {
          const part = JSON.parse(data);
          if (part.type === 'error') return this.fail();
          if (part.type === 'audio') {
            if (part.audioFormat?.type !== 'audio/pcm' || part.audioFormat.rate !== 24000 || typeof part.audio !== 'string') return this.fail();
            this.arm();
            this.onAudio(part.audio);
          } else if (part.type === 'finish') {
            if (!this.sentEnd) return this.fail();
            this.cancel();
            this.onFinish();
          }
        } catch { this.fail(); }
      };
      socket.onerror = () => this.fail();
      socket.onclose = () => this.fail();
    } catch { if (!this.closed) this.fail(); }
  }

  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), this.timeout);
  }

  feed(text) {
    if (this.closed || this.ended) return;
    this.length += text.length;
    if (this.length > 12000) return this.fail();
    this.pending.push(text);
    this.flush();
  }

  end() { this.ended = true; this.flush(); }

  flush() {
    if (this.closed || !this.ready) return;
    try {
      if (this.socket.bufferedAmount > 1000000) return this.fail();
      for (const text of this.pending) {
        for (let at = 0; at < text.length; at += 2000) this.socket.send(JSON.stringify({ type: 'speech-stream.text-delta', delta: text.slice(at, at + 2000) }));
      }
      this.pending = [];
      if (this.ended && !this.sentEnd) {
        this.sentEnd = true;
        this.socket.send(JSON.stringify({ type: 'speech-stream.text-done' }));
      }
    } catch { this.fail(); }
  }

  fail() { if (!this.closed) { this.cancel(); this.onError(); } }

  cancel() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      if (this.socket.readyState < 2) this.socket.close();
    }
    this.pending = [];
  }
}

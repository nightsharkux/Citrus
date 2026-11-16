/**
 * Citrus API client for web apps, native shells (Capacitor/React Native web
 * views) and scripts. Framework-free; uses fetch.
 *
 *   const campus = new CampusOSClient('https://campus.example.edu');
 *   await campus.login('me@uni.edu', 'password');
 *   for await (const text of campus.ask('What’s on my schedule?')) process.stdout.write(text);
 *
 * Browsers send the session cookie automatically (same origin). Native apps
 * should use university SSO in a system browser and a secure cookie store.
 */
export class CampusOSClient {
  constructor(baseURL = '') {
    this.base = baseURL.replace(/\/$/, '');
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${this.base}/api/v1/${path.replace(/^\//, '')}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  // Session
  login(email, password) { return this.request('login', { method: 'POST', body: { email, password } }); }
  logout() { return this.request('logout', { method: 'POST' }); }
  me() { return this.request('bootstrap'); }
  meta() { return this.request('meta'); }
  capabilities() { return this.request('capabilities'); }

  // Learning
  courses() { return this.request('courses'); }
  course(id) { return this.request(`courses/${Number(id)}`); }
  rate(topicId, level) { return this.request(`topics/${Number(topicId)}/respond`, { method: 'POST', body: { level } }); }
  review() { return this.request('review'); }
  grade(itemId, grade) { return this.request(`review/${Number(itemId)}`, { method: 'POST', body: { grade } }); }
  schedule(from, to) { return this.request(`timetable?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); }

  // Campus
  posts() { return this.request('connect/posts'); }
  notifications() { return this.request('notifications'); }
  checkIn(sessionId, code) { return this.request(`participation/${Number(sessionId)}/checkin`, { method: 'POST', body: code ? { code } : {} }); }

  /** Stream an assistant answer. Yields text chunks; resolves `.thread` and `.sources` as they arrive. */
  async *ask(prompt, threadId) {
    const res = await fetch(`${this.base}/api/v1/assistant/messages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, thread_id: threadId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const type = /event: (.+)/.exec(chunk)?.[1];
        const data = JSON.parse(/data: (.+)/.exec(chunk)?.[1] || '{}');
        if (type === 'thread') this.thread = data;
        if (type === 'sources') this.sources = data.sources;
        if (type === 'delta') yield data.text;
        if (type === 'error') throw new Error(data.message);
      }
    }
  }
}

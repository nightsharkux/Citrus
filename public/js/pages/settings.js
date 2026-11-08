/** Settings: profile, appearance, assistant, connections, security, privacy, feedback, about. */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, setSession, assistantName } from '../core/store.js';
import { pageHead, avatar } from '../core/components.js';
import { ago, humanize } from '../core/format.js';
import { onSubmit, toast, toastError, confirm, busy } from '../core/ui.js';
import { setTheme, signOut } from '../shell.js';
import { createFace } from '../features/face.js';
import { wake, voiceProblem } from '../features/voice.js';

const SECTIONS = [
  ['profile', 'Profile', 'user'], ['appearance', 'Appearance', 'sun'], ['assistant', 'Assistant', 'sparkle'], ['notifications', 'Notifications', 'bell'],
  ['connections', 'Connections', 'link'], ['security', 'Security', 'lock'], ['privacy', 'Your data', 'shield'], ['feedback', 'Feedback', 'bulb'], ['about', 'About', 'info'],
];

export default {
  title: 'Settings',
  async load(ctx) {
    const section = ctx.params.section || 'profile';
    if (section === 'notifications') {
      ctx.navigate('/inbox/preferences', { replace: true });
      return null;
    }
    const data = { section };
    if (section === 'profile') Object.assign(data, await api.get('/me'));
    if (section === 'connections') data.integrations = await api.get('/integrations');
    if (section === 'security') data.sessions = (await api.get('/me/sessions')).sessions;
    return data;
  },
  render(d) {
    if (!d) return '';
    return html`${pageHead({ title: 'Settings' })}
      <div class="settings">
        <nav class="settings-nav card flush" aria-label="Settings sections">${SECTIONS.map(([key, label, glyph]) => html`<a class="list-row ${key === d.section ? 'is-active' : ''}" href="/settings/${key}"><span class="tile sm ${key === d.section ? '' : 'neutral'}">${icon(glyph, 16)}</span><span class="body"><span class="title">${label}</span></span></a>`)}</nav>
        <div class="settings-body stagger">${({ profile, appearance, assistant, connections, security, privacy, feedback, about })[d.section]?.(d) || profile(d)}</div>
      </div>`;
  },
  mount(root, d, ctx) {
    if (!d) return undefined;
    return ({ profile: mountProfile, appearance: mountAppearance, assistant: mountAssistant, connections: mountConnections, security: mountSecurity, privacy: mountPrivacy, feedback: mountFeedback })[d.section]?.(root, d, ctx);
  },
};

// ---------------------------------------------------------------- Profile

function profile(d) {
  const u = session.user;
  return html`<section class="card">
    <div class="cluster">${avatar(u.name, 'lg')}<div><h2>${u.name}</h2><p class="muted small">${u.email} · ${humanize(u.role)}${u.requested_role === 'lecturer' ? ' · lecturer access pending' : ''}</p></div></div>
    <form class="form mt-24" id="profile-form">
      <label class="field"><span>Display name</span><input class="input" name="name" value="${u.name}" required minlength="2" maxlength="80"></label>
      <div class="input-row">
        <label class="field"><span>Programme</span><input class="input" name="programme" value="${d.profile.programme}" placeholder="Digital Technology and Management"></label>
        <label class="field" style="max-width:140px"><span>Semester</span><input class="input" name="semester" type="number" min="1" max="20" value="${d.profile.semester ?? ''}"></label>
      </div>
      <div class="field"><span>Interests</span><div class="cluster">${d.interestTags.map((t) => html`<label class="chip-check"><input type="checkbox" name="interests" value="${t}" ${d.profile.interests.includes(t) ? 'checked' : ''}><span>${humanize(t)}</span></label>`)}</div>
        <span class="hint">Used to highlight matching jobs, events and research calls in your campus feed. Nobody else sees them.</span></div>
      <label class="spread"><span><strong>Opportunity matching</strong><br><span class="small muted">Get a notification when a new post matches your interests.</span></span><span class="switch"><input type="checkbox" name="matching" ${u.preferences?.matching === false ? '' : 'checked'}><span></span></span></label>
      <div class="form-actions"><button class="btn btn-primary">Save profile</button></div>
    </form>
  </section>`;
}

function mountProfile(root) {
  onSubmit($('#profile-form', root), async (v) => {
    const [me] = await Promise.all([
      api.patch('/me', { name: v.name, preferences: { matching: !!v.matching } }),
      api.put('/me/profile', { programme: v.programme, semester: v.semester || null, interests: Array.isArray(v.interests) ? v.interests : [] }),
    ]);
    setSession({ user: { ...session.user, ...me.user } });
    return 'Profile saved';
  });
}

// ---------------------------------------------------------------- Appearance

function appearance() {
  const current = document.documentElement.dataset.theme || 'system';
  const opt = (value, label, glyph) => html`<label class="theme-option ${value}"><input type="radio" name="theme" value="${value}" ${current === value ? 'checked' : ''}><span class="theme-preview"><i></i><i></i><i></i></span><span class="cluster" style="--gap:6px">${icon(glyph, 15)} ${label}</span></label>`;
  return html`<section class="card"><h2>Appearance</h2><p class="muted small mt-8">Choose how Campus OS looks on this device.</p>
    <form class="theme-options mt-24" id="theme-form">${opt('system', 'Match system', 'monitor')}${opt('light', 'Light', 'sun')}${opt('dark', 'Dark', 'moon')}</form>
  </section>`;
}

function mountAppearance(root) {
  return on(root, 'change', '#theme-form input', (e) => {
    setTheme(e.target.value);
    toast('Appearance updated', 'success');
  });
}

// ---------------------------------------------------------------- Assistant

function assistant() {
  const prefs = session.user.preferences || {};
  const problem = voiceProblem();
  return html`<section class="card assistant-settings">
    <div class="cluster" style="--gap:16px"><span data-settings-face></span><div><h2>Campus</h2><p class="small muted">Your assistant across Campus OS.</p></div></div>
    <div class="stack mt-24" style="--gap:18px">
      <label class="spread"><span><strong>Listen for “Hey Campus”</strong><br><span class="small muted">Say “Hey Campus” or just “Campus” on any page, followed by your question. Answers are read aloud. ${problem ? html`<span style="color:var(--warning)">${problem}</span>` : 'Your browser’s speech service processes the audio while this is on.'}</span></span>
        <span class="switch"><input type="checkbox" data-pref="voiceWake" ${prefs.voiceWake ? 'checked' : ''} ${problem ? 'disabled' : ''} aria-label="Listen for Hey Campus"><span></span></span></label>
      <label class="spread"><span><strong>Animated explanations</strong><br><span class="small muted">Campus’s eye turns into small animations — formulas, steps, figures — while it explains something.</span></span>
        <span class="switch"><input type="checkbox" data-pref="visuals" ${prefs.visuals === false ? '' : 'checked'} aria-label="Animated explanations"><span></span></span></label>
    </div>
  </section>
  <section class="card"><h2>What Campus can see</h2>
    <ul class="small muted mt-8" style="padding-left:18px;line-height:1.8">
      <li>Your own courses, schedule, review queue and the topics you marked as difficult.</li>
      <li>Your university’s approved knowledge library — answers cite it with numbered sources.</li>
      <li>Never other students’ data, grades or private files.</li>
    </ul>
    <p class="small faint mt-8">Model: ${session.ai?.aiEnabled ? `${session.ai.label} (${session.ai.model})` : 'not connected'}.</p>
  </section>`;
}

function mountAssistant(root) {
  const slot = $('[data-settings-face]', root);
  const face = createFace({ size: 64, mood: session.ai?.aiEnabled ? 'idle' : 'asleep' });
  slot?.replaceWith(face.el);
  const off = on(root, 'change', '[data-pref]', async (e) => {
    const input = e.target;
    const key = input.dataset.pref;
    const value = input.checked;
    if (key === 'voiceWake') {
      if (value && !wake.start(assistantName())) {
        input.checked = false;
        return;
      }
      if (!value) wake.stop();
    }
    try {
      const r = await api.patch('/me', { preferences: { [key]: value } });
      setSession({ user: { ...session.user, preferences: r.user.preferences } });
      face.react(value ? 'happy' : 'surprised', 1100);
      toast(key === 'voiceWake' ? (value ? 'Campus is listening for “Hey Campus”.' : 'Campus stopped listening.') : value ? 'Animated explanations on' : 'Animated explanations off', 'success');
    } catch (error) {
      input.checked = !value;
      toastError(error);
    }
  });
  return () => {
    off();
    face.destroy();
  };
}

// ---------------------------------------------------------------- Connections

function connections(d) {
  const m = d.integrations.moodle;
  return html`<section class="card">
    <div class="cluster"><span class="tile info">${icon('book', 20)}</span><div class="grow"><h2>Moodle</h2><p class="small muted">${m.configured ? (m.connected ? `Connected as ${m.account.fullName} on ${m.account.siteName}` : 'Show your Moodle courses inside Campus OS.') : 'Your university hasn’t enabled the Moodle connection yet.'}</p></div>
      ${m.connected ? html`<span class="chip success">${icon('check', 12)} Connected</span>` : ''}</div>
    ${m.configured && !m.connected ? html`<form class="form mt-16" id="moodle-form">
      <label class="field"><span>Moodle security key</span><input class="input mono" name="token" required minlength="16" placeholder="Paste your web service token"><span class="hint">In Moodle: open your profile menu → Preferences → Security keys, and copy the “Moodle mobile web service” key. Campus OS never sees your Moodle password.</span></label>
      <div class="form-actions"><button class="btn btn-primary">Connect</button></div>
    </form>` : ''}
    ${m.connected ? html`<div class="form-actions mt-16"><a class="btn" href="/courses">View courses</a><button class="btn btn-ghost" data-disconnect>Disconnect</button></div>` : ''}
  </section>
  <section class="card">
    <div class="cluster"><span class="tile">${icon('calendar', 20)}</span><div class="grow"><h2>Calendar subscription</h2><p class="small muted">${d.integrations.calendarFeed ? 'Your private calendar link is active.' : 'Add your Campus OS schedule to your phone’s calendar.'}</p></div></div>
    <div class="form-actions mt-16"><a class="btn" href="/schedule">Manage in Schedule</a></div>
  </section>
  <section class="card">
    <div class="cluster"><span class="tile warning">${icon('bell', 20)}</span><div class="grow"><h2>Push notifications</h2><p class="small muted">${d.integrations.pushDevices ? `On for ${d.integrations.pushDevices} device${d.integrations.pushDevices === 1 ? '' : 's'}.` : 'Not enabled on any device.'}</p></div></div>
    <div class="form-actions mt-16"><a class="btn" href="/inbox/preferences">Notification settings</a></div>
  </section>`;
}

function mountConnections(root, d, ctx) {
  onSubmit($('#moodle-form', root), async (v) => {
    await api.post('/integrations/moodle', v);
    ctx.refresh();
    return 'Moodle connected';
  });
  return on(root, 'click', '[data-disconnect]', async () => {
    await api.del('/integrations/moodle').catch(toastError);
    ctx.refresh();
  });
}

// ---------------------------------------------------------------- Security

function device(ua) {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

function security(d) {
  const sso = session.user.auth_provider === 'oidc';
  return html`
    ${sso ? '' : html`<section class="card"><h2>Change password</h2>
      <form class="form mt-16" id="password-form">
        <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" required minlength="12"><span class="hint">At least 12 characters. Other devices are signed out when you change it.</span></label>
        <div class="form-actions"><button class="btn btn-primary">Update password</button></div>
      </form></section>`}
    <section class="card flush"><div class="card-head"><h2>Where you’re signed in</h2>${d.sessions.length > 1 ? html`<button class="btn btn-sm" data-revoke-others>Sign out everywhere else</button>` : ''}</div>
      <div class="list" style="padding-bottom:8px">${d.sessions.map((s) => html`<div class="list-row"><span class="tile ${s.current ? 'success' : 'neutral'}">${icon(/Android|iPhone/.test(s.userAgent) ? 'phone' : 'monitor', 18)}</span>
        <span class="body"><span class="title">${device(s.userAgent)}${s.current ? ' · this device' : ''}</span><span class="sub">Active ${ago(new Date(s.lastSeen || s.created).toISOString())}</span></span>
        <span class="trail">${s.current ? '' : html`<button class="btn btn-sm btn-ghost" data-revoke="${s.id}">Sign out</button>`}</span></div>`)}</div>
    </section>`;
}

function mountSecurity(root, d, ctx) {
  onSubmit($('#password-form', root), async (v, form) => {
    await api.post('/me/password', v);
    form.reset();
    ctx.refresh();
    return 'Password updated';
  });
  const offs = [
    on(root, 'click', '[data-revoke]', (e, b) => busy(b, () => api.del(`/me/sessions/${b.dataset.revoke}`).then(ctx.refresh, toastError))),
    on(root, 'click', '[data-revoke-others]', (e, b) => busy(b, () => api.post('/me/sessions/revoke-others').then(() => {
      toast('Signed out on other devices', 'success');
      ctx.refresh();
    }, toastError))),
  ];
  return () => offs.forEach((off) => off());
}

// ---------------------------------------------------------------- Privacy

function privacy() {
  const sso = session.user.auth_provider === 'oidc';
  return html`<section class="card"><h2>Download your data</h2>
    <p class="muted small mt-8">A JSON file with your account, ratings, answers, conversations, notes, posts, check-ins and schedule.</p>
    <div class="form-actions mt-16"><a class="btn" href="/api/me/export" download>${icon('download', 16)} Download</a></div>
  </section>
  <section class="card danger-zone"><h2>Delete your account</h2>
    <p class="muted small mt-8">Removes your personal data, conversations, recordings and settings. Notes and posts you shared stay, attributed to “Deleted user”. This can’t be undone.</p>
    <form class="form mt-16" id="delete-form">
      ${sso ? '' : html`<label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>`}
      <label class="field"><span>Type DELETE to confirm</span><input class="input" name="confirm" required pattern="DELETE" autocomplete="off"></label>
      <div class="form-actions"><button class="btn btn-danger">Delete my account</button></div>
    </form>
  </section>`;
}

function mountPrivacy(root) {
  onSubmit($('#delete-form', root), async (v) => {
    if (!(await confirm({ title: 'Delete your account now?', message: 'You’ll be signed out immediately.', confirmLabel: 'Delete account', danger: true }))) return;
    await api.post('/me/delete', v);
    toast('Your account was deleted', 'success');
    await signOut();
  });
}

// ---------------------------------------------------------------- Feedback & about

function feedback() {
  return html`<section class="card"><h2>Send feedback</h2><p class="muted small mt-8">Ideas, problems, things you love — it goes straight to your university’s administrators.</p>
    <form class="form mt-16" id="feedback-form"><textarea class="textarea" name="message" required minlength="5" maxlength="2000" placeholder="What should work better?"></textarea><div class="form-actions"><button class="btn btn-primary">Send</button></div></form>
  </section>`;
}

function mountFeedback(root) {
  onSubmit($('#feedback-form', root), async (v, form) => {
    await api.post('/suggestions', v);
    form.reset();
    return 'Thanks — your feedback was sent';
  });
}

function about() {
  const mac = navigator.platform?.includes('Mac');
  return html`<section class="card"><h2>${session.site.name}</h2>
    <p class="muted small mt-8">Version ${session.site.version} · ${session.site.institution}</p>
    ${session.site.conceptNotice ? html`<div class="notice mt-16">${icon('info', 18)}<span>${session.site.conceptNotice}</span></div>` : ''}
    <div class="form-actions mt-16" style="justify-content:flex-start"><a class="btn" href="/tools">${icon('layers', 16)} Feature status</a></div>
  </section>
  <section class="card"><h2>Keyboard shortcuts</h2>
    <div class="list mt-8">
      <div class="list-row no-icon"><span class="body">Search and jump</span><span class="trail"><kbd>${mac ? '⌘' : 'Ctrl'}</kbd> <kbd>K</kbd></span></div>
      <div class="list-row no-icon"><span class="body">Send message</span><span class="trail"><kbd>Enter</kbd></span></div>
      <div class="list-row no-icon"><span class="body">New line in message</span><span class="trail"><kbd>Shift</kbd> <kbd>Enter</kbd></span></div>
      <div class="list-row no-icon"><span class="body">Review: reveal / grade</span><span class="trail"><kbd>Space</kbd> <kbd>1–4</kbd></span></div>
      <div class="list-row no-icon"><span class="body">Close dialog</span><span class="trail"><kbd>Esc</kbd></span></div>
    </div>
  </section>`;
}

/**
 * Application frames: the signed-in shell (sidebar, top bar, tab bar,
 * command palette) and the public frame (landing, sign-in).
 */
import { html, render, $, $$, on } from './core/dom.js';
import { icon } from './core/icons.js';
import { api } from './core/api.js';
import { session, setSession, on as onStore, assistantName } from './core/store.js';
import { navigate } from './core/router.js';
import { live } from './core/live.js';
import { toast, sheet, menu } from './core/ui.js';
import { avatar } from './core/components.js';
import { navFor, allItems, isActive } from './nav.js';
import { wordmark } from './core/brand.js';
import { wake, stopSpeaking, isSpeaking } from './features/voice.js';
import { matchCommand } from './features/commands.js';
import { setLanguage, getLanguage } from './core/i18n.js';
import { showTranslation } from './features/translate.js';

const app = () => document.getElementById('app');
const ambient = html`<div class="ambient" aria-hidden="true"><span></span><span></span><span></span></div>`;

/** Shown when the server cannot keep data (no hosted database): accounts will disappear on restart. */
const storageWarning = (who) => (session.durable === false && who
  ? html`<div class="notice warning storage-warning" role="alert">${icon('alert', 18)}<span>${who === 'admin'
    ? 'This server is not saving data permanently. Accounts, courses and messages disappear whenever it restarts. Connect a hosted database (TURSO_DATABASE_URL) to fix this.'
    : 'This server is not saving accounts permanently right now. If you can’t sign in later, you will need to register again. Please tell the administrator.'}</span></div>`
  : '');

function brand(href = '/home') {
  return html`<a class="brand" href="${href}" aria-label="Campus OS home">
    <span class="brand-text">${wordmark()}<small>${session.site.tagline || ''}</small></span>
  </a>`;
}

const badge = (item) => (item.badge === 'unread' && session.unread ? html`<span class="count" data-unread>${session.unread > 99 ? '99+' : session.unread}</span>` : '');

// ---------------------------------------------------------------- Public frame

export function mountPublic() {
  document.body.classList.remove('is-app');
  render(app(), html`${ambient}
    <div class="public">
      <header class="public-top">${brand('/')}<nav class="cluster" id="public-nav"></nav><button type="button" class="btn btn-ghost btn-sm" data-lang-toggle aria-label="Language" data-no-translate>${getLanguage() === 'de' ? 'EN' : 'DE'}</button></header>
      ${storageWarning('user')}
      <main id="view" class="view"></main>
      <footer class="public-foot"><span>${session.site.conceptNotice || ''}</span><span>${session.site.name} ${session.site.version || ''}</span></footer>
    </div>`);
}

// ---------------------------------------------------------------- App frame

export function mountApp() {
  document.body.classList.add('is-app');
  const nav = navFor(session.user.role);
  const u = session.user;
  render(app(), html`${ambient}
    <aside class="sidebar" aria-label="Main navigation">
      ${brand()}
      <div class="sidebar-scroll">
        <nav class="nav">${nav.primary.map(navLink)}</nav>
        ${nav.secondary.length ? html`<div class="nav-label">More</div><nav class="nav">${nav.secondary.map(navLink)}</nav>` : ''}
      </div>
      <div class="sidebar-foot">
        ${nav.foot.map(navLink)}
        ${session.site.logo ? html`<div class="edition-logo"><img src="${session.site.logo}" alt=""><small>Independent concept</small></div>` : ''}
        <button class="profile-chip" data-user-menu>${avatar(u.name)}<span class="body"><strong>${u.name}</strong><small>${roleLabel(u.role)}${u.requested_role === 'lecturer' ? ' · lecturer pending' : ''}</small></span>${icon('more', 18)}</button>
      </div>
    </aside>
    <div class="main">
      ${storageWarning(u.role === 'admin' ? 'admin' : null)}
      <header class="topbar" id="topbar">
        <a class="topbar-mobile-brand" href="/home" aria-label="Campus OS home">${wordmark()}</a>
        <span class="topbar-title" id="topbar-title"></span>
        <div class="topbar-actions">
          <button class="icon-btn focus-btn" data-focus aria-label="Campus Focus" title="Campus Focus: pause notifications">${icon('moon', 18)}</button>
          <button class="icon-btn wake-indicator" data-wake-indicator hidden aria-label="Campus is listening for “Hey Campus”. Click to stop." title="Listening for “Hey Campus” — click to stop">${icon('mic', 18)}</button>
          <button class="search-pill" data-palette aria-label="Search">${icon('search', 18)}<span>Search or jump to…</span><kbd>${navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button>
          <a class="icon-btn" href="/inbox" aria-label="Inbox">${icon('bell', 19)}<span data-unread-slot>${session.unread ? html`<span class="count">${session.unread > 99 ? '99+' : session.unread}</span>` : ''}</span></a>
          <button class="icon-btn" data-user-menu aria-label="Account menu" style="padding:0;overflow:hidden">${avatar(u.name, 'sm')}</button>
        </div>
      </header>
      <main id="view" class="view" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Tabs">${nav.tabs.map((href) => tab(href, nav))}</nav>
    <div class="voice-pill" data-voice-pill hidden role="status" aria-live="polite">
      <span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="voice-text" data-voice-text>Listening</span>
      <button class="voice-close" data-voice-cancel aria-label="Cancel">${icon('x', 16)}</button>
    </div>`);

  wireShell();
  syncFocus();
  live.connect();
  if (session.user.preferences?.voiceWake && !wake.enabled) wake.start(assistantName());
  syncWakeIndicator();
}

/** Campus Focus: minutes left (0 when off). Notifications that are not urgent wait quietly in the inbox meanwhile. */
const focusLeft = () => Math.max(0, Math.ceil((Date.parse(session.user?.preferences?.focusUntil || '') - Date.now()) / 60000)) || 0;
const span = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
let focusTimer = 0;
function syncFocus() {
  const left = focusLeft();
  const el = $('[data-focus]');
  if (el) {
    el.classList.toggle('is-on', left > 0);
    el.title = left > 0 ? `Focus on for ${span(left)}. Click to change.` : 'Campus Focus: pause notifications';
  }
  clearTimeout(focusTimer);
  if (left > 0) focusTimer = setTimeout(syncFocus, 30_000);
}
export async function setFocus(minutes) {
  const focusUntil = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;
  const res = await api.patch('/me', { preferences: { focusUntil } });
  setSession({ user: { ...session.user, preferences: res.user.preferences } });
  syncFocus();
  toast(minutes ? `Focus on for ${span(minutes)}. Notifications wait in your inbox.` : 'Focus off', 'info', { duration: 2200 });
}
function focusMenu(button) {
  menu(button, [
    ...[[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours']].map(([m, label]) => ({ label, icon: 'moon', onSelect: () => setFocus(m).catch(() => {}) })),
    ...(focusLeft() > 0 ? ['divider', { label: 'Turn Focus off', icon: 'x', onSelect: () => setFocus(0).catch(() => {}) }] : []),
  ]);
}

function syncWakeIndicator() {
  const el = $('[data-wake-indicator]');
  if (el) el.hidden = !wake.enabled;
}

/** The floating "Listening" pill: appears after "Hey Campus", shows the words as they are spoken, leaves when the command is sent. */
let pillTimer = 0;
function showPill(text, { final = false } = {}) {
  const pill = $('[data-voice-pill]');
  if (!pill) return;
  clearTimeout(pillTimer);
  pill.hidden = false;
  pill.classList.toggle('has-words', !!text);
  pill.classList.toggle('is-final', final);
  const label = $('[data-voice-text]', pill);
  if (label) label.textContent = text ? `“${text}”` : 'Listening';
}
function hidePill(delay = 0) {
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => {
    const pill = $('[data-voice-pill]');
    if (pill) pill.hidden = true;
  }, delay);
}
function onWakeState(state) {
  syncWakeIndicator();
  $('[data-wake-indicator]')?.classList.toggle('is-hearing', state === 'heard' || state === 'armed');
  if (state === 'heard' || state === 'armed') showPill('');
  else if (state === 'sent') hidePill(450);
  else hidePill();
}

async function turnOffWake() {
  wake.stop();
  const res = await api.patch('/me', { preferences: { voiceWake: false } }).catch(() => null);
  if (res) setSession({ user: { ...session.user, preferences: res.user.preferences } });
}

/** The hands-free voice conversation, loaded the first time it is used. */
export function talkToCampus(options) {
  return import('./features/conversation.js').then((m) => m.startConversation(options));
}

/** Commands that need no AI ("open schedule", "dark mode", "stop", "let's talk"). Returns true when handled. */
function handleVoiceCommand(text) {
  const command = matchCommand(text, {
    role: session.user.role,
    navigate,
    setTheme,
    stop: () => {
      stopSpeaking();
      document.dispatchEvent(new CustomEvent('campus:stop'));
    },
    stopListening: () => turnOffWake(),
    setSpeechLanguage: async (code) => {
      const res = await api.patch('/me', { preferences: { speechLanguage: code } }).catch(() => null);
      if (res) (await import('./features/preferences.js')).applySettingsEffect({ prefs: res.user.preferences });
    },
    talk: () => talkToCampus({ threadId: currentThreadId() }),
  });
  if (!command) return false;
  toast(command.say.replace('Stopped listening', `${assistantName()} stopped listening.`), 'info', { duration: 1800 });
  command.run();
  return true;
}

function navLink(item) {
  const active = isActive(item.href, location.pathname);
  return html`<a class="nav-link ${active ? 'is-active' : ''}" href="${item.href}" ${active ? 'aria-current="page"' : ''}>${icon(item.icon, 19)}<span>${item.label}</span>${badge(item)}</a>`;
}

function tab(href, nav) {
  if (href === 'more') return html`<button class="tab" data-more>${icon('menu', 22)}<span>More</span></button>`;
  const item = allItems(session.user.role).find((i) => i.href === href);
  const label = href === '/assistant' ? 'Ask' : href === '/campus' ? 'Campus life' : item.label;
  return html`<a class="tab ${isActive(href, location.pathname) ? 'is-active' : ''}" href="${href}">${icon(item.icon, 22)}<span>${label}</span>${badge(item)}</a>`;
}

const roleLabel = (r) => ({ student: 'Student', lecturer: 'Lecturer', admin: 'Administrator' })[r] || r;

/** The assistant thread on screen (/assistant/12), so a voice conversation started there continues it. */
const currentThreadId = () => Number(/^\/assistant\/(\d+)/.exec(location.pathname)?.[1]) || null;

let wired = false;
let typingTimer = 0;
function wireShell() {
  updateActive();
  if (wired) return;
  wired = true;

  onStore('route', updateActive);
  onStore('title', (title) => {
    const el = $('#topbar-title');
    if (el) el.textContent = title || '';
  });
  onStore('session', (patch) => {
    if ('unread' in patch) updateBadges();
  });
  window.addEventListener('scroll', () => $('#topbar')?.classList.toggle('is-scrolled', window.scrollY > 48), { passive: true });

  on(document, 'click', '[data-user-menu]', (e, button) => userMenu(button));
  on(document, 'click', '[data-palette]', () => openPalette());
  on(document, 'click', '[data-focus]', (e, button) => focusMenu(button));
  on(document, 'click', '[data-more]', () => openMore());
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && session.user) {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape' && isSpeaking()) stopSpeaking();
    if (e.target.matches?.('textarea, input')) {
      document.body.classList.add('is-typing');
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => document.body.classList.remove('is-typing'), 1500);
    }
  });

  // "Hey Campus" from any page: open the assistant (and ask, if a question followed). `spoken` lets it answer out loud.
  wake.setFallback((text) => navigate(`/assistant?q=${encodeURIComponent(text)}&spoken=1`));
  wake.setInterceptor(handleVoiceCommand);
  wake.onState(onWakeState);
  wake.onTranscript(({ text, final }) => {
    if (wake.armed) showPill(text, { final });
  });
  on(document, 'click', '[data-voice-cancel]', () => {
    wake.cancelCapture();
    hidePill();
  });
  on(document, 'click', '[data-wake-indicator]', async () => {
    await turnOffWake();
    toast('Campus stopped listening.', 'info');
  });

  live.on('notification', (n) => {
    setSession({ unread: session.unread + 1 });
    if (!location.pathname.startsWith('/inbox') && !n.quiet && !focusLeft()) toast(n.title, 'info');
  });
  live.on('activation', async (a) => {
    if (a.status) return;
    const { openActivation } = await import('./pages/classroom.js');
    openActivation(a.id);
  });
}

function updateActive() {
  const path = location.pathname;
  $$('.nav-link, .tab[href]').forEach((a) => {
    const active = isActive(a.getAttribute('href'), path);
    a.classList.toggle('is-active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function updateBadges() {
  const n = session.unread;
  const text = n > 99 ? '99+' : String(n);
  $$('[data-unread]').forEach((el) => (n ? (el.textContent = text) : el.remove()));
  const slot = $('[data-unread-slot]');
  if (slot) render(slot, n ? html`<span class="count">${text}</span>` : '');
  if (n && !$$('.nav-link [data-unread]').length) {
    $$('.nav-link[href="/inbox"], .tab[href="/inbox"]').forEach((a) => a.insertAdjacentHTML('beforeend', `<span class="count" data-unread>${text}</span>`));
  }
}

// ---------------------------------------------------------------- Menus & sheets

export function setTheme(mode) {
  const rootEl = document.documentElement;
  if (mode === 'light' || mode === 'dark') rootEl.dataset.theme = mode;
  else delete rootEl.dataset.theme;
  window.campusThemeColor?.(); // the bar around the app follows the theme
  try {
    localStorage.setItem('campus-theme', mode || 'system');
  } catch {
    /* private mode */
  }
  if (session.user) api.patch('/me', { preferences: { theme: mode || 'system' } }).catch(() => {});
}

function userMenu(button) {
  const current = document.documentElement.dataset.theme || 'system';
  menu(button, [
    { label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings') },
    { label: getLanguage() === 'de' ? 'English' : 'Deutsch', icon: 'globe', onSelect: toggleLanguage },
    { label: getLanguage() === 'de' ? 'Translate page to English' : 'Translate page to German', icon: 'globe', onSelect: () => showTranslation({ text: document.querySelector('#view')?.innerText || '', target: getLanguage() === 'de' ? 'en' : 'de' }) },
    { label: 'Profile & interests', icon: 'user', onSelect: () => navigate('/settings/profile') },
    'divider',
    { label: `Light${current === 'light' ? ' ✓' : ''}`, icon: 'sun', onSelect: () => setTheme('light') },
    { label: `Dark${current === 'dark' ? ' ✓' : ''}`, icon: 'moon', onSelect: () => setTheme('dark') },
    { label: `Match system${current === 'system' ? ' ✓' : ''}`, icon: 'monitor', onSelect: () => setTheme('system') },
    'divider',
    { label: 'Sign out', icon: 'logout', danger: true, onSelect: signOut },
  ]);
}

/** English <-> German, from the public header or the account menu. Signed-in people keep the choice on their account. */
function toggleLanguage() {
  const next = getLanguage() === 'de' ? 'en' : 'de';
  setLanguage(next);
  document.querySelectorAll('[data-lang-toggle]').forEach((b) => { b.textContent = next === 'de' ? 'EN' : 'DE'; });
  if (session.user) {
    api.patch('/me', { preferences: { language: next } }).then((r) => setSession({ user: { ...session.user, preferences: r.user.preferences } })).catch(() => {});
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-lang-toggle]')) toggleLanguage();
});

/** Called after sign-in or registration. */
export async function enterApp(returnTo = '/home') {
  const data = await api.get('/bootstrap');
  setSession({ user: data.user, ai: data.ai || null, unread: data.unread || 0 });
  const theme = data.user?.preferences?.theme;
  if (theme && theme !== 'system') setTheme(theme);
  mountApp();
  navigate(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/home', { replace: true });
}

export async function signOut() {
  wake.stop();
  await api.post('/logout').catch(() => {});
  live.disconnect();
  setSession({ user: null, unread: 0, ai: null });
  mountPublic();
  navigate('/', { replace: true });
}

function openMore() {
  const items = allItems(session.user.role);
  sheet({
    title: 'Menu',
    content: html`<div class="grid-auto" style="--min:120px">
      ${items.map((i) => html`<a class="card tight center" href="${i.href}" data-close style="display:flex;flex-direction:column;align-items:center;gap:8px"><span class="tile">${icon(i.icon, 20)}</span><span class="small" style="font-weight:600">${i.label}</span></a>`)}
    </div>
    <button class="btn btn-danger btn-block mt-24" data-signout>${icon('logout', 18)} Sign out</button>`,
    onMount(root, close) {
      root.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => close()));
      root.querySelector('[data-signout]').addEventListener('click', () => {
        close();
        signOut();
      });
    },
  });
}

// ---------------------------------------------------------------- Command palette

let toolsCache = null;
async function openPalette() {
  const actions = [
    { label: 'Ask Campus', icon: 'campus', href: '/assistant?new=1', group: 'Actions' },
    { label: 'Ask Campus in full screen', icon: 'maximize', href: '/assistant?new=1&full=1', group: 'Actions' },
    { label: 'Talk to Campus', hint: 'Voice conversation', icon: 'waveform', run: () => talkToCampus({ threadId: currentThreadId() }), group: 'Actions' },
    { label: 'New space', icon: 'plus', href: '/spaces?new=1', group: 'Actions' },
    { label: 'Add to schedule', icon: 'calendar', href: '/schedule?new=1', group: 'Actions' },
    { label: 'Post to campus feed', icon: 'message', href: '/campus?compose=1', group: 'Actions' },
    { label: 'Switch to dark mode', icon: 'moon', run: () => setTheme('dark'), group: 'Actions' },
    { label: 'Switch to light mode', icon: 'sun', run: () => setTheme('light'), group: 'Actions' },
    { label: 'Sign out', icon: 'logout', run: signOut, group: 'Actions' },
  ];
  const pages = allItems(session.user.role).map((i) => ({ ...i, group: 'Go to' }));
  if (!toolsCache) {
    toolsCache = await fetch('/api/v1/capabilities').then((r) => r.json()).then((d) => d.groups.flatMap((g) => g.items.filter((i) => i.route).map((i) => ({ label: i.label, icon: 'layers', href: i.route, group: 'Features', hint: g.group })))).catch(() => []);
  }
  const all = [...pages, ...actions, ...toolsCache];

  sheet({
    className: 'palette',
    content: html`<div class="search-input">${icon('search', 20)}<input class="input" placeholder="Search pages, features and actions" autofocus aria-label="Search"></div><div class="palette-results" role="listbox"></div>`,
    onMount(root, close) {
      const input = root.querySelector('input');
      const list = root.querySelector('.palette-results');
      let results = [];
      let active = 0;
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        results = (q ? all.filter((i) => `${i.label} ${i.hint || ''}`.toLowerCase().includes(q)) : [...pages, ...actions]).slice(0, 30);
        active = Math.min(active, Math.max(0, results.length - 1));
        let lastGroup = null;
        render(list, results.length ? html`${results.map((r, i) => {
          const head = r.group !== lastGroup ? html`<div class="palette-group">${r.group}</div>` : '';
          lastGroup = r.group;
          return html`${head}<button class="palette-item ${i === active ? 'is-active' : ''}" data-i="${i}" role="option"><span class="tile">${icon(r.icon, 17)}</span>${r.label}${r.hint ? html`<small>${r.hint}</small>` : ''}</button>`;
        })}` : html`<p class="muted center" style="padding:24px">No matches</p>`);
      };
      const choose = (i) => {
        const r = results[i];
        if (!r) return;
        close();
        if (r.run) r.run();
        else navigate(r.href);
      };
      input.addEventListener('input', () => {
        active = 0;
        draw();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); draw(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
        if (e.key === 'Enter') { choose(active); e.preventDefault(); }
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) choose(Number(b.dataset.i));
      });
      draw();
    },
  });
}

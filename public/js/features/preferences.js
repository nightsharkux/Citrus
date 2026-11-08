/**
 * Settings the assistant changed in chat arrive as a client effect ({ type: 'settings', prefs, device }).
 * `prefs` is the saved account settings (the server already checked and stored them); `device` is what belongs
 * to this device (voice speed, voice, read-aloud), which is kept here. One function for the chat page and the
 * voice conversation, so "call yourself Claudia" and "sprich schneller" work the same in both.
 */
import { session, setSession, assistantName } from '../core/store.js';
import { toast } from '../core/ui.js';
import { setTheme } from '../shell.js';
import { wake } from './voice.js';
import { PRESETS, getVoiceSettings, saveVoiceSettings } from './voices.js';

const clamp = (n) => Math.min(2, Math.max(0.5, n));

/**
 * Open a link the assistant was asked to open. Browsers only allow a new tab straight after a click or key press;
 * when it was a spoken request they refuse, so a toast with a button takes its place.
 */
export function openLink(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return;
  }
  if (target.protocol !== 'https:') return;
  const tab = window.open(target.href, '_blank');
  if (tab) {
    try {
      tab.opener = null;
    } catch { /* cross-origin already */ }
    return;
  }
  toast('Your browser blocked the new tab.', 'info', { duration: 9000, href: target.href, hrefLabel: 'Open the page' });
}

/** What the browser tells the assistant about this device, so "faster" and "what is my speed?" have an answer. */
export function deviceSettings() {
  const v = getVoiceSettings();
  return { voiceRate: Math.round(v.rate * 100) / 100, voiceStyle: v.preset, voiceGender: v.gender || 'any', readAloud: v.readAloud };
}

export function applyDevice(device = {}) {
  const patch = {};
  const now = getVoiceSettings();
  if (device.voiceStyle) {
    const preset = PRESETS.find((p) => p.id === device.voiceStyle);
    if (preset) Object.assign(patch, { preset: preset.id, rate: preset.rate, pitch: preset.pitch });
  }
  if (device.voiceSpeed !== undefined) {
    const base = patch.rate ?? now.rate;
    patch.rate = device.voiceSpeed === 'faster' ? clamp(base * 1.18) : device.voiceSpeed === 'slower' ? clamp(base / 1.18) : clamp(Number(device.voiceSpeed) * (Number(device.voiceSpeed) === 1 ? 1.12 : 1));
  }
  if (device.voiceGender) patch.gender = device.voiceGender;
  if (device.readAloud) patch.readAloud = device.readAloud;
  if (Object.keys(patch).length) saveVoiceSettings(patch);
}

export function applySettingsEffect(effect) {
  if (effect.prefs) {
    const before = session.user.preferences || {};
    // Saving the session also updates the interface language and the name shown everywhere (core/i18n.js).
    setSession({ user: { ...session.user, preferences: effect.prefs } });
    const after = effect.prefs;
    if (after.theme !== before.theme && after.theme) setTheme(after.theme === 'system' ? null : after.theme);
    const nameChanged = after.assistantName !== before.assistantName;
    const wakeChanged = !!after.voiceWake !== !!before.voiceWake;
    if (wakeChanged && !after.voiceWake) wake.stop();
    else if (after.voiceWake && (wakeChanged || nameChanged)) {
      // The wake phrase is built from the name: listen for the new one.
      if (wake.enabled) wake.stop();
      wake.start(assistantName());
    }
    if (after.speechLanguage !== before.speechLanguage && wake.enabled) {
      wake.stop();
      wake.start(assistantName());
    }
  }
  if (effect.device) applyDevice(effect.device);
}

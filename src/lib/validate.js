'use strict';
/**
 * Tiny input validators. Each returns a clean value or throws a 400 with a
 * human-readable message, so handlers stay short:
 *
 *   const title = text(body.title, { min: 3, max: 120, label: 'Title' });
 */
const { badRequest } = require('../http/errors');

function text(value, { min = 0, max = 500, label = 'Text', optional = false } = {}) {
  const clean = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!clean && optional) return '';
  if (clean.length < min) throw badRequest(min <= 1 ? `${label} is required` : `${label} needs at least ${min} characters`);
  return clean.slice(0, max);
}

function oneOf(value, allowed, label = 'Value') {
  if (!allowed.includes(value)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function id(value, label = 'ID') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw badRequest(`${label} is invalid`);
  return n;
}

function optionalId(value, label) {
  return value === undefined || value === null || value === '' ? null : id(value, label);
}

function integer(value, { min = -Infinity, max = Infinity, label = 'Number' } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label} is out of range`);
  return n;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(value) {
  const clean = text(value, { min: 3, max: 180, label: 'Email' }).toLowerCase();
  if (!EMAIL.test(clean)) throw badRequest('Enter a valid email address');
  return clean;
}

function isoDate(value, label = 'Date') {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw badRequest(`${label} is not a valid date`);
  return d.toISOString();
}

function httpUrl(value, { optional = true, label = 'Link' } = {}) {
  const clean = text(value, { max: 500, optional, label });
  if (!clean) return '';
  try {
    const url = new URL(clean);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw badRequest(`${label} must be a valid http(s) URL`);
  }
}

/** Short free-text clamp without validation (for optional notes). */
const clamp = (value, max = 160) => String(value ?? '').trim().slice(0, max);

module.exports = { text, oneOf, id, optionalId, integer, email, isoDate, httpUrl, clamp };

'use strict';
/**
 * Make a tool / More tools: anyone (student, lecturer, administrator) describes a small tool, the AI writes it in
 * the Citrus look, and they keep it for themselves. Shared tools wait for an administrator, then appear under
 * More tools for everyone at the university to add.
 *
 *   GET    /api/apps                       my tools and the shared tools I added
 *   GET    /api/apps/gallery               shared tools (administrators also see the ones waiting for review)
 *   POST   /api/apps                       { idea } → the AI makes a tool (private)
 *   POST   /api/apps/:id/change            { change } → the AI changes it                         (its maker)
 *   PATCH  /api/apps/:id                   { name, description, look, icon }                      (its maker)
 *   POST   /api/apps/:id/share             ask for it to be shared (administrators share at once) (its maker)
 *   POST   /api/apps/:id/private           take it back                                           (its maker)
 *   POST   /api/apps/:id/review            { decision: 'approve' | 'reject', note }               (administrator)
 *   POST   /api/apps/:id/add, DELETE …/add add a shared tool to my tools, or remove it
 *   DELETE /api/apps/:id                   delete                                     (its maker or an administrator)
 *   GET    /api/apps/:id/frame?look=…      the tool itself, locked down (frame.js)
 */
const { text, id, oneOf } = require('../../lib/validate');
const { badRequest, forbidden, notFound, unavailable } = require('../../http/errors');
const { toolMakerPrompt, toolChangePrompt } = require('../../ai/prompts');
const { LOOKS, TOOL_CSP, toolPage, cleanToolHtml } = require('./frame');

const ICONS = ['clock', 'layers', 'target', 'calendar', 'users', 'bulb', 'activity', 'trending', 'book', 'graduation', 'grid', 'list', 'hash', 'sparkle', 'map-pin', 'globe',
  'presentation', 'message', 'flag', 'bolt', 'eye', 'key', 'play', 'refresh', 'history', 'check-circle', 'compass', 'volume', 'mic', 'image', 'file', 'link', 'sun', 'moon'];
const MAX_OWN = 40;

/** The model's JSON tool, checked: { name, description, icon, html } or { refused }. */
function readTool(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let t;
  try {
    t = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  if (t?.refused) return { refused: String(t.refused).slice(0, 240) };
  const html = cleanToolHtml(t?.html);
  if (!html || html.length < 20) return null;
  return {
    name: String(t.name || 'My tool').replace(/\s+/g, ' ').trim().slice(0, 32) || 'My tool',
    description: String(t.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    icon: ICONS.includes(t.icon) ? t.icon : 'layers',
    html,
  };
}

function register(router, { db, ai, site, audit }) {
  const isoNow = () => new Date().toISOString();
  const isAdmin = (u) => u.role === 'admin';

  const toolFor = (user, toolId) => {
    const t = db.get('SELECT * FROM custom_tools WHERE id = ? AND institution_id = ?', id(toolId, 'Tool'), user.institution_id);
    if (!t) throw notFound('Tool not found');
    return t;
  };
  /** Who may open a tool: its maker, an administrator, or anyone at the university once it is shared. */
  const visible = (user, t) => t.owner_id === user.id || isAdmin(user) || t.visibility === 'public';
  const ownTool = (user, toolId) => {
    const t = toolFor(user, toolId);
    if (t.owner_id !== user.id) throw forbidden('Only the person who made this tool can change it');
    return t;
  };

  const view = (user, t) => ({
    id: t.id, name: t.name, description: t.description, icon: t.icon, look: t.look, visibility: t.visibility, reviewNote: t.review_note,
    mine: t.owner_id === user.id, maker: t.owner_id ? db.get('SELECT name FROM users WHERE id = ?', t.owner_id)?.name || '' : '',
    added: !!db.get('SELECT 1 FROM custom_tool_adds WHERE tool_id = ? AND user_id = ?', t.id, user.id),
    users: db.get('SELECT COUNT(*) n FROM custom_tool_adds WHERE tool_id = ?', t.id).n,
    updated: t.updated,
  });

  router.get('/api/apps', (ctx) => {
    const u = ctx.user;
    const mine = db.all('SELECT * FROM custom_tools WHERE institution_id = ? AND owner_id = ? ORDER BY updated DESC', u.institution_id, u.id);
    const added = db.all(
      `SELECT t.* FROM custom_tools t JOIN custom_tool_adds a ON a.tool_id = t.id AND a.user_id = ?
       WHERE t.institution_id = ? AND t.visibility = 'public' AND t.owner_id != ? ORDER BY a.added DESC`, u.id, u.institution_id, u.id,
    );
    return { mine: mine.map((t) => view(u, t)), added: added.map((t) => view(u, t)), looks: LOOKS, aiEnabled: ai.status(u).aiEnabled };
  });

  router.get('/api/apps/gallery', (ctx) => {
    const u = ctx.user;
    const shared = db.all("SELECT * FROM custom_tools WHERE institution_id = ? AND visibility = 'public' ORDER BY updated DESC LIMIT 200", u.institution_id);
    const waiting = isAdmin(u) ? db.all("SELECT * FROM custom_tools WHERE institution_id = ? AND visibility = 'pending' ORDER BY updated", u.institution_id) : [];
    return { tools: shared.map((t) => view(u, t)), waiting: waiting.map((t) => view(u, t)), admin: isAdmin(u) };
  });

  async function make(user, system, prompt) {
    if (!ai.status(user).aiEnabled) throw unavailable('Tools are made by the AI, which is not connected yet.');
    const tool = readTool(await ai.complete({ user, system, prompt, maxTokens: 8000, task: 'chat' }));
    if (!tool) throw unavailable('Citrus could not make that tool. Try describing it differently.');
    if (tool.refused) throw badRequest(`Citrus won’t make this tool: ${tool.refused}`);
    return tool;
  }

  router.post('/api/apps', async (ctx) => {
    const u = ctx.user;
    const b = await ctx.json();
    const idea = text(b.idea, { min: 5, max: 800, label: 'Idea' });
    if (db.get('SELECT COUNT(*) n FROM custom_tools WHERE owner_id = ?', u.id).n >= MAX_OWN) throw badRequest(`You have ${MAX_OWN} tools already. Delete one to make another.`);
    const tool = await make(u, toolMakerPrompt({ icons: ICONS }), `<IDEA>\n${idea}\n</IDEA>`);
    const toolId = db.insert(
      'INSERT INTO custom_tools(institution_id, owner_id, name, description, icon, idea, html, look, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.institution_id, u.id, tool.name, tool.description, tool.icon, idea, tool.html, 'glass', isoNow(), isoNow(),
    );
    ctx.status = 201;
    return { tool: view(u, toolFor(u, toolId)) };
  });

  router.post('/api/apps/:id/change', async (ctx) => {
    const u = ctx.user;
    const t = ownTool(u, ctx.params.id);
    const b = await ctx.json();
    const change = text(b.change, { min: 3, max: 800, label: 'Change' });
    const current = JSON.stringify({ name: t.name, description: t.description, icon: t.icon, html: t.html });
    const tool = await make(u, toolChangePrompt({ icons: ICONS }), `<CURRENT>\n${current.slice(0, 60_000)}\n</CURRENT>\n\n<CHANGE>\n${change}\n</CHANGE>`);
    // A changed shared tool goes back to review: what was approved is not what is there now.
    const visibility = t.visibility === 'public' && !isAdmin(u) ? 'pending' : t.visibility;
    db.run('UPDATE custom_tools SET name = ?, description = ?, icon = ?, html = ?, visibility = ?, updated = ? WHERE id = ?', tool.name, tool.description, tool.icon, tool.html, visibility, isoNow(), t.id);
    return { tool: view(u, toolFor(u, t.id)) };
  });

  router.patch('/api/apps/:id', async (ctx) => {
    const u = ctx.user;
    const t = ownTool(u, ctx.params.id);
    const b = await ctx.json();
    const name = b.name !== undefined ? text(b.name, { min: 1, max: 32, label: 'Name' }) : t.name;
    const description = b.description !== undefined ? text(b.description, { max: 200, optional: true, label: 'Description' }) || '' : t.description;
    const look = b.look !== undefined ? oneOf(b.look, LOOKS, 'Look') : t.look;
    const icon = b.icon !== undefined ? oneOf(b.icon, ICONS, 'Icon') : t.icon;
    db.run('UPDATE custom_tools SET name = ?, description = ?, look = ?, icon = ?, updated = ? WHERE id = ?', name, description, look, icon, isoNow(), t.id);
    return { tool: view(u, toolFor(u, t.id)) };
  });

  router.post('/api/apps/:id/share', (ctx) => {
    const u = ctx.user;
    const t = ownTool(u, ctx.params.id);
    const visibility = isAdmin(u) ? 'public' : 'pending';
    db.run("UPDATE custom_tools SET visibility = ?, review_note = '', updated = ? WHERE id = ?", visibility, isoNow(), t.id);
    audit(u, 'tool_shared', `${t.id} ${t.name} (${visibility})`);
    return { tool: view(u, toolFor(u, t.id)) };
  });

  router.post('/api/apps/:id/private', (ctx) => {
    const u = ctx.user;
    const t = ownTool(u, ctx.params.id);
    db.run("UPDATE custom_tools SET visibility = 'private', updated = ? WHERE id = ?", isoNow(), t.id);
    return { tool: view(u, toolFor(u, t.id)) };
  });

  router.post('/api/apps/:id/review', async (ctx) => {
    const u = ctx.user;
    const t = toolFor(u, ctx.params.id);
    const b = await ctx.json();
    const decision = oneOf(b.decision, ['approve', 'reject'], 'Decision');
    const note = text(b.note, { max: 240, optional: true, label: 'Note' }) || '';
    db.run('UPDATE custom_tools SET visibility = ?, review_note = ?, updated = ? WHERE id = ?', decision === 'approve' ? 'public' : 'rejected', note, isoNow(), t.id);
    audit(u, decision === 'approve' ? 'tool_approved' : 'tool_rejected', `${t.id} ${t.name}`);
    return { tool: view(u, toolFor(u, t.id)) };
  }, { roles: ['admin'] });

  router.post('/api/apps/:id/add', (ctx) => {
    const u = ctx.user;
    const t = toolFor(u, ctx.params.id);
    if (t.visibility !== 'public') throw forbidden('This tool is not shared');
    db.run('INSERT OR IGNORE INTO custom_tool_adds(tool_id, user_id, added) VALUES(?, ?, ?)', t.id, u.id, isoNow());
    return { tool: view(u, t) };
  });

  router.delete('/api/apps/:id/add', (ctx) => {
    const u = ctx.user;
    const t = toolFor(u, ctx.params.id);
    db.run('DELETE FROM custom_tool_adds WHERE tool_id = ? AND user_id = ?', t.id, u.id);
    return { ok: true };
  });

  router.delete('/api/apps/:id', (ctx) => {
    const u = ctx.user;
    const t = toolFor(u, ctx.params.id);
    if (t.owner_id !== u.id && !isAdmin(u)) throw forbidden('Only the person who made this tool, or an administrator, can delete it');
    db.run('DELETE FROM custom_tools WHERE id = ?', t.id);
    audit(u, 'tool_deleted', `${t.id} ${t.name}`);
    return { ok: true };
  });

  router.get('/api/apps/:id', (ctx) => {
    const t = toolFor(ctx.user, ctx.params.id);
    if (!visible(ctx.user, t)) throw forbidden('This tool is private');
    return { tool: view(ctx.user, t), looks: LOOKS };
  });

  /** The tool itself. Framed only by Citrus, and locked down by its own CSP sandbox (frame.js). */
  router.get('/api/apps/:id/frame', (ctx) => {
    const t = toolFor(ctx.user, ctx.params.id);
    if (!visible(ctx.user, t)) throw forbidden('This tool is private');
    const look = LOOKS.includes(ctx.query.get('look')) ? ctx.query.get('look') : t.look;
    const body = toolPage({ name: t.name, html: t.html, look, palette: site?.palette });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': TOOL_CSP,
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    ctx.res.end(body);
  });
}

module.exports = { register, readTool, ICONS };

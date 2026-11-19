/**
 * The course content, like a Moodle course page but calmer: "General" for the whole course, then topics that open
 * and close, with topics inside topics (folders within folders). Each topic holds files, links and its lectures.
 *
 * Lecturers add and arrange everything from the + and ⋯ buttons on each topic, and can go live, schedule a lecture
 * or start a meeting right inside a topic; Citrus then also reads that topic's files in the lecture. Students see
 * the same outline, open files and links, and join or review lectures. Anyone can ask Citrus about a topic: it
 * answers from the course's files. Files go straight to file storage when the server has it (up to 100 MB).
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { bytes, shortDate } from '../core/format.js';
import { sheet, menu, prompt, confirm, toast, toastError, onSubmit } from '../core/ui.js';
import { slotPicker, mountSlots } from './lecture-slots.js';

const MAX_FILE = 4 * 1024 * 1024;

const fileIcon = (mime = '', name = '') => (mime.startsWith('image/') ? 'image'
  : /presentation|powerpoint|\.pptx?$/i.test(`${mime} ${name}`) ? 'presentation'
    : /sheet|excel|csv|\.xlsx?$/i.test(`${mime} ${name}`) ? 'grid'
      : mime.startsWith('audio/') ? 'volume'
        : mime.startsWith('video/') ? 'play' : 'file');
const viewable = (mime) => /^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(mime);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** The tree: children by parent, in order. */
function treeOf(outline) {
  const kids = new Map();
  for (const s of outline.sections) kids.set(s.parent_id ?? 0, [...(kids.get(s.parent_id ?? 0) || []), s]);
  return (parentId) => kids.get(parentId ?? 0) || [];
}

function itemRow(item, teacher) {
  const actions = teacher ? html`<button class="btn btn-ghost btn-icon btn-sm" data-item-menu="${item.id}" aria-label="Options for ${item.title}">${icon('more', 16)}</button>` : '';
  if (item.kind === 'link') {
    return html`<div class="outline-row"><a class="outline-main" href="${item.url}" target="_blank" rel="noopener noreferrer">
      <span class="tile">${icon('link', 16)}</span><span class="body"><span class="title">${item.title}</span><span class="sub">${hostOf(item.url)}</span></span>${icon('external', 14)}</a>${actions}</div>`;
  }
  const href = `/api/course-items/${item.id}/file`;
  return html`<div class="outline-row">
    <a class="outline-main" href="${viewable(item.mime) ? `${href}?view=1` : href}" ${viewable(item.mime) ? html`target="_blank" rel="noopener"` : html`download`} data-native>
      <span class="tile">${icon(fileIcon(item.mime, item.title), 16)}</span><span class="body"><span class="title">${item.title}</span><span class="sub">${bytes(item.size)} · ${shortDate(item.created)}</span></span></a>
    <a class="btn btn-ghost btn-icon btn-sm" href="${href}" download data-native aria-label="Download ${item.title}" title="Download">${icon('download', 16)}</a>${actions}</div>`;
}

function lectureRow(l, teacher, courseId) {
  const when = l.starts ? shortDate(l.starts) : '';
  return html`<div class="outline-row">
    <a class="outline-main" href="${l.live ? `/live/${courseId}` : l.lastSession ? `/lectures/review/${l.lastSession}` : `#lecture-${l.id}`}">
      <span class="tile accent">${icon('presentation', 16)}</span><span class="body"><span class="title">${l.topic}</span><span class="sub">Lecture${when ? ` · ${when}` : ''}${l.room ? ` · ${l.room}` : ''}</span></span>
      ${l.live ? html`<span class="chip success"><span class="dot live"></span>Live</span>` : l.lastSession ? html`<span class="chip">${teacher ? 'Review' : 'Recap'}</span>` : ''}</a>
    ${teacher && !l.live ? html`<button class="btn btn-sm" data-outline-live="${l.id}">${icon('play', 14)} ${l.lastSession ? 'Again' : 'Go live'}</button>` : ''}
    ${teacher ? html`<button class="btn btn-ghost btn-icon btn-sm" data-lecture-move="${l.id}" aria-label="Move ${l.topic} to a topic" title="Move to a topic">${icon('layers', 16)}</button>` : ''}</div>`;
}

/** Ask Citrus about one topic: it reads the course's files for the answer (and the term so far). */
const askAbout = (outline, s, teacher) => `/assistant?new=1&course=${outline.course.id}&q=${encodeURIComponent(teacher
  ? `About the topic “${s.title}” in ${outline.course.code}: what do its files cover, how did it go in my lectures, and what do students find hard there?`
  : `Explain the topic “${s.title}” in ${outline.course.code} to me from the course files, simply, with an example and a question to check myself.`)}`;

function topicNode(s, outline, children, depth) {
  const teacher = outline.isTeacher;
  const items = outline.items.filter((i) => i.section_id === s.id);
  const lectures = outline.lectures.filter((l) => l.section_id === s.id);
  const subs = children(s.id);
  const count = items.length + lectures.length + subs.length;
  return html`<details class="topic-node depth-${Math.min(depth, 4)}" data-topic="${s.id}" ${depth === 0 || count < 6 ? 'open' : ''}>
    <summary>
      <span class="topic-chevron">${icon('chevron-right', 16)}</span>
      <span class="topic-name"><strong>${s.title}</strong>${s.summary ? html`<span class="small muted">${s.summary}</span>` : ''}</span>
      <span class="small muted topic-count">${count ? `${count}` : ''}</span>
      <a class="btn btn-ghost btn-icon btn-sm" href="${askAbout(outline, s, teacher)}" aria-label="Ask Citrus about ${s.title}" title="Ask Citrus about this topic">${icon('campus', 16)}</a>
      ${teacher ? html`<span class="cluster" style="--gap:2px"><button class="btn btn-ghost btn-icon btn-sm" data-topic-add="${s.id}" aria-label="Add to ${s.title}" title="Add">${icon('plus', 16)}</button><button class="btn btn-ghost btn-icon btn-sm" data-topic-menu="${s.id}" aria-label="Options for ${s.title}">${icon('more', 16)}</button></span>` : ''}
    </summary>
    <div class="topic-body">
      ${lectures.map((l) => lectureRow(l, teacher, outline.course.id))}
      ${items.map((i) => itemRow(i, teacher))}
      ${subs.map((c) => topicNode(c, outline, children, depth + 1))}
      ${!count ? html`<p class="small muted outline-empty">${teacher ? 'Empty. Use + to add files, a link, a lecture or a topic inside this one.' : 'Nothing here yet.'}</p>` : ''}
    </div>
  </details>`;
}

export function outlineView(outline) {
  if (!outline) return '';
  const teacher = outline.isTeacher;
  const children = treeOf(outline);
  const general = { items: outline.items.filter((i) => !i.section_id), lectures: outline.lectures.filter((l) => !l.section_id) };
  const top = children(null);
  if (!teacher && !top.length && !general.items.length) return '';
  return html`<section class="card flush course-outline">
    <div class="card-head"><div><h2>Course content</h2><p class="small muted">${teacher ? 'Topics, and topics inside topics. Files, links and lectures go in any of them.' : 'Everything for this course, by topic.'}</p></div>
      ${teacher ? html`<span class="cluster"><button class="btn btn-sm" data-topic-add="">${icon('upload', 15)} Add to General</button><button class="btn btn-sm btn-primary" data-new-topic="">${icon('plus', 15)} Topic</button></span>` : ''}</div>
    <div class="outline-general">
      <p class="small outline-label">${icon('book', 14)} General · the whole course</p>
      ${general.lectures.map((l) => lectureRow(l, teacher, outline.course.id))}
      ${general.items.map((i) => itemRow(i, teacher))}
      ${!general.items.length && !general.lectures.length ? html`<p class="small muted outline-empty">${teacher ? 'Files and lectures for the whole course go here.' : 'Nothing here yet.'}</p>` : ''}
    </div>
    <div class="outline-topics">${top.length ? top.map((s) => topicNode(s, outline, children, 0)) : teacher ? html`<p class="small muted outline-empty" style="padding:4px 20px 18px">No topics yet. Make one per week or chapter, with smaller topics inside.</p>` : ''}</div>
  </section>`;
}

export function mountOutline(root, outline, ctx) {
  if (!outline?.isTeacher) return () => {};
  const courseId = outline.course.id;
  const sectionTitle = (sid) => outline.sections.find((s) => s.id === Number(sid))?.title || '';
  const refresh = () => ctx.refresh();

  // Files: pick several, upload one after the other.
  const picker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
  root.append(picker);
  let pickFor = null;
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    let done = 0;
    // With file storage the browser sends files straight to it (up to 100 MB); without, up to 4 MB through Citrus.
    const direct = !!outline.storage?.direct;
    const max = outline.storage?.maxBytes || MAX_FILE;
    for (const file of files) {
      if (file.size > max) {
        toast(`${file.name} is larger than ${Math.round(max / 1024 / 1024)} MB. Add it as a link (for example to Moodle or a cloud folder) instead.`, 'error', { duration: 6000 });
        continue;
      }
      try {
        toast(`Uploading ${file.name}…`, 'info', { duration: file.size > 8e6 ? 6000 : 1600 });
        if (direct) await api.uploadDirect(`/courses/${courseId}/files/start`, `/courses/${courseId}/files/finish`, file, { name: file.name, ...(pickFor ? { section_id: Number(pickFor) } : {}) });
        else await api.upload(`/courses/${courseId}/files`, file, { 'X-File-Name': encodeURIComponent(file.name), ...(pickFor ? { 'X-Section-Id': String(pickFor) } : {}) });
        done += 1;
      } catch (error) {
        toastError(error);
      }
    }
    if (done) {
      toast(`${done === 1 ? 'File' : `${done} files`} added${pickFor ? ` to ${sectionTitle(pickFor)}` : ''}. Citrus reads them in this topic's lectures.`, 'success');
      refresh();
    }
  });

  const newTopic = async (parentId) => {
    const title = await prompt({ title: parentId ? `New topic in ${sectionTitle(parentId)}` : 'New topic', label: 'Name', placeholder: parentId ? 'Eigenvalues' : 'Week 1 · Matrices', confirmLabel: 'Create' });
    if (!title) return;
    await api.post(`/courses/${courseId}/sections`, { title, ...(parentId ? { parent_id: Number(parentId) } : {}) }).then(refresh, toastError);
  };
  const addLink = async (sectionId) => {
    sheet({
      title: 'Add a link',
      content: html`<form class="form" id="link-form"><label class="field"><span>Address</span><input class="input" name="url" required placeholder="https://moodle.oth-aw.de/course/view.php?id=…" autofocus></label>
        <label class="field"><span>Title (optional)</span><input class="input" name="title" maxlength="160" placeholder="Exercise sheet 3"></label>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Add</button></div></form>`,
      onMount(el, close) {
        onSubmit($('#link-form', el), async (v) => {
          await api.post(`/courses/${courseId}/links`, { url: v.url, title: v.title, ...(sectionId ? { section_id: Number(sectionId) } : {}) });
          close();
          refresh();
        });
      },
    });
  };
  const scheduleLecture = (sectionId) => sheet({
    title: sectionId ? `New lecture in ${sectionTitle(sectionId)}` : 'New lecture',
    content: html`<form class="form" id="outline-lecture"><label class="field"><span>Title</span><input class="input" name="topic" required minlength="3" value="${sectionTitle(sectionId)}" autofocus></label>
      <div class="input-row"><label class="field"><span>Date and time (optional)</span><input class="input" type="datetime-local" name="starts"></label><label class="field" style="max-width:160px"><span>Length</span><select class="select" name="duration_minutes">${[[45, '45 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours']].map(([m, label]) => html`<option value="${m}" ${m === 90 ? 'selected' : ''}>${label}</option>`)}</select></label></div>
      ${slotPicker()}
      <label class="field"><span>Room (optional)</span><input class="input" name="room" maxlength="60" placeholder="HSG 001"></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create</button></div></form>`,
    onMount(el, close) {
      mountSlots($('#outline-lecture', el));
      onSubmit($('#outline-lecture', el), async (v) => {
        await api.post(`/courses/${courseId}/lectures`, { topic: v.topic, room: v.room, ...(sectionId ? { section_id: Number(sectionId) } : {}), ...(v.starts ? { starts: new Date(v.starts).toISOString(), duration_minutes: Number(v.duration_minutes) } : {}) });
        close();
        refresh();
      });
    },
  });
  const goLiveIn = async (sectionId) => {
    try {
      await api.post('/live/sessions', { course_id: courseId, title: sectionTitle(sectionId) || undefined, ...(sectionId ? { section_id: Number(sectionId) } : {}) });
      ctx.navigate(`/live/${courseId}`);
    } catch (error) {
      toastError(error);
    }
  };
  const meetingIn = async (sectionId) => {
    try {
      const r = await api.post('/meetings/quick', { title: `${outline.course.code} · ${sectionTitle(sectionId) || outline.course.title}` });
      sessionStorage.setItem(`meeting-mic-${r.id}`, '1');
      ctx.navigate(`/spaces/${r.id}/meeting`);
    } catch (error) {
      toastError(error);
    }
  };
  const moveTo = (label, current, onPick) => sheet({
    title: `Move “${label}”`,
    content: html`<form class="form" id="move-form"><label class="field"><span>To</span><select class="select" name="to">
        <option value="">General · the whole course</option>
        ${outline.sections.map((s) => html`<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${'— '.repeat(depthOf(s))}${s.title}</option>`)}
      </select></label><div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Move</button></div></form>`,
    onMount(el, close) {
      onSubmit($('#move-form', el), async (v) => {
        await onPick(v.to ? Number(v.to) : null);
        close();
        refresh();
      });
    },
  });
  const depthOf = (s) => {
    let d = 0;
    let at = s;
    while (at?.parent_id && d < 10) {
      at = outline.sections.find((x) => x.id === at.parent_id);
      d += 1;
    }
    return d;
  };

  const offs = [
    on(root, 'click', '[data-new-topic]', (e, b) => {
      e.preventDefault();
      newTopic(b.dataset.newTopic || null);
    }),
    on(root, 'click', '[data-topic-add]', (e, b) => {
      e.preventDefault();
      e.stopPropagation();
      const sid = b.dataset.topicAdd || null;
      menu(b, [
        { label: 'Upload files', icon: 'upload', onSelect: () => { pickFor = sid; picker.click(); } },
        { label: 'Add a link', icon: 'link', onSelect: () => addLink(sid) },
        sid ? { label: 'Topic inside this one', icon: 'layers', onSelect: () => newTopic(sid) } : null,
        { label: 'Schedule a lecture here', icon: 'calendar', onSelect: () => scheduleLecture(sid) },
        { label: 'Go live here now', icon: 'play', onSelect: () => goLiveIn(sid) },
        { label: 'Start a meeting here', icon: 'message', onSelect: () => meetingIn(sid) },
      ].filter(Boolean));
    }),
    on(root, 'click', '[data-topic-menu]', (e, b) => {
      e.preventDefault();
      e.stopPropagation();
      const s = outline.sections.find((x) => x.id === Number(b.dataset.topicMenu));
      menu(b, [
        { label: 'Rename', icon: 'edit', onSelect: async () => {
          const title = await prompt({ title: 'Rename topic', label: 'Name', value: s.title });
          if (title) await api.patch(`/sections/${s.id}`, { title }).then(refresh, toastError);
        } },
        { label: s.summary ? 'Edit description' : 'Add a description', icon: 'file', onSelect: async () => {
          const summary = await prompt({ title: 'Description', label: 'What this topic covers', value: s.summary, multiline: true, minLength: 0 });
          if (summary !== null && summary !== undefined) await api.patch(`/sections/${s.id}`, { summary }).then(refresh, toastError);
        } },
        { label: 'Move up', icon: 'arrow-up', onSelect: () => api.patch(`/sections/${s.id}`, { move: 'up' }).then(refresh, toastError) },
        { label: 'Move down', icon: 'chevron-down', onSelect: () => api.patch(`/sections/${s.id}`, { move: 'down' }).then(refresh, toastError) },
        { label: 'Move into…', icon: 'layers', onSelect: () => moveTo(s.title, s.parent_id, (to) => api.patch(`/sections/${s.id}`, { parent_id: to })) },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirm({ title: `Delete “${s.title}”?`, message: 'Its topics, files and links are deleted too. Lectures stay and move to General, with their reviews.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/sections/${s.id}`).then(refresh, toastError);
        } },
      ]);
    }),
    on(root, 'click', '[data-item-menu]', (e, b) => {
      const item = outline.items.find((x) => x.id === Number(b.dataset.itemMenu));
      menu(b, [
        { label: 'Rename', icon: 'edit', onSelect: async () => {
          const title = await prompt({ title: 'Rename', label: 'Name', value: item.title });
          if (title) await api.patch(`/course-items/${item.id}`, { title }).then(refresh, toastError);
        } },
        { label: 'Move up', icon: 'arrow-up', onSelect: () => api.patch(`/course-items/${item.id}`, { move: 'up' }).then(refresh, toastError) },
        { label: 'Move down', icon: 'chevron-down', onSelect: () => api.patch(`/course-items/${item.id}`, { move: 'down' }).then(refresh, toastError) },
        { label: 'Move to a topic…', icon: 'layers', onSelect: () => moveTo(item.title, item.section_id, (to) => api.patch(`/course-items/${item.id}`, { section_id: to })) },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirm({ title: `Delete “${item.title}”?`, message: 'Students can no longer open it.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/course-items/${item.id}`).then(refresh, toastError);
        } },
      ]);
    }),
    on(root, 'click', '[data-lecture-move]', (e, b) => {
      const l = outline.lectures.find((x) => x.id === Number(b.dataset.lectureMove));
      moveTo(l.topic, l.section_id, (to) => api.patch(`/lectures/${l.id}/section`, { section_id: to }));
    }),
    on(root, 'click', '[data-outline-live]', async (e, b) => {
      try {
        await api.post('/live/sessions', { course_id: courseId, lecture_id: Number(b.dataset.outlineLive) });
        ctx.navigate(`/live/${courseId}`);
      } catch (error) {
        toastError(error);
      }
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    picker.remove();
  };
}

/**
 * Pictures and documents for the assistant: pick, paste or drop them, shrink pictures
 * in the browser, upload each one as soon as it is added, and show them as small chips
 * above the message box. Sending then only has to pass the ids.
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { sheet } from '../core/ui.js';

export const MAX_FILES = 6;
const MAX_DOCUMENT = 3_000_000;
const MAX_PICTURE_SIDE = 1600;
const KEEP_AS_IS = 700_000;
const DOCUMENT_TYPES = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.json,.html,.tex,.py,.js,.java,.c,.cpp,.sql';
export const ACCEPT = { picture: 'image/*', document: DOCUMENT_TYPES, any: `image/*,${DOCUMENT_TYPES}` };

export const fileUrl = (id) => `/api/assistant/attachments/${id}/file`;

export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const isPicture = (file) => /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name);

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('Could not read that file'));
  reader.readAsDataURL(blob);
});

/** Pictures are shrunk before upload: faster, smaller, and plenty sharp for reading text and diagrams. */
async function preparePicture(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This picture format is not supported. Try a screenshot or a JPEG or PNG.');
  }
  try {
    const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_AS_IS && /^image\/(png|jpeg)$/.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('Could not prepare that picture');
    return blob;
  } finally {
    bitmap.close?.();
  }
}

/**
 * @param tray   element that shows the chips
 * @param onChange  called whenever the list or a status changes
 * @param onError   called with a message for a file that was refused
 */
export function createAttachments({ tray, onChange = () => {}, onError = () => {}, keepFiles = false }) {
  let items = [];
  let seq = 0;

  function paint() {
    tray.hidden = !items.length;
    render(tray, html`${items.map((a) => html`
      <div class="att ${a.kind === 'image' ? 'is-image' : ''} is-${a.status}" data-key="${a.key}">
        ${a.preview ? html`<img src="${a.preview}" alt="">` : html`<span class="att-icon">${icon('file', 18)}</span>`}
        <span class="att-text"><span class="att-name">${a.name}</span><span class="att-sub">${a.status === 'error' ? a.error : a.status === 'uploading' ? 'Adding…' : a.sub}</span></span>
        <button type="button" class="att-remove" data-remove="${a.key}" aria-label="Remove ${a.name}">${icon('x', 14)}</button>
      </div>`)}`);
    onChange(items);
  }

  const update = (key, patch) => {
    const item = items.find((a) => a.key === key);
    if (!item) return;
    Object.assign(item, patch);
    paint();
  };

  async function upload(item, file) {
    try {
      let blob = file;
      if (item.kind === 'image') {
        blob = await preparePicture(file);
        if (blob.size > 2_900_000) throw new Error('That picture is too large');
      } else if (file.size > MAX_DOCUMENT) {
        throw new Error('Too large (3 MB limit)');
      }
      const data = await toBase64(blob);
      // keepFiles: lecture notes keep their PDF pages, so the lecturer can show them full screen.
      const { attachment } = await api.post('/assistant/attachments', { name: item.name, mime: blob.type || file.type, data, ...(keepFiles ? { keep_file: true } : {}) });
      if (!items.includes(item)) {
        api.del(`/assistant/attachments/${attachment.id}`).catch(() => {});
        return;
      }
      update(item.key, {
        status: 'ready',
        id: attachment.id,
        size: attachment.size,
        sub: attachment.kind === 'image' ? sizeLabel(attachment.size) : `${sizeLabel(attachment.size)}${attachment.truncated ? ' · long, start only' : ''}`,
      });
    } catch (error) {
      if (!items.includes(item)) return;
      update(item.key, { status: 'error', error: error.message || 'Could not add this file' });
      onError(`${item.name}: ${error.message || 'could not be added'}`);
    }
  }

  function add(fileList) {
    const files = [...fileList].filter((f) => f && f.size !== undefined);
    for (const file of files) {
      if (items.length >= MAX_FILES) {
        onError(`You can attach up to ${MAX_FILES} files per message`);
        break;
      }
      const picture = isPicture(file);
      const named = file.name && !/^image\.(png|jpe?g)$/i.test(file.name) ? file.name : `Pasted picture ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${picture ? 'png' : 'txt'}`;
      const item = { key: ++seq, name: named.slice(0, 80), kind: picture ? 'image' : 'document', status: 'uploading', preview: picture ? URL.createObjectURL(file) : '', sub: '' };
      items.push(item);
      upload(item, file);
    }
    paint();
  }

  function discard(item) {
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.id) api.del(`/assistant/attachments/${item.id}`).catch(() => {});
  }

  function remove(key) {
    const item = items.find((a) => a.key === Number(key));
    if (!item) return;
    items = items.filter((a) => a !== item);
    discard(item);
    paint();
  }

  tray.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) remove(b.dataset.remove);
  });

  return {
    add,
    remove,
    get count() { return items.length; },
    get uploading() { return items.some((a) => a.status === 'uploading'); },
    get failed() { return items.some((a) => a.status === 'error'); },
    /** The files that are uploaded and ready to send. */
    ready: () => items.filter((a) => a.status === 'ready').map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size })),
    /** Resolves once every file has finished uploading. */
    async settled() {
      while (items.some((a) => a.status === 'uploading')) await new Promise((r) => setTimeout(r, 60));
    },
    /** Forget the files after they were sent; the server has them now. */
    sent() {
      items.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      items = [];
      paint();
    },
    clear() {
      items.forEach(discard);
      items = [];
      paint();
    },
    paint,
  };
}

/** Files inside a sent message: pictures as thumbnails, documents as small cards. */
export function attachmentList(files) {
  if (!files?.length) return '';
  return html`<div class="msg-files">${files.map((f) => (f.kind === 'image'
    ? html`<button type="button" class="msg-pic" data-zoom="${fileUrl(f.id)}" data-name="${f.name}" aria-label="View ${f.name}"><img src="${fileUrl(f.id)}" alt="${f.name}" loading="lazy"></button>`
    : html`<span class="msg-doc">${icon('file', 17)}<span class="att-text"><span class="att-name">${f.name}</span><span class="att-sub">${sizeLabel(f.size)}</span></span></span>`))}</div>`;
}

export function zoomPicture(url, name) {
  sheet({ title: name || 'Picture', wide: true, content: html`<img class="zoom-img" src="${url}" alt="${name || ''}">` });
}

/** Pictures and files can be dropped on `target`; `hint` is shown while something is dragged over. */
export function watchDrops(target, hint, onFiles) {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const show = (on) => hint.classList.toggle('is-on', on);
  const enter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  };
  const over = (e) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const leave = (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  };
  const drop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    onFiles(e.dataTransfer.files);
  };
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', over);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
  };
}

/** Files on the clipboard (a screenshot, a copied picture or file), if any. */
export function pastedFiles(event) {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) return files;
  return [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
}

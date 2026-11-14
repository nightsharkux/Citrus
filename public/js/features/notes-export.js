/**
 * Notes to the phone: the PDF (core/pdf.js, with the graphs as pictures) and the .txt record for any AI. Everything
 * is made on the device and saved straight to it; nothing is uploaded or kept on the server.
 */
import { notesPdf, parseMarkdown } from '../core/pdf.js';
import { parseChart, chartSvg } from '../core/chart.js';
import { native } from './native.js';

/** A file as base64, for the Android app. */
const base64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** Save a file to the device (Downloads on Android and computers, Files on iPhone; the Android app saves it itself). */
export async function saveFile(blob, name) {
  if (native.available()) {
    native.send('save', { name, mime: blob.type || 'application/octet-stream', data: await base64(blob) });
    return;
  }
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

export const saveText = (text, name) => saveFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), name.endsWith('.txt') ? name : `${name}.txt`);

/** A graph as a JPEG at twice its size, on white. */
function svgToJpeg(markup, width = 1280, height = 800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width, height });
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, width, height);
      g.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('No picture'));
        resolve({ data: new Uint8Array(await blob.arrayBuffer()), width, height });
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No picture'));
    };
    img.src = url;
  });
}

/** Pictures of the ```chart blocks in the notes, keyed by their code. A graph that fails is left out. */
export async function chartImages(markdown) {
  const images = new Map();
  for (const block of parseMarkdown(markdown).filter((b) => b.type === 'chart')) {
    const spec = parseChart(block.code);
    if (!spec || images.has(block.code)) continue;
    try {
      images.set(block.code, await svgToJpeg(chartSvg(spec)));
    } catch {
      /* the PDF says to open the notes in the app instead */
    }
  }
  return images;
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#F07A2E';

/** Make the PDF of some notes and save it. `figure`: the minute-by-minute timeline from the lecture record. */
export async function savePdf({ markdown, name, title = '', subtitle = '', kicker = 'Campus OS', figure = null }) {
  const bytes = notesPdf({ markdown, title, subtitle, kicker, figure, accent: accent(), images: await chartImages(markdown) });
  await saveFile(new Blob([bytes], { type: 'application/pdf' }), name.endsWith('.pdf') ? name : `${name}.pdf`);
}

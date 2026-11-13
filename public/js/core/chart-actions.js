/**
 * The buttons under a graph (core/chart.js): copy it as a picture, save it as PNG or as SVG. One listener for the
 * whole app, wired by the shell.
 */
import { toast } from './ui.js';

function save(blob, name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/** The figure as a PNG at twice its size, on white, like a page from a book. */
function toPng(markup) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not make a picture'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not make a picture'));
    };
    img.src = url;
  });
}

async function act(button) {
  const svg = button.closest('figure.chart')?.querySelector('svg');
  if (!svg) return;
  const markup = new XMLSerializer().serializeToString(svg);
  const name = (svg.getAttribute('aria-label') || 'graph').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'graph';
  const kind = button.dataset.chartAction;
  if (kind === 'svg') return save(new Blob([markup], { type: 'image/svg+xml' }), `${name}.svg`);
  let png;
  try {
    png = await toPng(markup);
  } catch (error) {
    return toast(error.message, 'error');
  }
  if (kind === 'png') return save(png, `${name}.png`);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Graph copied. Paste it into your notes or slides.', 'success', { duration: 2400 });
  } catch {
    save(png, `${name}.png`);
    toast('This browser does not allow copying pictures here, so the graph was saved instead.', 'info', { duration: 4200 });
  }
}

let wired = false;
export function wireChartActions() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (e) => {
    const button = e.target.closest?.('[data-chart-action]');
    if (button) act(button);
  });
}

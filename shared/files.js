/**
 * Everything both sides need to know about an attachment. Any file type may be
 * uploaded - a QA round produces screenshots, but also ads.txt snippets, tag
 * exports, HAR captures and log files.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The types a browser may render in place. Everything else is stored and served
 * as a download.
 *
 * SVG is deliberately not here: it is a document that can carry script, so an
 * inline SVG upload would be a cross-site scripting hole on our own origin.
 */
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function isInlineType(mime) {
  return INLINE_MIME.has(String(mime ?? '').toLowerCase().split(';')[0].trim());
}

/** Human-readable size, for a file chip that is not an image. */
export function formatBytes(bytes) {
  // Number(null) is 0, so a missing size used to render as "0 B".
  if (bytes == null || bytes === '') return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A coarse bucket, used only to pick an icon glyph in the file chip. */
export function fileKind(mime, filename) {
  const type = String(mime ?? '').toLowerCase();
  const extension = /\.([a-z0-9]{1,8})$/i.exec(String(filename ?? ''))?.[1]?.toLowerCase() ?? '';

  if (isInlineType(type)) return 'image';
  if (type.startsWith('image/')) return 'image-file';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (['zip', 'gz', 'tgz', 'rar', '7z', 'bz2'].includes(extension)) return 'archive';
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(extension)) return 'sheet';
  if (type.startsWith('text/') || ['txt', 'log', 'md', 'json', 'xml', 'har', 'js', 'html', 'css', 'yml', 'yaml'].includes(extension)) return 'text';
  return 'file';
}

export const FILE_GLYPH = {
  'image-file': '🖼',
  video: '🎬',
  audio: '🎧',
  pdf: '📕',
  archive: '🗜',
  sheet: '📊',
  text: '📄',
  file: '📎',
};

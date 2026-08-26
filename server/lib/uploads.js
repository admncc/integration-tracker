import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? resolve(process.env.UPLOAD_DIR)
  : resolve(process.cwd(), 'data/uploads');

mkdirSync(UPLOAD_DIR, { recursive: true });

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Screenshots are what QA actually sends; nothing else needs to be accepted. */
const EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export const ALLOWED_MIME = Object.keys(EXTENSION_BY_MIME);

/**
 * Writes a buffer under a random key. The client-supplied filename is kept for
 * display only - it never touches the path, so it cannot escape UPLOAD_DIR.
 */
export function storeUpload(buffer, mime) {
  const extension = EXTENSION_BY_MIME[mime];
  if (!extension) throw new Error(`Unsupported image type: ${mime}`);

  const key = `${randomBytes(16).toString('hex')}.${extension}`;
  writeFileSync(resolve(UPLOAD_DIR, key), buffer);
  return key;
}

export function uploadPath(key) {
  // Defence in depth: a storage key from the database should already be safe.
  if (!/^[0-9a-f]{32}\.[a-z]{3,4}$/.test(key)) throw new Error('Invalid storage key');
  return resolve(UPLOAD_DIR, key);
}

export function removeUpload(key) {
  try {
    rmSync(uploadPath(key), { force: true });
  } catch {
    /* the row is going away regardless */
  }
}

/** Keeps a display filename harmless: no separators, no control characters. */
export function safeFilename(raw) {
  const name = [...String(raw ?? '')]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('')
    .replaceAll('\\', '_')
    .replaceAll('/', '_')
    .trim();

  if (name.length <= 120) return name || 'screenshot';

  // Cutting at 120 used to take the extension with it.
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 120 - extension.length) + extension;
}

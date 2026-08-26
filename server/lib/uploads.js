import './env.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export { MAX_UPLOAD_BYTES, formatBytes, isInlineType } from '../../shared/files.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? resolve(process.env.UPLOAD_DIR)
  : resolve(process.cwd(), 'data/uploads');

mkdirSync(UPLOAD_DIR, { recursive: true });

/** A short, lower-case, alphanumeric extension taken from the display name. */
function extensionFor(filename, mime) {
  const fromName = /\.([a-zA-Z0-9]{1,8})$/.exec(String(filename ?? ''))?.[1];
  if (fromName) return fromName.toLowerCase();

  const fromMime = String(mime ?? '').split('/')[1]?.split('+')[0];
  return /^[a-z0-9]{1,8}$/.test(fromMime ?? '') ? fromMime : 'bin';
}

/**
 * Writes a buffer under a random key. The client-supplied filename is kept for
 * display only - it never touches the path, so it cannot escape UPLOAD_DIR.
 */
export function storeUpload(buffer, mime, filename) {
  const key = `${randomBytes(16).toString('hex')}.${extensionFor(filename, mime)}`;
  writeFileSync(resolve(UPLOAD_DIR, key), buffer);
  return key;
}

export function uploadPath(key) {
  // Defence in depth: a storage key from the database should already be safe.
  if (!/^[0-9a-f]{32}\.[a-z0-9]{1,8}$/.test(key)) throw new Error('Invalid storage key');
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

  if (name.length <= 120) return name || 'attachment';

  // Cutting at 120 used to take the extension with it.
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 120 - extension.length) + extension;
}

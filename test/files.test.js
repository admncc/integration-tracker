import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, formatBytes, isInlineType } from '../shared/files.js';
import { safeFilename } from '../server/lib/uploads.js';

test('only raster images render in place', () => {
  assert.equal(isInlineType('image/png'), true);
  assert.equal(isInlineType('IMAGE/JPEG'), true);
  assert.equal(isInlineType('image/png; charset=binary'), true);
  // An SVG is a document that can carry script - it must be served as a download.
  assert.equal(isInlineType('image/svg+xml'), false);
  assert.equal(isInlineType('text/html'), false);
  assert.equal(isInlineType('text/plain'), false);
  assert.equal(isInlineType(''), false);
  assert.equal(isInlineType(null), false);
});

test('formatBytes reads at a glance', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(null), '');
});

test('fileKind picks a bucket from the type or the extension', () => {
  assert.equal(fileKind('image/png', 'shot.png'), 'image');
  assert.equal(fileKind('text/plain', 'ads.txt'), 'text');
  assert.equal(fileKind('application/octet-stream', 'network.har'), 'text');
  assert.equal(fileKind('application/pdf', 'report.pdf'), 'pdf');
  assert.equal(fileKind('application/zip', 'tags.zip'), 'archive');
  assert.equal(fileKind('', 'numbers.csv'), 'sheet');
  assert.equal(fileKind('image/svg+xml', 'logo.svg'), 'image-file');
  assert.equal(fileKind('', 'thing.unknownext'), 'file');
});

test('safeFilename keeps the extension when it has to truncate', () => {
  const long = `${'a'.repeat(200)}.txt`;
  const cut = safeFilename(long);
  assert.equal(cut.length, 120);
  assert.ok(cut.endsWith('.txt'));
});

test('safeFilename cannot produce a path', () => {
  assert.equal(safeFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFilename('a\\b.txt'), 'a_b.txt');
  assert.equal(safeFilename(`with${String.fromCharCode(0)}null.txt`), 'withnull.txt');
  assert.equal(safeFilename(''), 'attachment');
});

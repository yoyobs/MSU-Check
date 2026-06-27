import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('uses a fourteen day transfer history window by default', async () => {
  const server = await readFile(join(rootDir, 'server.js'), 'utf8');

  assert.match(
    server,
    /const HISTORY_WINDOW_DAYS = Number\(process\.env\.HISTORY_WINDOW_DAYS \|\| 14\);/,
  );
});

test('renders fourteen day history copy in the frontend', async () => {
  const html = await readFile(join(rootDir, 'public', 'index.html'), 'utf8');

  assert.match(html, /checked\?\.days \|\| 14/);
  assert.match(html, /显示最近 14 天内/);
  assert.match(html, /最近 \$\{escapeHtml\(data\.checked\?\.days \|\| 14\)\} 天内/);
  assert.doesNotMatch(html, /最近 7 天|显示最近 7 天内|days \|\| 7/);
});

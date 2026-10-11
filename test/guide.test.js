import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

test('bundled visual guide and About assets work without exposing workspace files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-guide-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await startServer({ root, port: 0 });
  t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const pages = new Map();
  for (const route of ['/', '/guide']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    pages.set(route, await response.text());
  }
  assert.match(pages.get('/'), /data-tab="about"/);
  assert.match(pages.get('/'), /id="about"[^>]*hidden/);
  assert.match(pages.get('/'), /href="\/guide"/);
  // Check every public URL used by the bundled pages, including shared images.
  const references = new Set([...pages.values()].flatMap(html => [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map(match => match[1])));
  for (const reference of references) {
    assert.ok(reference.startsWith('/'), `Help must not load an external asset: ${reference}`);
    const response = await fetch(new URL(reference, origin));
    assert.equal(response.status, 200, `Broken help reference: ${reference}`);
    if (reference.endsWith('.svg')) {
      assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
      const svg = await response.text();
      assert.match(svg, /<svg\b/);
      assert.match(svg, /<title[\s>]/);
      assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bon\w+=/i);
    }
    if (reference.endsWith('.png')) {
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  }
  for (const route of ['/__proto__', '/constructor', '/.nexus/config.json', '/guide-assets/private.png', '/docs/user-guide.md', '/guide-assets/%2e%2e%2f%2e%2e%2f.nexus/config.json', '/ui/app.js']) {
    assert.equal((await fetch(origin + route)).status, 404, route);
  }
  assert.equal((await fetch(origin + '/guide', { method: 'POST' })).status, 404);
  assert.equal((await fetch(origin + '/guide', { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(origin + '/api/state')).status, 401);
});

test('illustrated Markdown guide references existing, accessible bundled images', async () => {
  const guideUrl = new URL('../docs/user-guide.md', import.meta.url);
  const guide = await readFile(guideUrl, 'utf8');
  const images = [...guide.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  assert.ok(images.length >= 5, 'Guide should contain actual illustrations');
  for (const [, alt, source] of images) {
    assert.ok(alt.trim().length > 20, `Describe illustration: ${source}`);
    assert.ok(!source.includes('://'), 'Guide images should work offline');
    const bytes = await readFile(new URL(source, guideUrl));
    assert.ok(bytes.length > 100, `Empty illustration: ${source}`);
  }
});

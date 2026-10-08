import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderJson } from '../src/providers.js';

test('provider reader handles chunked JSON and cancels oversized bodies', async () => {
  assert.deepEqual(await readProviderJson(Response.json({ text: 'hello 🌎' })), { text: 'hello 🌎' });
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(readProviderJson(new Response(stream), 12), /limit/);
  assert.equal(cancelled, true);
  await assert.rejects(readProviderJson(new Response('not JSON')), SyntaxError);
  await assert.rejects(readProviderJson(new Response(null)), /empty/);
});

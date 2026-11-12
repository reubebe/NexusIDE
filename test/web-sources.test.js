import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createWebSourceAcquirer, publicAddress, approvedWebUrl, robotsAllows, listWebSources, removeWebSource } from '../src/web-sources.js';
import { writeState } from '../src/state.js';

const input = { url: 'https://source.example/article', approved: true, rights: 'User-approved test fixture' };
const publicDns = [{ address: '93.184.215.14', family: 4 }];
const absentRobots = { status: 404, body: '' };
const page = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<h1>Evidence</h1><script>unsafe()</script>' };

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-web-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function transport(replies = [absentRobots, page], resolve = async () => publicDns) {
  const requests = [], dns = [];
  let started;
  const firstRequest = new Promise(done => { started = done; });
  const acquire = createWebSourceAcquirer({
    resolve: async (hostname, options) => { dns.push({ hostname, options }); return resolve(hostname, options, dns.length); },
    get: (url, options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      req.setTimeout = (milliseconds, listener) => { req.timeout = listener; req.timeoutMs = milliseconds; };
      const entry = { url, options, req };
      requests.push(entry);
      queueMicrotask(() => {
        if (req.destroyed) return;
        // Exercise the exact socket lookup callbacks, including Node's all form.
        options.lookup(url.hostname, {}, (error, address, family) => { assert.ifError(error); entry.pinned = { address, family }; });
        options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.ifError(error); entry.pinnedAll = addresses; });
        const reply = replies[requests.length - 1];
        assert.ok(reply, 'an unapproved additional request was attempted');
        const res = new PassThrough();
        entry.res = res;
        res.statusCode = reply.status;
        res.headers = reply.headers || {};
        callback(res);
        started(entry);
        if (reply.run) reply.run(entry);
        else if (!res.destroyed) res.end(reply.body || '');
      });
      return req;
    },
  });
  return { acquire, requests, dns, firstRequest };
}

test('acquisition requests robots then only the approved path, pins DNS and saves a verifiable receipt', async t => {
  const root = await project(t), h = transport();
  const receipt = await h.acquire(root, input);
  assert.deepEqual(h.requests.map(r => r.url.href), ['https://source.example/robots.txt', input.url]);
  assert.equal(h.dns.length, 2);
  for (const r of h.requests) {
    assert.equal(r.options.agent, false);
    assert.equal(r.options.family, 4);
    assert.equal(r.options.autoSelectFamily, false);
    assert.equal(r.options.maxHeaderSize, 16384);
    assert.equal(r.options.headers['accept-encoding'], 'identity');
    assert.equal(r.options.rejectUnauthorized, undefined, 'TLS verification stays at the secure default');
    assert.equal(r.req.timeoutMs, 10000);
    assert.deepEqual(r.pinned, publicDns[0]);
    assert.deepEqual(r.pinnedAll, publicDns);
  }
  assert.equal(receipt.text, 'Evidence');
  assert.equal(receipt.sourceSha256, createHash('sha256').update(page.body).digest('hex'));
  assert.equal(receipt.url, input.url);
  assert.equal(receipt.finalUrl, input.url);
  assert.equal(receipt.robots, 'not-present');
  assert.equal(receipt.truncated, false);
  assert.deepEqual(await listWebSources(root), [receipt]);
  await assert.rejects(removeWebSource(root, '../escape'), /Invalid source id/);
  await removeWebSource(root, receipt.id);
  assert.deepEqual(await listWebSources(root), []);
});

test('approval and URL constraints reject before DNS or HTTPS', async t => {
  const root = await project(t), h = transport();
  for (const changes of [{ approved: false }, { rights: '' }, { url: 'https://localhost./' }, { url: 'https://[2606:4700::1111]/' }, { url: 'https://a.local./' }, { url: 'https://source.example/article?token=secret' }]) {
    await assert.rejects(h.acquire(root, { ...input, ...changes }));
  }
  assert.equal(h.dns.length, 0);
  assert.equal(h.requests.length, 0);
  assert.throws(() => approvedWebUrl('https://source.example/' + 'x'.repeat(8192)), /8192/);
});

test('reserved IPv6 subnets include compressed and expanded spellings', () => {
  for (const ip of ['2001:20::1', '2001:30::1', '2001:1ff::1', '2001:0000:0000:0000:0000:0000:0000:0001', '2001:0db8::1', '3ffe::1', '3fff:fff::1', '64:ff9b::7f00:1', '::ffff:8.8.8.8', '2606:4700::1%eth0', '192.88.99.1']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '8.8.8.8']) assert.equal(publicAddress(ip), true, ip);
});

test('mixed public/private DNS and reserved IPv6 fail closed before the first HTTPS request', async t => {
  const root = await project(t);
  for (const addresses of [[], [...publicDns, { address: '127.0.0.1', family: 4 }], [{ address: '3fff::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const h = transport(undefined, async () => addresses);
    await assert.rejects(h.acquire(root, input), /prohibited network/);
    assert.equal(h.requests.length, 0);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('DNS is revalidated after robots and cannot rebind the page to a private address', async t => {
  const root = await project(t);
  const h = transport(undefined, async (_hostname, _options, n) => n === 1 ? publicDns : [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(h.acquire(root, input), /prohibited network/);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await listWebSources(root), []);
});

test('valid IPv6 is pinned without falling back to another address', async t => {
  const root = await project(t), addresses = [{ address: '2606:4700:4700::1111', family: 6 }, ...publicDns];
  const h = transport(undefined, async () => addresses);
  await h.acquire(root, input);
  for (const r of h.requests) {
    assert.deepEqual(r.pinned, addresses[0]);
    assert.deepEqual(r.pinnedAll, [addresses[0]]);
    assert.equal(r.options.family, 6);
  }
});

test('page redirects are denied without contacting their destinations', async t => {
  const root = await project(t);
  for (const location of ['https://private.example/data', '/different-path', input.url, 'http://source.example/article', 'https://127.0.0.1/']) {
    const h = transport([absentRobots, { status: 302, headers: { location }, body: '' }]);
    await assert.rejects(h.acquire(root, input), /Redirects are not allowed/);
    assert.equal(h.requests.length, 2);
    assert.equal(h.dns.length, 2);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('robots redirects, denial, delays, request rates and unreadable policies prevent page requests', async t => {
  const root = await project(t);
  const policy = body => ({ status: 200, headers: { 'content-type': 'text/plain' }, body });
  for (const robots of [
    { status: 302, headers: { location: '/other-robots' } }, { status: 503 },
    policy('User-agent: *\nDisallow: /article'), policy('User-agent: *\nCrawl-delay: 2'),
    policy('User-agent: *\nRequest-rate: 1/10'), policy('User-agent: *\nCrawl-delay: invalid'),
    { ...policy(''), headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } },
    { ...policy(''), headers: { 'content-type': 'text/html' } },
    policy('User-agent: *\nDisallow: /' + 'a'.repeat(8192)),
  ]) {
    const h = transport([robots]);
    await assert.rejects(h.acquire(root, input), /Robots|crawl delay|request rate/);
    assert.equal(h.requests.length, 1);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('robots handles wildcard/end anchors and encoded paths without executable patterns', () => {
  const allows = (rule, pathname) => robotsAllows('User-agent: *\nDisallow: ' + rule, pathname);
  assert.equal(allows('/article$', '/article'), false);
  assert.equal(allows('/article$', '/articles'), true);
  assert.equal(allows('/*private$', '/a/private/private'), false);
  assert.equal(allows('/article', '/%61rticle'), false);
  assert.equal(allows('/caf%C3%A9', '/caf%C3%A9'), false);
  assert.equal(allows('/café', '/caf%C3%A9'), false);
  assert.equal(allows('/(a+)+$', '/aaaa'), true);
  assert.equal(robotsAllows('User-agent: OtherBot\nDisallow: /article\nUser-agent: *\nAllow: /article', '/article'), false);
});

test('robots and page byte limits abort downloads and save no partial receipt', async t => {
  const root = await project(t);
  for (const replies of [
    [{ status: 200, headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(100001) }],
    [absentRobots, { ...page, body: 'x'.repeat(1000001) }],
    [absentRobots, { ...page, headers: { ...page.headers, 'content-length': '1000001' }, body: '' }],
  ]) {
    const h = transport(replies);
    await assert.rejects(h.acquire(root, input), /byte limit/);
    assert.equal(h.requests.at(-1).req.destroyed, true);
    assert.equal(h.requests.at(-1).res.destroyed, true);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('compressed, non-text and unsuccessful page responses are not stored', async t => {
  const root = await project(t);
  for (const response of [{ ...page, status: 403 }, { ...page, headers: { 'content-type': 'application/pdf' } }, { ...page, headers: { ...page.headers, 'content-encoding': 'br' } }]) {
    await assert.rejects(transport([absentRobots, response]).acquire(root, input), /allowed uncompressed text/);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('cancellation during DNS returns promptly and late DNS results cannot start a request', { timeout: 2000 }, async t => {
  const root = await project(t), controller = new AbortController();
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const h = transport(undefined, () => { began(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.acquire(root, input, { signal: controller.signal });
  await started;
  controller.abort(new Error('Canceled by user'));
  await assert.rejects(pending, /Canceled by user/);
  release(publicDns);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(await listWebSources(root), []);
});

test('cancellation while receiving a response destroys it and stores no receipt', async t => {
  const root = await project(t), controller = new AbortController();
  const h = transport([{ ...absentRobots, run: () => {} }]);
  const pending = h.acquire(root, input, { signal: controller.signal });
  const request = await h.firstRequest;
  controller.abort(new Error('Canceled by user'));
  await assert.rejects(pending, /Canceled by user/);
  assert.equal(request.req.destroyed, true);
  assert.equal(request.res.destroyed, true);
  assert.deepEqual(await listWebSources(root), []);
});

test('timeouts, interrupted bodies and socket errors cannot produce successful receipts', async t => {
  const root = await project(t);
  for (const run of [entry => entry.req.timeout(), entry => entry.res.emit('aborted'), entry => entry.req.emit('error', new Error('Socket failed'))]) {
    const h = transport([{ ...absentRobots, run }]);
    await assert.rejects(h.acquire(root, input), /timeout|before completion|Socket failed/);
    assert.equal(h.requests[0].req.destroyed, true);
  }
  assert.deepEqual(await listWebSources(root), []);
});

test('hash covers original bytes and text truncation is reported accurately', async t => {
  const root = await project(t);
  for (const length of [200000, 200001]) {
    const body = Buffer.concat([Buffer.from('x'.repeat(length)), Buffer.from([0xff])]);
    const receipt = await transport([absentRobots, { ...page, body }]).acquire(root, input);
    assert.equal(receipt.text.length, 200000);
    assert.equal(receipt.truncated, true);
    assert.equal(receipt.sourceSha256, createHash('sha256').update(body).digest('hex'));
  }
  const exact = await transport([absentRobots, { ...page, body: 'x'.repeat(200000) }]).acquire(root, input);
  assert.equal(exact.truncated, false);
});

test('storage stays at 100 receipts under concurrent acquisition and deletion frees space', async t => {
  const root = await project(t);
  const ids = Array.from({ length: 99 }, () => randomUUID());
  for (const id of ids) await writeState(root, 'web-sources', id + '.json', { id, text: 'fixture' }, { exclusive: true });
  const outcomes = await Promise.allSettled([transport().acquire(root, input), transport().acquire(root, input)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(r => r.status === 'rejected').reason.message, /storage limit|busy/);
  assert.equal((await listWebSources(root)).length, 100);
  const h = transport();
  await assert.rejects(h.acquire(root, input), /storage limit/);
  assert.equal(h.dns.length, 0);
  await removeWebSource(root, ids[0]);
  await h.acquire(root, input);
  assert.equal((await listWebSources(root)).length, 100);
});

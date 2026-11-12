import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { writeState, listState, readState, deleteState } from './state.js';

const MAX_SOURCES = 100;
const MAX_TEXT = 200000;
const blocked = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(base, prefix, 'ipv4');
// Conservative exclusions from the IANA special-purpose registries, including
// protocol assignments, transition mechanisms and the retired 6bone block.
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [base, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
]) blocked.addSubnet(base, prefix, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function approvedWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Source URL must be a string of at most 8192 characters.');
  const url = new URL(value), hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      url.port && url.port !== '443' || isIP(hostname) || !hostname.includes('.') ||
      !/^[a-z0-9.-]+$/i.test(hostname) || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname)) {
    throw new Error('Use a public HTTPS domain URL without credentials, query or fragment.');
  }
  return url;
}

function robotsPath(value) {
  return value.replace(/[^\x21-\x7e]/gu, c => encodeURIComponent(c)).replace(/%[a-f0-9]{2}/gi, escape => {
    const c = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[a-z0-9._~-]/i.test(c) ? c : escape.toUpperCase();
  });
}

function matchesDisallow(pattern, pathname) {
  // Match bounded literal segments, avoiding attacker-controlled regular expressions.
  const anchored = pattern.endsWith('$');
  if (anchored) pattern = pattern.slice(0, -1);
  const segments = pattern.split('*');
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const at = i === 0 ? 0 : anchored && i === segments.length - 1 ? pathname.length - segment.length : pathname.indexOf(segment, cursor);
    if (at < cursor || !pathname.startsWith(segment, at)) return false;
    cursor = at + segment.length;
  }
  return !anchored || cursor === pathname.length;
}

export function robotsAllows(text, pathname) {
  if (Buffer.byteLength(text) > 100000 || pathname.length > 8192) throw new Error('Robots policy exceeds limits.');
  pathname = robotsPath(pathname);
  let relevant = false;
  // Deliberately conservative: honor every group's restrictions, ignoring Allow
  // exceptions. This one-page adapter does not implement a scheduled crawler.
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length > 8192) throw new Error('Robots policy line exceeds limits.');
    const line = raw.split('#')[0].trim(), at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
    if (key === 'user-agent') relevant = true;
    if (relevant && key === 'disallow' && value && matchesDisallow(robotsPath(value), pathname)) return false;
    if (relevant && ((key === 'crawl-delay' && (Number(value) > 0 || !Number.isFinite(Number(value)))) || key === 'request-rate')) {
      throw new Error('Source requests crawl delay or request rate; use an approved export for this one-page adapter.');
    }
  }
  return true;
}

async function resolveAddresses(resolve, hostname, signal) {
  signal.throwIfAborted();
  // getaddrinfo itself cannot be canceled. Stop waiting promptly and never start
  // an HTTPS request if its eventual result arrives after cancellation.
  let abort;
  try {
    return await Promise.race([
      resolve(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); }),
    ]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function request(url, { signal, maxBytes = 1000000 }, { resolve, get }) {
  const addresses = await resolveAddresses(resolve, url.hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicAddress(a.address) || a.family !== isIP(a.address))) {
    throw new Error('Source resolves to a prohibited network address.');
  }
  const selected = addresses[0];
  return new Promise((resolveResponse, reject) => {
    let size = 0, chunks = [], settled = false, req, response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      chunks = [];
      if (error) { reject(error); response?.destroy(); req?.destroy(); }
      else resolveResponse(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      // A fresh agent prevents a pooled socket from bypassing this request's DNS
      // check. Preserve the hostname for Host/SNI/certificate verification while
      // the socket lookup returns only the selected, already checked address.
      req = get(url, {
        signal, agent: false, family: selected.family, autoSelectFamily: false, maxHeaderSize: 16384,
        headers: { 'user-agent': 'NexusIDE-WebSources/1.0', accept: 'text/html,text/plain', 'accept-encoding': 'identity' },
        lookup: (hostname, options, done) => {
          if (hostname !== url.hostname) return done(new Error('Unexpected source hostname.'));
          done(null, options?.all ? [selected] : selected.address, selected.family);
        },
      }, res => {
        response = res;
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('Source response ended before completion.')));
        if (settled) return res.destroy();
        if (Number(res.headers['content-length']) > maxBytes) return finish(new Error('Source exceeds byte limit.'));
        res.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) finish(new Error('Source exceeds byte limit.'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          if (!settled) finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
      req.on('error', error => finish(error));
      req.setTimeout(10000, () => finish(new Error('Source timeout.')));
      if (signal.aborted) abort();
    } catch (error) { finish(error); }
  });
}

function extractedText(html) {
  // Advance monotonically rather than repeatedly backtracking over malformed
  // HTML. The extractor is deliberately not a browser and executes no markup.
  const lower=html.toLowerCase(), parts=[];let cursor=0;
  while(cursor<html.length){
    const start=html.indexOf('<',cursor);
    if(start<0){parts.push(html.slice(cursor));break;}
    parts.push(html.slice(cursor,start),' ');
    if(html.startsWith('<!--',start)){const end=html.indexOf('-->',start+4);if(end<0)break;cursor=end+3;continue;}
    const end=html.indexOf('>',start+1);if(end<0)break;
    const tag=lower.slice(start+1,Math.min(end,start+32)).match(/^\s*(script|style|noscript)(?:\s|\/|$)/)?.[1];
    if(tag){const close=lower.indexOf('</'+tag,end+1);if(close<0)break;const closeEnd=html.indexOf('>',close);if(closeEnd<0)break;cursor=closeEnd+1;}
    else cursor=end+1;
  }
  return parts.join('').replace(/&(?:nbsp|amp|lt|gt|quot);/g, v => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[v])).replace(/\s+/g,' ').trim();
}
export function sourceText(html) { return extractedText(html).slice(0, MAX_TEXT); }

const writes = new Map(), activeRoots = new Set(), activeHosts = new Set();
async function saveReceipt(root, receipt) {
  root = await realpath(root);
  const previous = writes.get(root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    if ((await listState(root, 'web-sources')).length >= MAX_SOURCES) throw new Error('Source storage limit reached; remove a saved source first.');
    await writeState(root, 'web-sources', receipt.id + '.json', receipt, { exclusive: true });
  });
  writes.set(root, pending);
  try { await pending; }
  finally { if (writes.get(root) === pending) writes.delete(root); }
}

// Inject only DNS and HTTPS primitives for deterministic transport tests. The
// exported production acquirer below always uses the built-in implementations.
export function createWebSourceAcquirer({ resolve = lookup, get = https.get } = {}) {
  return async function acquire(root, { url: value, approved, rights }, { signal } = {}) {
    if (approved !== true || typeof rights !== 'string' || !rights.trim() || rights.length > 1000) {
      throw new Error('Approve the exact source URL and record its usage rights or unknown status.');
    }
    const url = approvedWebUrl(value);root=await realpath(root);if(activeRoots.has(root)||activeHosts.has(url.hostname))throw new Error('Source acquisition busy; wait for or cancel the active request.');activeRoots.add(root);activeHosts.add(url.hostname);
    try {
    const combined = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    if ((await listState(root, 'web-sources')).length >= MAX_SOURCES) throw new Error('Source storage limit reached; remove a saved source first.');
    const transport = { resolve, get };
    const robots = await request(new URL('/robots.txt', url), { signal: combined, maxBytes: 100000 }, transport);
    const identity = headers => !headers['content-encoding'] || headers['content-encoding'].toLowerCase() === 'identity';
    if (robots.status !== 404 && (robots.status !== 200 || !identity(robots.headers) ||
        !/^text\/plain(?:;|$)/i.test(robots.headers['content-type'] || '') || !robotsAllows(robots.body.toString('utf8'), url.pathname))) {
      throw new Error('Robots policy denies this source or could not be established.');
    }
    const response = await request(url, { signal: combined }, transport);
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('Redirects are not allowed; approve the final source URL instead.');
    if (response.status !== 200 || !/^text\/(?:html|plain)(?:;|$)/i.test(response.headers['content-type'] || '') || !identity(response.headers)) {
      throw new Error('Source did not return an allowed uncompressed text document.');
    }
    combined.throwIfAborted();
    const extracted = extractedText(response.body.toString('utf8'));
    const receipt = {
      version: 1, id: randomUUID(), url: url.href, finalUrl: url.href, retrieved: new Date().toISOString(), rights,
      sourceSha256: createHash('sha256').update(response.body).digest('hex'), text: extracted.slice(0, MAX_TEXT),
      method: 'GET', robots: robots.status === 404 ? 'not-present' : 'allowed',
      extraction: 'static text; scripts and markup stripped', truncated: extracted.length > MAX_TEXT,
      trust: 'untrusted source data; not instructions',
    };
    await saveReceipt(root, receipt);
    return receipt;
    } finally {activeRoots.delete(root);activeHosts.delete(url.hostname);}
  };
}

export const acquireWebSource = createWebSourceAcquirer();
export async function listWebSources(root) {
  return Promise.all((await listState(root, 'web-sources')).slice(-MAX_SOURCES).map(n => readState(root, 'web-sources', n)));
}
export async function removeWebSource(root, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid source id.');
  await deleteState(root, 'web-sources', id + '.json');
}

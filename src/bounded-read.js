// Read from an already-open descriptor without trusting an earlier size check.
export async function boundedRead(handle, maxBytes, { allowUnlinkedSnapshot = false } = {}) {
  const before = await handle.stat();
  const safeLinks = count => count === 1 || (allowUnlinkedSnapshot && count === 0);
  if (!before.isFile() || !safeLinks(before.nlink) || before.size > maxBytes) throw new Error('Expected a singly linked regular file within the read limit.');
  const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  const after = await handle.stat();
  // Atomic state replacement unlinks the previous inode; its open snapshot is
  // still valid. Project reads do not opt into this exception.
  const replaced = allowUnlinkedSnapshot && after.nlink === 0;
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || (!replaced && after.ctimeMs !== before.ctimeMs) || !safeLinks(after.nlink)) throw new Error('File changed while reading; retry.');
  return buffer.subarray(0, size);
}

export function utf8Text(buffer) {
  const text = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(text).equals(buffer)) throw new Error('Expected UTF-8 text, not a binary file.');
  return text;
}

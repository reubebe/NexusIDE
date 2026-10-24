# Cortex knowledge connector

Nexus can retrieve curated knowledge from a separately installed Cortex 0.2
engine and an explicitly selected brain. Nexus continues to own run history and
operational memory; Cortex owns its Markdown knowledge and review labels. No
brain contents or local paths are bundled with Nexus.

The adapter exposes three tools:

| Tool | Result |
| --- | --- |
| `cortex_find` | Ranked notes, optional type/tag/review-status filters, bundle paths and SHA-256 content hashes |
| `cortex_read` | A bounded page at the hash returned by discovery; refuses changed files |
| `cortex_context` | Whole matching notes selected using Cortex ranking, with status and citations within a character budget |

Only Markdown under the selected brain's `notes/` directory is available. Raw
sources, inbox drafts, configuration and files outside that directory are not
exposed. The adapter never calls Cortex's compile, capture, mode, verify or serve
commands. Saving knowledge back to Cortex is not implemented.

## Configure

Requirements: macOS or Linux, Python 3.10+, and your reviewed local Cortex
`cortex.py`. The descriptor-based filesystem boundary currently does not support
native Windows. Windows Nexus users can run this adapter in a separately
configured Linux/WSL environment; that arrangement has not been validated here.

For the simple setup, review your installed engine and run from the intended Nexus workspace:

```sh
nexus extras install cortex --engine /absolute/path/cortex/cortex.py --brain /absolute/path/cortex/brain
```

From the Nexus source checkout use `npm start -- extras install cortex ...`.
Use `--python /absolute/path/python3` if Python is not on your application's PATH.
Setup pins the engine's SHA-256, adds the read-only agent, and merges the connection
without changing other providers or model routes. It backs up configuration in
private `.nexus/backups` and refuses to replace a differing existing connection.
Setup reads engine bytes but does not execute them or scan knowledge. The first
approved MCP connection loads the pinned engine with local Python permissions.

For manual configuration:

1. Review your installed Cortex engine and obtain its SHA-256:

   ```sh
   shasum -a 256 /path/to/cortex/cortex.py
   ```

2. Copy the `mcp.cortex` entry from
   [the example profile](../integrations/cortex.example.json) into the workspace's
   advanced connection configuration. Replace the Python, adapter, engine and
   brain paths with absolute paths and replace the hash placeholder. Merge the
   entry into your current configuration; do not replace existing providers or
   MCP entries. Keep this configuration in private `.nexus` state.
3. From the Nexus source folder, install the read-only agent:

   ```sh
   npm start -- install examples/cortex-reader.json
   ```

   For another workspace, run `nexus install /path/to/NexusIDE/examples/cortex-reader.json`
   there. Existing agents are not overwritten.
4. Select `cortex-reader` in Agents, choose the intended model account, then ask
   a question about your knowledge. Nexus asks for approval when connecting the
   MCP process and for each query. If you choose a cloud model, approved tool
   output enters that model's context. Choosing a local model avoids that provider
   transmission; local storage alone does not guarantee an offline run.

When Cortex changes, inspect the update and replace the engine hash. Startup
refuses a changed engine until that configuration is updated. The pin protects
the reviewed source bytes; it is not a sandbox for Python or an attestation of
your interpreter installation.

## Retrieval limits and provenance

The adapter uses Cortex's parser and lexical ranker on bounded, read-only
in-memory snapshots. It does not duplicate the brain into Nexus's semantic index.
Its context tool deliberately returns matching whole notes, without Cortex's
inferred-neighbor expansion. Oversized notes are omitted with an explicit count;
use discovery and paginated reads to inspect those notes.

Each source carries its bundle path, saved review status, author and content
hash. Drafts remain unverified, and `verified` is saved metadata rather than
independent proof of a claim. Hashes detect changed bytes, not scientific truth.
Multi-file searches are bounded reads rather than an atomic snapshot of the
whole brain; reread a cited page at its returned hash before relying on it.

Limits: 2,000 note files, 8 MB per scan, 256 KB per file, 10,000 visited directory
entries, 12 nested directories, 20 discovery results, 16,000 characters per read
or context-source budget, and 24,000 characters per serialized tool payload.
Larger brains require a deliberately narrower scope or a future scalable reader.

Files are opened through directory descriptors without following symbolic links;
hard-linked and non-regular files are refused. Symbolic links are omitted during
discovery. All tool outputs use the same secret-pattern redaction, including
metadata, and whole private-key blocks are removed. Redaction happens before
pagination so adjacent reads cannot reconstruct a detected credential. It cannot
detect every credential or private fact. Review the brain's contents and model
choice before sharing them. No provider credentials are forwarded to the reader.

## Validation

```sh
node --test test/cortex-reader.test.js
```

The regular suite uses a synthetic engine-contract fixture and disposable notes.
To exercise your actual reviewed Cortex engine against the same disposable notes:

```sh
NEXUS_CORTEX_ENGINE=/path/to/cortex/cortex.py node --test test/cortex-reader.test.js
```

Both checks cover the MCP handshake, tool allowlist, filtering, content hashes,
bounded context, redaction across pagination, stale reads, forbidden paths,
symbolic/hard links, and changed-engine refusal. Neither loads your private brain,
changes Cortex, invokes a model, or makes a cloud request.

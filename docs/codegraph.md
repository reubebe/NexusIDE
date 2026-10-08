# Code graph integration

NexusIDE can connect to [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) through its existing MCP adapter. The local build uses release **v0.11.0**, MIT licensed, with the release archive checksum and GitHub build attestation verified. This establishes artifact provenance; it is not a security audit of the complete binary.

## Local setup already completed

- Binary and license: `.nexus/integration-review/codebase-memory-v0.11.0/`.
- Configuration: the `codegraph` entry in `.nexus/config/project.json`.
- Agent: `codebase-navigator`, also provided in `examples/codebase-navigator.json`.
- Indexed scope: `src/`, project name `nexuside-source`. Other folders, including `.nexus`, are outside this indexing root.
- Cache: `.nexus/codegraph-cache`. It contains derived source information and should be treated as private project data.
- Agent grants: search, caller tracing, coverage, file outlines, architecture and project listing. Indexing, deletion, arbitrary commands and source writes are not granted.

Run from the NexusIDE source directory:

```sh
npm start -- run codebase-navigator "Explain how agent permissions are enforced. Check graph freshness and confirm the relevant source files."
```

Review the connection and each query approval. Native file tools let the agent verify graph claims against the source. Graph results cover the indexed scope only; a missing result is not proof that a function is unused.

## Refresh the local index

After source changes, run this explicit indexing command from the NexusIDE source directory:

```sh
env CBM_CACHE_DIR="$PWD/.nexus/codegraph-cache" \
  CBM_ALLOWED_ROOT="$PWD/src" \
  "$PWD/.nexus/integration-review/codebase-memory-v0.11.0/codebase-memory-mcp" \
  cli --quiet index_repository --repo-path "$PWD/src" \
  --name nexuside-source --mode fast --persistence false
```

Fast mode provides structural indexing; it does not use a semantic embedding service. The MCP server runs with graph UI disabled and the upstream `analysis` tool profile, further limited by NexusIDE's explicit allowlist. The upstream daemon can watch indexed source while sessions are connected. Close other codebase-memory sessions before changing its cache: upstream permits one canonical cache root per account at a time.

## Verification

```sh
node scripts/verify-codegraph.js "$PWD/.nexus/integration-review/codebase-memory-v0.11.0/codebase-memory-mcp"
```

The verifier uses a temporary synthetic source folder and separate cache. It checks the MCP handshake, explicit tool allowlist, indexing, function discovery, caller tracing and refusal to index outside the allowed root. It records `.nexus/verification/codegraph.json` and removes its synthetic files on success. Close active graph sessions before running it because its cache differs from the normal project cache.

The supplied binary is macOS arm64. Other machines need their own reviewed platform release and absolute paths in the MCP configuration. The upstream installer was not run, so it did not add hooks or alter other editors. `CBM_ALLOWED_ROOT` restricts indexing; it is not an operating-system sandbox for this host process.

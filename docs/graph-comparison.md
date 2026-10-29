# Graphify and Code map backend comparison

On 28 October 2026, both Graphify and Nexus's existing codebase-memory backend completed a shared, synthetic JavaScript fixture check. Both found the source-linked function and its caller, then removed the old symbol after a rename. This narrow result does not justify replacing the existing backend or maintaining a second project index. Graphify remains an optional experiment.

## Execution and provenance

Graphify was installed once into a separate temporary Python 3.12.12 environment from reviewed commit [`dac063456bc1f5d92354ec3936fd9dd1513a83f3`](https://github.com/Graphify-Labs/graphify/tree/dac063456bc1f5d92354ec3936fd9dd1513a83f3). Its [package manifest](https://github.com/Graphify-Labs/graphify/blob/dac063456bc1f5d92354ec3936fd9dd1513a83f3/pyproject.toml) identifies `graphifyy` 0.9.96. The source archive SHA-256 was `4dc2e136ab13ba1885fc28ac8a0a3cb253ead641ecbb1e059dc136e0d5723e0a`. The existing codebase-memory-mcp binary was version 0.11.0.

The comparison used `scripts/compare-graph-backends.js`, with Graphify's `extract --code-only --no-cluster --no-dedup` flags. Only a generated `math.js` containing two functions was indexed. The second pass renamed `fixtureAdd` to `fixtureSum` and updated its caller, `fixtureDouble`.

The test did not run `graphify install`, alter assistant hooks, select a semantic backend, download models, or index a private project. Provider credential variables were excluded from the child environment. Network traffic was not separately instrumented. The complete local receipt, including dependency versions, source hashes, binary hash, raw codegraph results, and graph evidence, is `.nexus/verification/graph-backend-comparison.json` (ignored local verification data).

## Observed results

| Check | Graphify 0.9.96 | codebase-memory 0.11.0 |
| --- | --- | --- |
| Initial source-linked `fixtureAdd` symbol | Found in `math.js` | Found in `math.js`, line 1 |
| `fixtureDouble` calls the function | Typed `calls` edge with `EXTRACTED` provenance at line 2 | Inbound caller trace returned `fixtureDouble` |
| Renamed `fixtureSum` symbol and caller | Found after re-extraction | Found after re-indexing |
| Old `fixtureAdd` after rename | Absent from graph nodes | Search returned zero rows |
| Recorded output size | 1,021-byte graph, three nodes and three edges in each pass | Bounded MCP search and trace results retained in receipt |
| Raw graph schema/generator metadata | Absent in this `--no-cluster` output; recorded as null | MCP structured result retained |
| Observed elapsed time, initial/changed | 292 / 196 ms for extraction and graph inspection | 3,022 / 3,038 ms for indexing, search and caller queries |

The timings cover different operations on a tiny fixture, with one measurement per pass. They are not evidence that either backend is generally faster. Neither language-wide correctness, semantic document retrieval, production scale, nor token savings was tested.

## Adapter corrections and validation

The first execution exposed two concrete mismatches in the comparison script: the reviewed Graphify CLI writes `--out DIR` results to `DIR/graphify-out/graph.json`, and callable labels include `()`. The script now uses the actual output path and recognizes exact bare or callable labels. It also requires a typed `calls` edge, preventing a containment or unrelated adjacency from being counted as a caller relationship. Serialized endpoint order is preserved without assuming that an undirected graph's edge order proves call direction.

Both targeted graph-inspection regression tests passed, followed by one successful corrected two-backend run. Future adapters must check schema compatibility and retain source/provenance distinctions; this raw output's missing version metadata must not be silently interpreted as a supported schema. A larger, representative code/document corpus would be required before adopting Graphify as an additional backend.

To repeat the experiment with separately reviewed local executables:

```sh
node scripts/compare-graph-backends.js /absolute/path/to/graphify /absolute/path/to/codebase-memory-mcp
```

The script creates a fresh synthetic workspace, preserves a JSON receipt, and changes neither backend configuration nor the active Nexus Code map integration.

# Code map

Open **Code map** in the dashboard to search the existing codebase-memory-mcp
index and follow one function's direct callers and callees. Select a related
symbol to continue navigating, or its source path to open the current project
file. Unsaved editor drafts must be saved or discarded before opening another
file. Line numbers originate in the index and may drift after edits.

This view uses the existing backend described in [Code graph](codegraph.md).
It does not install a competing CodeGraph index or enable an upstream browser
viewer. The configured MCP connection must be named `codegraph`, launch a
reviewed absolute `codebase-memory-mcp` binary through `/usr/bin/env` with
`CBM_ALLOWED_ROOT` inside this workspace, and include `--ui=false`. The optional
`--tool-profile=analysis` flag is supported. No provider credential variables
are forwarded. Required granted tools are `list_projects`, `search_graph`,
`trace_path`, and `check_index_coverage`.

## Use

1. Review the displayed executable and source scope, check **Allow**, and select
   **Load indexes**. Opening the tab itself only reads configuration.
2. Select an index rooted inside the approved source scope and search for a
   function or symbol. At most 20 matches are returned.
3. Select a match. The three columns show callers, the selected function, and
   callees. Each direction is limited to 20 direct relationships; tests are
   included, and omitted results are reported.
4. Open source to confirm a relationship. Inferred edges show the backend's
   strategy and confidence, which are signals rather than guarantees.

The displayed index date and coverage status are best-effort backend metadata.
An empty result does not establish that a function is unused or untested.
Only indexes from the first 50 listed projects are considered, and indexes
outside the selected workspace/source scope are excluded. Refreshing the
connection resets consent. Changing configuration invalidates its approval.

## Execution boundary

This is a direct user-operated view. The checkbox and query buttons authorize
the displayed process and narrowly defined read queries, independently of an
agent task. No model is called and no generic MCP method or arbitrary query
arguments are accepted by the endpoint. The backend may refresh its own local
cache when connected. Index creation/deletion, arbitrary graph queries, and
source edits are never issued by this view.

Requests use the same authenticated dashboard API and source-path restrictions
as the file editor. The connection approval is bound to its configuration hash.
Queries hold the workspace lease, have a 30-second timeout, close their MCP
connection on completion, and limit returned metadata. Another writer may need
to finish before a query can run. An MCP process is still a trusted local
executable, not an operating-system sandbox.

## Verification

`node --test test/code-map.test.js` covers configuration approval, read-only tool
selection, source/index boundaries, response parsing, result limits, and API
authentication using disposable fixtures.

For a reviewed local backend, also run:

```sh
NEXUS_CODEGRAPH_BINARY=/absolute/path/codebase-memory-mcp node --test test/code-map.test.js
```

That extra test builds an index from disposable source, searches a function,
checks its caller, and removes its fixture afterward. It makes no model requests.

For actual browser interaction and desktop/mobile captures:

```sh
NEXUS_CODEGRAPH_BINARY=/absolute/path/codebase-memory-mcp node scripts/verify-code-map-ui.js
```

This uses an isolated Chrome profile and synthetic source, exercises connection
consent, search, relationship navigation, and opening current source, then stores
screenshots and a receipt under private `.nexus/verification/code-map-ui/`.

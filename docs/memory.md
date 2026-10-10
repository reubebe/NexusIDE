# Memory and retrieval

NexusIDE stores memory locally in `.nexus/storage.sqlite`. Notes are context for the model, never permission grants, executable skills, or verified facts. This implementation uses SQLite full-text search and optional local embeddings; it requires no Tencent service or dependency. Project code/document retrieval remains separate from memory.

## Layers and ownership

| Layer | Contents | Categories |
| --- | --- | --- |
| L1 | Concrete facts, decisions, constraints, and procedures | `fact`, `decision`, `constraint`, `procedure` |
| L2 | Task or project summaries | `summary` |
| L3 | Stable user preferences | `preference` |

Every note has a project scope or an owning agent, a layer/category, source, revision, active/archived status, optional expiry, and provenance when available. Existing notes retain their IDs and scope and default to active L1 facts. An agent can retrieve project notes and its own private notes; selecting a private note's ID never gives another agent access. Archived and expired notes remain inspectable but are excluded from retrieval.

```sh
nexus memory add "Use Python for numerical analysis" --layer L1 --category decision
nexus memory add "Prefer concise reviews" --agent reviewer --layer L3
nexus memory list
nexus memory list --agent reviewer --layer L3
nexus memory list --all-scopes --status archived --offset 0 --limit 50
nexus memory history MEMORY_ID
nexus memory update MEMORY_ID patch.json
```

`memory list` includes project notes and, with `--agent`, that agent's notes. `--all-scopes` is an explicit management view across agents. Listing includes usage counters and the last-use timestamp. It does not apply an agent's retrieval selection. List pages allow 1–200 notes; history pages allow 1–100 revisions. Both support `--offset` and `--limit`.

An update file is a JSON object, for example:

```json
{
  "expectedRevision": 1,
  "text": "Use Python 3.13 for numerical analysis",
  "layer": "L1",
  "category": "decision",
  "expiresAt": null
}
```

Updates may change `text`, `scope`, `agent`, `layer`, `category`, `status`, and `expiresAt`. Read the latest revision before editing; a stale `expectedRevision` fails instead of overwriting a concurrent edit. Use `"status": "archived"` to retain the note and its history without retrieving it. `nexus memory forget MEMORY_ID` permanently removes the note, its revisions, usage record, and indexed vectors. Source conversations, saved drafts, retained legacy files, and backups can still contain the original text.

## Agent memory selections

Set `memory: true` in an agent definition to enable its memory tools and startup context. Optional `memoryLoadout` narrows the notes it receives:

```json
"memoryLoadout": {
  "project": "selected",
  "ids": ["PROJECT_MEMORY_ID"],
  "layers": ["L1", "L2", "L3"],
  "maxItems": 8,
  "maxChars": 12000
}
```

`project` is `all`, `selected`, or `none`; `ids` selects project notes only. The agent's own notes remain eligible under the chosen layers. Defaults are all project notes, all three layers, 8 items, and 12,000 serialized characters. Selection permits at most 200 IDs, 1–20 items, and 256–20,000 characters. The character budget includes metadata, and oversized text is marked as truncated.

Startup context combines up to two recent eligible L2/L3 notes with task-relevant local keyword matches, within the same total budget. The run records which memory IDs and revisions were injected. The local `search_memory` tool applies the same selection. When embeddings are configured, `search_memory_semantic` offers hybrid retrieval after approval to send the query to the local embedding service. Agents can propose a new private note through `save_memory`; saving requires approval. Memory cannot grant tool access or install a skill.

## Keyword, semantic, and hybrid search

```sh
nexus memory search "analysis" --agent reviewer
nexus memory search "analysis" --mode lexical
nexus project index --mode lexical
nexus project search "accessibility controls" --mode lexical
```

`memory search` and `project search` default to hybrid retrieval: SQLite FTS5 keyword ranking and semantic ranking are combined when current embeddings are available. Without configured/current embeddings, or when the embedding service fails, they return keyword results with a warning and the actual `mode`. Use `--mode lexical` for no embedding calls or `--mode semantic` to require semantic retrieval. `--agent reviewer` on memory search loads that agent's memory selection. It does not expose other agents' private notes.

Memory keyword indexes update with note writes. Project retrieval first needs an explicit `project index`; `--mode lexical` builds it without an embedding service, while the default builds keyword data and uses embeddings if configured. Refresh after project edits: retrieval verifies current file digests and excludes changed/deleted content. There is no background file watcher.

For embeddings, pull a local Ollama embedding model and add an `embeddings` field to the existing project configuration, preserving its other settings:

```json
"embeddings": { "model": "nomic-embed-text", "url": "http://127.0.0.1:11434/api/embed" }
```

```sh
nexus memory index
nexus memory semantic "numerical analysis" --agent reviewer
nexus project index
nexus project semantic "where is accessibility handled?"
```

The existing `memory semantic` and `project semantic` commands still require configured embeddings and a compatible index; they do not silently switch to keyword-only retrieval. Indexing sends eligible text to the configured local embedding endpoint. Incremental updates reuse unchanged text; `--force` refreshes every vector, including after a model changes behind the same name. Memory text edits become immediately searchable by keywords; stale semantic vectors are excluded until rebuilt.

Retrieval has a five-second default time budget, at most 20 results, and at most 20,000 serialized result characters; agent selections can narrow those limits. Project search defaults to 12 results. Semantic ranking scans vectors exactly, so these bounds are not a large-corpus performance guarantee. Notes allow 16,000 text characters. Project scans allow 10,000 files, 50 MB, and 30,000 chunks, with at most 100 KB per file; protected paths, links, and binary files are excluded. Each vector allows at most 8,192 dimensions, and each index has a 512-MiB vector budget. Inspect `truncated`, warnings, and stale counts instead of assuming complete coverage.

## Reviewable distillation

Distillation is a separate explicit action on a completed run. Finishing a run does not automatically send its transcript to a provider or save extracted memories.

```sh
nexus memory distill RUN_ID --demo
nexus memory distill RUN_ID --provider PROFILE_NAME
nexus memory drafts --offset 0 --limit 20
nexus memory review DRAFT_ID CANDIDATE_ID approve --revision 1
nexus memory review DRAFT_ID OTHER_CANDIDATE_ID reject --revision 2
```

`--demo` creates an offline demonstration candidate. A live distillation requires an explicit provider profile and interactive approval before transmission. The approval identifies the provider, model, endpoint, source run, and excerpt size. Noninteractive CLI sessions cannot approve transmission. Ctrl-C cancels the request. The selected generation provider may be local or remote; it is separate from the local embedding configuration.

Only bounded, redacted user/assistant conversation prose is sent. System messages and tool outputs are excluded. The source excerpt and provider reply each allow at most 24,000 characters; each source message contributes at most 8,000 characters. A response may propose at most eight candidates, each with at most 4,000 characters and 1–4 exact evidence quotes of at most 1,000 characters. Distillation proposes L1 facts/decisions/constraints, L2 summaries, or L3 preferences. It does not generate procedures or skills. L3 evidence must come from an original user message; assistant-inferred preferences fail validation.

Candidates remain untrusted drafts until reviewed individually. Compare each suggestion with its quoted evidence before approving it. Exact quotes establish provenance, not truth or whether a preference is durable. Approval creates a note private to the source agent, preserving the source run, candidate, evidence, and review timestamp. Rejection creates no note. Each decision advances the draft revision; use the current revision from the returned draft or refresh `memory drafts`. Draft listing supports pages of up to 100 and omits the full source excerpt. Changed source history invalidates approval, and note creation plus candidate disposition commit atomically.

Notes, source excerpts, drafts, and revision history are sensitive local data. See [storage and recovery](storage.md) for retained JSON, SQLite snapshots, migration, and backup limits. The local workspace ownership boundary still applies; memory scopes are not a multi-user security service.

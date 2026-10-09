# SQLite storage and incremental indexing

Phase 1 stores runs, workflows, memory notes and semantic indexes in `.nexus/storage.sqlite`. It requires Node.js 22.18 or newer and uses the built-in SQLite module, so no new native npm dependency is required. Node 22 may print an experimental-module warning. Configuration, agents, teams, plans, skills, imports, verification receipts, workspace locks and the encrypted vault remain in their existing files.

## Upgrade and migration

Finish active runs and close older Nexus processes before the first upgrade. Back up the complete private `.nexus` directory while those processes are stopped. Older versions write JSON and do not understand the database.

```sh
nexus storage status
nexus storage migrate
nexus memory index
nexus project index
```

`storage migrate` imports runs, workflows and memory one folder at a time. Each folder is committed in one transaction with a completion marker. A bad record aborts that folder; correct it and retry. Previously completed folders remain usable. Normal reads/writes also migrate their folder on first access. Original JSON files remain byte-for-byte unchanged; after migration they are historical copies, and direct edits to them do not update the database. Deleting a note through Nexus cannot resurrect it from a retained JSON copy.

Index updates import matching vectors from legacy `.nexus/indexes/project.json` and `memory.json` when available. They recheck current sources before publishing; incompatible or changed content is embedded again. A malformed legacy cache reports an error; `index --force` bypasses it. Run an index update once before semantic search after upgrading.

## Incremental behavior

An update scans and hashes current files/notes, reuses matching text vectors and embeds only new content. File renames can reuse vectors. Deleted, newly excluded and inaccessible sources are removed from the new index. Changing the embedding model or URL invalidates reuse. If model contents change behind the same name, use `nexus project index --force` or `nexus memory index --force`.

Results report total chunks (`indexed`), newly embedded chunks (`embedded`), reused chunks (`reused`) and removed source paths/note IDs (`deleted`). `truncated` indicates scan coverage reached a limit; it is not a complete-project result. Indexing is explicit, not a file watcher.

Vectors use binary SQLite rows. Temporary staging keeps the previous index available while embeddings run. Publication is transactional; cancellation, provider failures and conflicting concurrent builds preserve the last committed generation. Retry a build that reports a generation conflict. Search checks source digests and note scope, so changed/deleted content is excluded until refreshed. Query ranking streams rows and keeps only the best results in JavaScript memory. It remains an exact linear vector scan, which should be benchmarked for each larger workload.

Project scans allow 10,000 files, 50 MB of eligible UTF-8 content and 30,000 chunks, with at most 100 KB per file, depth 20 and 100,000 visited directory entries. Protected paths, symlinks, hard links and binary files remain excluded. Notes retain the 16,000-character limit; vectors have at most 8,192 dimensions and each index has a 512-MiB vector budget. Individual history records retain the 20-MB bound. Limits bound processing; they are not performance guarantees.

## Backup and recovery

```sh
nexus storage status
nexus storage backup /absolute/path/nexus-snapshot.sqlite
```

Status inspects schema, counts, migration markers, byte sizes and SQLite integrity without importing legacy state. Backups use SQLite's online snapshot API, include committed WAL changes, verify integrity and refuse to overwrite an existing destination. Snapshot files are private (`0600`). A database snapshot contains only SQLite data. Keep configuration, skills, credentials/vault and any retained JSON as part of a separate private backup of `.nexus`.

For a full-directory backup, stop Nexus first. Copying only `storage.sqlite` while Nexus is running can miss changes in `storage.sqlite-wal`. Do not remove live WAL/shared-memory files.

To restore, stop all Nexus processes, preserve the current entire `.nexus` directory separately, then place the verified snapshot at `.nexus/storage.sqlite` in a clean restore directory alongside the separately saved configuration. Keep permissions private. Do not pair a restored snapshot with the former database's WAL/shared-memory files. Run `storage status` before resuming, then refresh indexes against current project files. The application does not automatically replay unfinished tool actions.

SQLite uses WAL, a busy timeout and full synchronization for writes. Schema versions newer than the running Nexus release are refused. Damaged databases are reported rather than silently replaced. Filesystem checks reject linked database files, but processes running as the same operating-system user remain outside this protection boundary. SQLite is intended for a local workspace, not a shared network-filesystem database.

## Validation

The test suite covers migration rollback and preserved originals, repeat migration, deletion persistence, concurrent processes, forced process termination, exclusive writes, links, scoped memory, incremental reuse, model/dimension changes, cancellation, and competing index generations. The scale probe `node scripts/verify-storage-scale.js` builds 2,048 files with synthetic 1,536-dimensional embeddings, exceeds the former 20-MB JSON ceiling, verifies zero embeddings for an unchanged update, and then checks one-file editing and deletion. It records evidence in `.nexus/verification/storage-scale.json`; synthetic timings do not measure real model speed.

References: [Node SQLite API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html), [SQLite WAL](https://www.sqlite.org/wal.html), and [SQLite file-handle locking cautions](https://www.sqlite.org/howtocorrupt.html).

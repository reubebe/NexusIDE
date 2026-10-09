# Security boundaries

NexusIDE is a local, single-operator prototype. It is not a hardened multi-user service. Do not expose its web server publicly or treat a worktree as a security sandbox.

## Enforced controls

- The macOS desktop shell passes its session token over stdin, uses nonpersistent WebKit storage and restricts navigation to its server origin. It has no JavaScript-to-native bridge. Closing the shell stops its server and cancels pending activity. The shell is not an OS sandbox.
- The dashboard binds to loopback, generates a 256-bit access token, checks bearer authentication on API endpoints, rejects foreign Origin/Host headers, and sends a restrictive CSP. UI content is rendered as text. Approval tokens are single-use and expire after five minutes.
- Agent permissions are enforced by the tool dispatcher. Imported instructions, skill metadata and MCP annotations cannot expand grants. Foreign Markdown imports begin read-only. Scripts and installers are never run by import.
- Skill packages reject symlinks and hard links, use bounded descriptor reads, and detect source changes during intake. The bounded `nexus-static-v2` scanner reports selected patterns, skipped resources and incomplete coverage. Stored resources and instructions are checked against the recorded digest and SKILL.md before runtime use. A digest is not publisher authentication; a malicious local writer can replace both content and digest.
- Project file tools reject traversal, absolute paths, symlinks and known protected paths. File reads/writes reject hard links. Writes require approval and check for changes during approval. Dashboard saves check a content hash and use the same file tools.
- Git diffs omit protected paths before content is sent to a model. Runtime Git commands neutralize configured fsmonitor and clean/smudge/process filters, which can otherwise run even during reads. Code search is literal, bounded and excludes protected directories. Limits are explicit; incomplete searches report truncation.
- Write-capable runs take a workspace lock. Workflow graphs are validated; dependency cycles and missing dependencies fail. Shared-workspace write stages serialize; separate worktrees can run independently.
- Worktree review shows tracked diffs and bounded previews of untracked text files. Unsafe paths, links, and protected files are excluded from new-file previews.
- Reviewed merges lock both workspaces, require clean committed source/destination state, refuse protected paths, links, binary changes and custom Git content filters, and recheck revisions after approval. Only fast-forward merges are supported; no push or worktree deletion occurs.
- Commands use executable/argument arrays with no implicit shell interpolation. Runtime commands have a timeout/output cap and a small inherited environment. Explicit application profiles can grant selected environment variables. User-approved interpreters can execute arbitrary programs.
- Optional Docker commands use a digest-pinned, preexisting image, no network, a read-only container filesystem, dropped capabilities and resource limits. No Docker failure falls back to host execution. MCP servers and external application profiles still run separately from that container.
- MCP servers require connection approval, explicit tool allowlists and per-call approval. Stdio transport messages are bounded. HTTP MCP uses HTTPS or local HTTP; redirects are rejected and credentials are environment references. OAuth browser flows are not implemented.
- State uses private file modes, validated paths and symlink/hard-link checks. Runs, workflows and memory use SQLite WAL transactions; individual records retain a 20 MB serialized cap. Legacy JSON migration commits each folder atomically and retains original files. Configuration and other JSON state still use bounded reads and atomic replacement. Consistent SQLite snapshots include committed WAL changes and refuse destination overwrite. The optional vault uses scrypt and AES-256-GCM with a user-supplied password. It is not an operating-system keychain. Known environment/provider secrets are redacted from new run logs and tool-result context.
- Semantic indexing accepts only local HTTP Ollama embed endpoints and refuses redirects. Queries filter project/agent scope and omit changed or deleted sources. SQLite index updates stage privately and publish transactionally after checking the prior generation. Cancellation/failure does not publish a partial index. Vector storage and project scans are bounded; unchanged text can reuse embeddings. Vectors and retained legacy JSON are sensitive data, not encryption; all local account processes remain within the same trust boundary. Agent-initiated semantic queries require approval.
- Dependencies are version-locked. CI uses commit-pinned actions, read-only repository permissions, tests and dependency auditing. It does not expose API credentials to pull-request code.

## Residual risks and limits

Approved host commands, MCP subprocesses and applications run under your account and can read files, contact networks or modify state beyond the project. Restrict their grants and review the complete command shown. Filesystem checks and locks are not an OS boundary against another malicious process running as your user. Directory replacement races, detached subprocesses, unsafe external binaries and host administrator access require stronger isolation than this application provides.

Docker exposes the mounted workspace to the container. Prefer a separate worktree containing no credentials or `.nexus` state; the container can read and modify everything in that mount. Windows process cancellation currently stops only the direct child. POSIX process-group cancellation does not constrain a malicious child that deliberately escapes its group.

Prompt injection remains possible. Permissions and approvals limit actions; they cannot guarantee that model reasoning is accurate or that a user will recognize a harmful proposal. Memory, skills, repository text, tool descriptions and external results may contain misleading instructions. Source hashes establish provenance, not trustworthiness or truth.

Provider adapters validate the complete tool-call batch before execution, reject truncated/refused/malformed replies, bound response sizes and timeouts, and avoid automatic retries. HTTP error bodies are not echoed. Named profiles cannot borrow unrelated ambient keys; ambient vendor keys are only used at their official origins. These controls do not make third-party model endpoints trustworthy. Explicit compatibility checks send synthetic data and record historical evidence, not a security certificate; see [provider compatibility](docs/providers.md).

Transcripts can contain proprietary code, research data and personal information. Redaction recognizes configured secret values, not all sensitive material, transformed secrets or every possible credential format. Old logs are not retroactively scrubbed. Protect `.nexus` backups and review exports. Losing the vault password prevents decryption; the process holding an unlocked key remains within the operator's trust boundary.

A crashed run can leave a workspace lock. `nexus recover` lists lock keys and checks whether their recorded process is present; `nexus recover <key-prefix>` requests confirmation and removes only a uniquely matched lock whose process is confirmed absent. Recheck that the process is no longer running before approving removal, since PID reuse and process races cannot be eliminated completely. Run records marked running after abrupt termination are historical records, not proof that execution continues. Worktrees and branches are retained; automatic merge or cleanup is not performed.

New run/workflow records include process and host ownership. Explicit activity recovery marks an orphan interrupted only when its local process is confirmed absent and the record is unchanged after approval. Legacy or other-host records require manual investigation. Recovery timestamps indicate when the record was repaired, not the exact crash time. Recovery preserves history and never replays commands.

## Verification and reporting

Tests exercise negative permission paths, traversal/symlink/hard-link restrictions, optimistic writes, workspace locks, stale approval rejection, HTTP authentication/origin checks, MCP tool grants, process limits, vault integrity and credential redaction. These are targeted checks, not a formal security proof or a full audit of third-party repositories.

The [2026-10-08 workflow audit](docs/audit-2026-10-08.md) adds cancellation-after-approval, terminal/shutdown races, binary-file protection, state replacement/size limits, Git helper suppression and retrieval regression tests. Managed integration origin/commit checks do not freeze transitive dependencies or sandbox installers.

The requested security repositories informed review; see [integration review](docs/integrations.md). Anthropic's action explicitly warns about prompt injection. Its action has not been enabled against this project and no paid model audit was performed.

For suspected issues, provide a minimal synthetic reproduction to the project owner without real credentials or research data. Do not attach private `.nexus` transcripts to a public issue.

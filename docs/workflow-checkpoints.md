# Workflow checkpoints and bounded retries

Nexus records each stage before it starts and immediately after it finishes.
Checkpoint mode adds project and configuration fingerprints so a stopped team
can continue without repeating completed stages:

```sh
nexus team run development "Inspect and improve the parser" --checkpoint
nexus team status
nexus team resume WORKFLOW_ID
```

Resume requests approval, shows completed and pending stages, then rechecks the
project, agent definitions, imported skills, effective model endpoints and saved
configuration. Existing step/tool approvals still apply. A continuation creates
a new linked workflow record; the old record remains unchanged. Only one
continuation can claim each checkpoint, and a chain allows at most two resumes.
Changing a model account's secret value does not establish a different model;
secret values are not stored in fingerprints or reports.

Checkpoint mode currently supports ordinary shared-workspace teams using file
tools, with commands disabled and no agent memory, MCP or application grants.
Completed writes can be retained. An unfinished write-capable stage cannot be
replayed because it may already have changed files. Read-only interrupted stages
may be rerun after the checkpoint checks. Independent review, isolated worktrees,
legacy records and active workflows cannot resume this way. A crashed workflow
must first be marked interrupted using `nexus recover workflow WORKFLOW_ID`, which
requires confirmation that its recorded owning process is absent.

Snapshots cover accessible project files, excluding protected paths such as
`.nexus`, `.git`, `.env*` and `node_modules`. They store one content fingerprint,
not copies of source. Capture is bounded to 5,000 directory entries, 20 directory
levels, 8 MB per file and 50 MB total. Links and incomplete snapshots are refused.
Larger workspaces can use ordinary teams without `--checkpoint`; narrow the
workspace before enabling checkpoints. Changes to protected files, Git metadata,
external services and outside programs are not attested. Checkpoints are local
consistency records, not a sandbox or tamper-proof evidence.

After three failed calls with the same tool and equivalent inputs, the runtime
stops before another model request or tool call. Exceptions, explicit declines,
failed command exit codes and MCP `isError` results count; ordinary file text
does not. Successful execution of that same call resets its counter. Changing
inputs allows a different approach, still within the existing model-step budget.
The event and preceding tool results remain in the run history. This protects
against exact repeated failures, not every possible unproductive loop. Provider
request failures already stop without automatic retry or account switching.

This is an original Nexus implementation informed by
[LazyCodex's checkpoint-oriented workflow](https://github.com/code-yeongyu/lazycodex/tree/dd063158bcbf0d31c4c762def90dbb2251222b2c).
No LazyCodex installer, global agent configuration or long-running self-loop was
installed. Checkpoint control is available through the CLI and embedded terminal;
the dashboard does not yet expose a resume button.

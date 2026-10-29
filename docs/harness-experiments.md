# Executed harness experiments

Nexus can compare a saved agent's instructions against a candidate using actual runtime calls, keep revision-linked feedback, and apply or roll back a reviewed change. This implements the bounded feedback/evaluation workflow suggested by [Reef](https://github.com/Human-Agent-Society/reef/blob/5d4174bbebafd98d94cbad407d464cd2468309a6/docs/user-guide/recipes/reefine.rst). It does not install Reef, train a model, generate candidates, or change settings automatically.

The existing `nexus harness evaluate evidence.json` still evaluates supplied numbers. The executed workflow below produces its own runtime receipts and feeds their measurements into that same conservative gate. Its separate experiment record distinguishes executed evidence from the supplied-measurement evaluator's record.

## Run a comparison

Start with [the synthetic example plan](../examples/harness-experiment.json), change `agent` to an installed agent, and review its tasks and inline fixture files. Use a fresh experiment name for a new baseline, provider, fixture corpus, split, or execution limit.

```sh
nexus harness run examples/harness-experiment.json --demo
nexus harness run my-experiment.json --provider local-review
nexus harness experiments
nexus harness inspect <experiment-id>
```

The run command requires either the offline demo or an explicitly selected configured provider. Its approval shows the provider and total trial count before execution. If the selected provider is remote, task text, agent instructions, and fixture contents can reach it. Do not put credentials, private project files, or unapproved data in a plan. Fixture files, both agent snapshots, checks, receipts, and review history are stored locally in `.nexus/harness-experiments/`; runtime transcripts use the normal run store. Each fixture directory is removed when its trial ends.

The demo uses a scripted provider. It checks the workflow wiring and can never establish model improvement or qualify a candidate for adoption. The example has synthetic identifiers, not a validated real-world benchmark; no improvement is promised even with a real model.

Each baseline/candidate pair receives the same task and inline files in separate fresh directories. The runtime grants read-only tools and disables skills, memory, commands, writes, MCP, and external applications, regardless of the original agent's grants. The comparison therefore tests instruction behavior in this restricted setting, not every production capability of that agent. Expected output checks and split labels are never placed in the model's initial context. Reading fixture content can naturally reveal the answer.

At least three development cases and three held-out cases are required, with three to five paired trials per case. The two variants alternate first/second position across trials. IDs, input hashes, exact instruction snapshots, provider/model/options, run IDs, timings, reported token usage, output hashes, individual check results, and failures are retained. A repeated hypothesis against the same baseline returns the saved attempt instead of rerunning it. Aborted attempts retain partial evidence; use a new experiment name for a deliberate new attempt.

The default per-trial limit is 60 seconds and five model steps, configurable within 100–120,000 ms and one to ten steps. The whole comparison stops after 15 minutes or two consecutive failed/cancelled trials. There are no automatic retries. Cancellation, timeout, unavailable usage, and incomplete baseline or candidate trials prevent adoption.

## Plan format

```json
{
  "version": 1,
  "experiment": "grounded-answer-v1",
  "agent": "reviewer",
  "hypothesis": "A concise grounding instruction improves exact answers.",
  "candidateInstructions": "Read the requested fixture and return only the requested value.",
  "edits": [{"component": "instructions", "description": "Require source grounding and an exact answer."}],
  "review": {"reviewer": "your-name", "leakageChecked": true, "notes": "Describe how held-out cases were kept independent."},
  "trialsPerCase": 3,
  "cases": []
}
```

Populate `cases` with six to twenty entries. Each has `id`, `split` (`development` or `heldout`), `task`, `files` (relative filename to UTF-8 content), and `checks`. A case supports up to twenty files totaling 100 KB and one to twenty checks. The complete plan is capped at 512 KB. Protected names, traversal, symlinks in plan input, binary content, duplicate IDs, and ambiguous fixture paths are rejected.

Each check has `type`, `value`, and a `critical` boolean. `equals` compares trimmed final output with trimmed expected text; `includes` and `excludes` use case-sensitive literal text; `tool` requires a successful `read_file`, `list_files`, or `search_code` result. Every case needs at least one positive `equals` or `includes` check. Scores are the fraction of checks passed. A failed critical check or tool error is a critical failure. Checks are deliberately non-executable: the plan cannot inject JavaScript, a shell command, or a regular expression.

Both splits must exceed the existing evaluator's noise floor, and token growth is constrained. Leakage review is required. The noise band is a conservative heuristic, not a calibrated confidence interval. Labels cannot prove independence: a reviewer must keep held-out cases out of instruction design and avoid reusing them to tune subsequent candidates. Literal checks verify only their stated conditions, not broad reasoning quality, factual accuracy, or security. Inspect transcripts and relevant real workflows before adoption.

## Feedback, decisions and rollback

Record a comment against a real receipt's run ID and exact revision using a JSON file:

```json
{"runId":"run-id-from-receipt","revision":"64-character-revision-from-receipt","rating":"negative","notes":"Explain the observed failure and expected behavior."}
```

```sh
nexus harness feedback <experiment-id> feedback.json
nexus harness feedback-list <experiment-id>
nexus harness review <experiment-id> review.json
```

The review file contains `action` (`adopt`, `reject`, or `rollback`), `reviewer`, and `notes`. For example:

```json
{"action":"adopt","reviewer":"your-name","notes":"Reviewed held-out evidence and representative workflows."}
```

Each adoption/rollback requires explicit approval. Only an eligible completed experiment can be adopted, and only an adopted experiment can be rolled back. The original full agent snapshot must still match before adoption; the candidate snapshot must still match before rollback. If someone has edited the agent meanwhile, Nexus preserves those edits and refuses the change. Permissions, models, and other settings are never changed by this instruction-only experiment.

Rejected experiments, feedback, and decision history remain available. Adoption and rollback share the existing project writer lease. A prepared transition is saved before changing the agent; if interrupted, repeat the same review action to complete it only when the agent still matches the recorded before/after snapshot. A conflicting edit requires manual reconciliation. The hashes detect inconsistency; they are not signatures or proof of trustworthy instructions.

## Validation scope

Automated tests execute synthetic providers through the real runtime and state store, verify paired scoring and receipt links, reject incomplete/unknown-usage results, exercise approval and stale-edit protection, recover a prepared transition, and validate input boundaries. Those tests establish workflow behavior. A live model comparison on a representative, independently held-out suite remains a project-specific evaluation.

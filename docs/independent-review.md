# Independent development review

Nexus has an optional four-stage workflow: plan, independent plan review,
implementation, and fresh final inspection. It adapts the independent-author
and reviewer pattern discussed in [Claudex Loop](https://github.com/chaseai-yt/claudex-loop)
using Nexus's existing runtime. No external coordinator or vendor CLI is required.

## Set up

From the Nexus source folder, initialize your workspace, then install the two
optional review agents and the example team with one setup command:

```sh
npm start -- init
npm start -- extras install review
```

For another project, run `nexus init` and `nexus extras install review` from
that project's directory. Setup preserves existing agents, teams, and model
routes. It does not select or contact a paid model. The underlying definitions
remain available in `examples/plan-critic.json`,
`examples/implementation-inspector.json`, and
`examples/independent-review.team.json` for individual imports or customization.

In **Connections**, assign an available model to `architect` and `coder`, and
a different model to `plan-critic` and `implementation-inspector`.
Use the same account or different accounts as needed. Different accounts or
profile names for the **same model** do not satisfy independent review.
Nexus compares configured model identifiers; it cannot detect that differently
named aliases on a proxy resolve to the same underlying model. Choose actual
distinct models, preferably from different providers. The recorded identity is
the requested profile, protocol, endpoint, and model, not an attestation by the
provider of model provenance.

```sh
npm start -- team run independent-review "Implement the requested change with focused tests"
```

For permitted command execution, enable `coder.permissions.execute` and pass
`--allow-commands`; each command and write still requires normal approval.
The architect, plan critic, and final inspector must have read access, no write
or execution permission, and no MCP/application grants. These stages can read
source and Git changes, but cannot execute tests. The builder can run tests
when explicitly permitted. Test results remain recorded runtime evidence;
an inspector's verdict is not an independently rerun test suite.

The installed team can also be selected in the dashboard. Turn **Offline
demo** off and configure distinct models first; the scripted demo cannot
satisfy independent review. Do not use `--isolated` with this team: current
per-stage worktrees would hide the builder's changes from the inspector.
Use a dedicated project worktree as the team's shared workspace when isolation
from your main checkout is needed.

## Gates and limits

The example's `reviewPolicy.maxPlanRounds` is 2 (allowed range 1–3). `revise`
returns evidence-backed findings to a fresh planning run. `blocked` stops
immediately. If no plan is approved within the round limit, implementation
never starts. Build then requires the configured workflow approval. Every
stage starts a fresh agent transcript; `--resume` is unsupported for this team.

`reviewPolicy.maxModelRequests` bounds requests across all stages and revisions
(default 80, configurable 4–300). The usual per-run step, context and provider
response limits also apply. This is a request budget, not a dollar or wall-time
guarantee. Provider requests already sent may incur charges after cancellation.

Reviews must return exact JSON with `verdict`, `summary`, `evidence`, and
`findings`. Valid verdicts are `approved`, `revise`, and `blocked`. Nexus checks
quotes against the supplied plan or actual `read_file` results from that
review run, and re-reads cited files to reject stale evidence. Final inspection
must cite current source. Blocking findings prevent approval; every finding
references an evidence entry. These checks validate provenance and structure,
not the correctness or completeness of the reviewer's reasoning.

Malformed reports, exhausted budgets, refusals, failed model requests and
non-approved final inspections fail the workflow. The final inspection does
not start an automatic repair loop. Built changes remain in the workspace
for review; nothing is automatically committed, merged, or reverted.

Inspect the workflow record with `nexus team status ID`. Its `review` field
records configured identities, request usage, plan review rounds and the
inspection verdict; individual run IDs link to full tool evidence.

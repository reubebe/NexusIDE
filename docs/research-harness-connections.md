# Connection design comparison with Research Harness

Reviewed the existing local Research Harness source on 2026-10-29 without launching it, modifying it or reading credential stores. Relevant modules are `src/research_harness/workbench/cli_connections.py`, `connections.py` and `chatgpt_auth.py` in the user's Research Harness checkout.

| Harness mechanism | Nexus 0.3.0 behavior | Consequence |
|---|---|---|
| Claude per-connection private directory; official CLI owns credentials | Separate `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CLI_HOME` per saved profile; secret-free profile metadata | CLI accounts can be selected without copying tokens. Meta Muse uses one shared subscription sign-in because isolated state has not been verified. |
| Claude checks `auth status --json` and binds email/organization before each inference request | Nexus launches an interactive official CLI and labels authentication `verify-in-cli` | A saved profile is not proof of a connected subscription. Verify identity and billing inside the CLI. Nexus does not silently choose or rotate accounts. |
| Claude structured subscription transport disables native tools/MCP and validates proposed tool calls through Harness | Nexus Tasks currently uses configured API/local-model transports; subscription CLIs run separately in Terminal | CLI login does not fund Nexus Tasks. This is a material functional difference, not equivalent integration. |
| Direct Sign in with ChatGPT: state, PKCE, nonce, verified identity tokens, account binding, rotating refresh-token protection | Nexus's Codex account path uses the official CLI; its Responses API transport uses an API key | Direct ChatGPT subscription inference in Tasks is not implemented. Copying an OAuth token or relabeling API billing would not implement this protocol. |
| Bounded commands, no automatic retry, lock around identity check and request | Nexus uses explicit launch confirmation, a restricted child environment, one terminal session and a writer lease for profile changes | Account metadata edits cannot silently launch a second session. CLI-owned settings may still affect the account/billing selected by that CLI. |

The useful existing patterns are preserved: credentials belong to the official client, profiles have separate state where supported, commands do not use shell interpolation, failures do not trigger account hopping, and connection labels distinguish configuration from verified authentication. The comparison also identifies the remaining direct-subscription transport gap. It is not represented as implemented or tested.

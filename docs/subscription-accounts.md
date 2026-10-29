# API accounts and subscription sessions

Nexus 0.3.0 has two explicit connection paths. **API or local model** routes Nexus Tasks and teams through the selected model adapter. **Official CLI accounts** launches an installed provider CLI in the interactive Terminal. The CLI handles sign-in, model selection, permissions and billing. A CLI subscription session is not silently substituted for a Nexus task provider.

## Provider support

| Provider | Direct Nexus API connection | Subscription / sign-in path in this build | Multiple accounts |
| --- | --- | --- | --- |
| Claude | Anthropic Messages, `ANTHROPIC_API_KEY` | Installed Claude Code, sign in directly with Anthropic | Numbered API keys; separate named CLI configuration directories |
| Codex / OpenAI | Responses API, `OPENAI_API_KEY`; existing OpenAI preset uses Chat Completions | Installed Codex, sign in with ChatGPT | Numbered API keys; separate named CLI state, forced ChatGPT login and file credential storage |
| Gemini | Gemini OpenAI-compatible endpoint, `GEMINI_API_KEY` | Installed Gemini CLI, Sign in with Google; entitlement depends on account | Numbered API keys; separate named CLI home directories |
| Meta | Model API, `MODEL_API_KEY` | Installed Muse Code, its shared machine subscription sign-in, or explicit Muse API mode using `META_API_KEY` | Numbered direct and Muse API keys; one saved Muse subscription profile, account changed inside Muse |
| DeepSeek | `DEEPSEEK_API_KEY` | No verified subscription integration implemented | Numbered API keys |
| GLM | Z.ai / BigModel general API endpoints, `ZHIPUAI_API_KEY`, region selected explicitly | Coding Plan is a separate entitlement for supported tools. No claim of direct Nexus eligibility | Numbered API keys |
| Qwen | DashScope regional API endpoint, `DASHSCOPE_API_KEY` | Former Qwen OAuth flow discontinued; no subscription bridge implemented | Numbered API keys |

Model discovery is not proof of entitlement or tool compatibility. These new adapters have synthetic protocol tests, including tool calls, malformed responses and credential isolation. No real account login, paid completion, plan-limit measurement or cross-account OAuth refresh was performed for this release.

## Setup and switching

For an API account, export its key before starting Nexus. Add `2` through `99` for additional accounts, for example `OPENAI_API_KEY2` or `MODEL_API_KEY2`. In Connections select the account, model and destination route, then **Use this model**. Selection affects new tasks; it does not mutate a running request or another agent's route. The selected account never falls back to account one when its key is missing.

For a CLI session, install the official CLI separately. Use `command -v claude`, `command -v codex`, `command -v gemini` or `command -v muse` to find its absolute executable path. Add a CLI profile with that path and a recognizable label, select it and launch. Complete login in the CLI, then verify its reported identity, billing mode and model before sending project work. Stop the current terminal before launching another profile. There is no automatic quota-driven account rotation or API fallback.

Profile metadata contains no credential value. It is stored under `~/.nexus/connections/cli-accounts.json`. Claude, Codex and Gemini own their authentication state under separate directories in `~/.nexus/cli-accounts`. Nexus does not read or copy those token files. Removal retains CLI state to avoid deleting sessions or credentials unexpectedly. Sign out in the CLI before removing a profile when you want to revoke that account's access.

The CLI process starts with a small environment allowlist, without inherited provider keys. Muse API mode receives only the selected Muse key. CLI configuration, enterprise policy or a CLI's own environment-file loading can still affect its authentication; Nexus labels subscription profiles as requiring verification in the CLI. The user-operated terminal is not the Nexus agent sandbox, and its output is not sent to a model or saved in Nexus run history.

## Meta's two variables

```sh
export META_API_KEY='your-meta-muse-key'
export MODEL_API_KEY='your-meta-model-api-key'
```

`META_API_KEY` is the Muse Code API-mode input. `MODEL_API_KEY` is the direct Model API input. Nexus never substitutes one for the other. Meta documents subscription credentials as Muse-only; additional API keys are billed separately. A saved Muse API key can take precedence over browser sign-in, so verify the CLI's billing mode. Account isolation for Muse was not established from the reviewed documentation, hence the explicit single subscription-profile limit. Nexus launches Muse with `--contributor-mode off`; it does not alter your saved setting.

## Evidence and related repositories

Provider behavior was checked against current primary documentation on 28 October 2026: [Claude environment variables](https://code.claude.com/docs/en/env-vars), [Claude legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Codex state locations](https://developers.openai.com/codex/config-advanced/), [Gemini authentication](https://geminicli.com/docs/get-started/authentication/), [Gemini state isolation](https://geminicli.com/docs/cli/enterprise/), [Meta authentication](https://dev.meta.ai/docs/muse-code/auth), [Meta subscription boundaries](https://dev.meta.ai/docs/muse-code/subscriptions), [Meta coding-agent APIs](https://dev.meta.ai/docs/coding-agents), [GLM Coding Plan](https://docs.z.ai/devpack/overview), and [Qwen quickstart](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/).

OpenAI also documents a direct [Sign in with ChatGPT flow for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) with [separate account registrations](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions). That distinct OAuth and streaming inference implementation is not part of this release; Nexus currently uses the official Codex CLI for subscription sessions. API Responses support does not imply that subscription tokens can be pasted into the API-key picker.

The requested [Magpie](https://github.com/yetone/magpie), [Claude Capsule Kit](https://github.com/arpitnath/claude-capsule-kit), [Claudex Loop](https://github.com/chaseai-yt/claudex-loop) and [Filee](https://github.com/KnifeLemon/Filee) were considered as integration references, not as evidence that every vendor allows interchangeable subscription credentials. Nexus uses its own profile store and existing PTY; it does not import their credential stores or disable CLI permission prompts.

# Provider compatibility

## Choose a provider in the dashboard

Open **Connections → Choose your model**. Nexus detects `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPUAI_API_KEY`, and `DASHSCOPE_API_KEY` in the runtime's environment. Example values such as `your-openai-key` are marked as placeholders.

Select a provider and account, select a model from that account's model list, choose the workspace default or an individual agent, and click **Use this model**. Loading a model list sends only an authenticated catalogue request, not project content or a generation request. A detected key is not proof of a valid account or model compatibility. Known media, embedding, and Responses-only model families are omitted; model IDs can also be entered manually when listing is unavailable. The current runtime uses Chat Completions or Anthropic Messages, so choose a text model with tool calling.

### Multiple accounts with numbered keys

Keep the standard export for **Account 1** and append `2` for **Account 2**, `3` for **Account 3**, and so on through `99`. For example, the following names add a second credential slot for each of the eight providers; replace the example values with the corresponding account's real key:

```sh
export OPENAI_API_KEY2='your-openai-key'
export ANTHROPIC_API_KEY2='your-anthropic-key'
export GEMINI_API_KEY2='your-gemini-key'
export XAI_API_KEY2='your-xai-key'
export DEEPSEEK_API_KEY2='your-deepseek-key'
export MOONSHOT_API_KEY2='your-kimi-key'
export ZHIPUAI_API_KEY2='your-glm-key'
export DASHSCOPE_API_KEY2='your-qwen-key'
```

After launching Nexus from that terminal, **Connections → Provider / account** shows choices such as **OpenAI · Account 1** and **OpenAI · Account 2**. Numbered entries appear only when that variable exists in the runtime environment; an empty or example value is shown as needing a real key. Account 2 can be used even if Account 1 is absent. Only unpadded suffixes `2` through `99` are discovered; names such as `OPENAI_API_KEY1`, `OPENAI_API_KEY02`, and `OPENAI_API_KEY_WORK` are not automatically discovered or forwarded by the macOS host.

Choose each account separately to load its own model list. Model availability and billing follow the selected credential; a model accessible to one account may not be accessible to another. You can assign Account 1 to one agent and Account 2 to another, or choose either as the workspace default. The saved route includes the exact variable name, and its summary identifies the account. Removing that export leaves the saved route unchanged and requires restoring the key or explicitly choosing another account. Nexus does not automatically fail over between accounts or rotate keys when a quota is reached.

### Launch and regional endpoints

**Connections → Ollama** lists installed local text models from the fixed
`127.0.0.1:11434` service. Start Ollama and install a tool-capable model first;
Nexus neither starts the server nor downloads models from this picker. No key is
needed, and selecting the provider makes no inference request. Choose a listed
model and save the intended route. Explicit remote/cloud models and known
embedding models are excluded from this local list. Custom endpoints remain
available under Advanced connections.

The detected-credential summary and `nexus doctor` show available environment
accounts separately from saved routes. Detection, model discovery and successful
generation are different checks. The clearer status separation and local preset
were informed by Research Harness's connection design. Nexus retains its own
account numbering, environment references and encrypted vault; it does not read
the Harness vault or import credentials from it.

Kimi, GLM, and Qwen have separate regional endpoints. Select the endpoint matching the account that issued your key. Nexus never tries different regions automatically. Unsupported endpoints and coding-plan accounts can still be configured under **Advanced connections & MCP**.

Qwen accounts may require a workspace-specific base URL, which must be configured under Advanced connections. Some Qwen thinking models require streaming; Nexus currently uses non-streaming requests, so those models are not supported. The picker filters known mismatches but cannot certify every returned model. See [Alibaba's API requirements](https://www.alibabacloud.com/help/en/model-studio/deep-thinking).

Only the environment variable name is saved, never its value. Start `nexus serve` or `nexus desktop` from the shell where the variables are exported. For the installed macOS app, launch `/Applications/NexusIDE.app/Contents/MacOS/NexusIDE` from that terminal after fully quitting any running instance; the native host forwards the eight supported base keys and their numbered `2`–`99` variants. A macOS application opened from Finder does not automatically inherit terminal exports. After changing exports, relaunch the runtime from that terminal; the refresh button only checks its existing environment. Nexus does not read `.env` or import Keychain credentials automatically. See [desktop setup](desktop-distribution.md).

### Windows environment setup

The CLI and browser dashboard use the same provider catalog on Windows. In PowerShell, persist credentials for the current Windows user with `SetEnvironmentVariable`:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your-openai-key", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "your-anthropic-key", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "your-gemini-key", "User")
[Environment]::SetEnvironmentVariable("XAI_API_KEY", "your-xai-key", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "your-deepseek-key", "User")
[Environment]::SetEnvironmentVariable("MOONSHOT_API_KEY", "your-kimi-key", "User")
[Environment]::SetEnvironmentVariable("ZHIPUAI_API_KEY", "your-glm-key", "User")
[Environment]::SetEnvironmentVariable("DASHSCOPE_API_KEY", "your-qwen-key", "User")
```

Numbered accounts use the same convention, such as `OPENAI_API_KEY2`. Restart PowerShell and Nexus after changing these variables so the new process receives them. Windows currently uses `nexus serve`/the browser dashboard; the packaged native desktop host is macOS-only. Ollama runs locally on Windows and can be configured through its OpenAI-compatible endpoint, commonly `http://localhost:11434/v1`.

Selections apply to new tasks and preserve existing provider profiles, MCP services, and unrelated routes. An agent's pinned `provider` takes precedence; remove that pin in **Agents** before assigning it through the picker. Existing agent routes also take precedence over the workspace default.

Discovery uses the official [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list), [Anthropic models API](https://platform.claude.com/docs/en/api/models/list), [Gemini compatibility API](https://ai.google.dev/gemini-api/docs/openai), [Qwen Singapore catalogue API](https://www.alibabacloud.com/help/en/model-studio/list-models), and compatible provider model endpoints. A catalogue can include models your account cannot use. If a provider does not expose a list at the configured endpoint, Nexus offers manual model ID entry. Model listing and credential isolation have fixture coverage across the presets; live discovery was checked with OpenAI. This does not extend the generation verification matrix below to every provider.

The October 2026 connection audit added regression coverage for native credential forwarding, asynchronous picker saves, and reasoning/tool-signature continuation metadata. An OpenAI `gpt-4.1-mini` synthetic probe passed text, a two-call tool round trip, and structured output in four requests (441 input / 126 output tokens). Installing the presets alone is not certification of every model or provider feature.

On October 24, Gemini environment detection and model discovery succeeded.
Generation against the listed `gemini-2.5-flash` returned HTTP 404 (both with and
without the `models/` prefix). A bounded `gemini-3.8-flash` synthetic probe observed
multiple tool calls but encountered HTTP 503 and a timeout before completing its
tool round trip. Gemini is therefore **detected, not fully verified**. These
checks sent no project content. Ollama was started and `gpt-oss:20b` passed a fresh
synthetic runtime check using `list_files` and `read_file` to return an observed
fixture value. This does not validate every installed local model.

Phase 2 checks the existing Anthropic Messages and compatible Chat Completions adapters with protocol fixtures and small live model conversations. The machine-readable [matrix](../integrations/provider-matrix.json) separates adapter coverage, historical live results, and targets without live evidence. These checks establish particular protocol behaviors; they do not measure coding quality or establish that every model from a provider works.

## Observed model results

Checked on 2026-10-09. Each live check sends synthetic prompts, uses an in-memory lookup tool and validates a small JSON result; it does not send project files, research data, notes or agent instructions.

| Exact target | Text | Tool round trip | Multiple calls in one reply | JSON schema request/result | Evidence |
| --- | --- | --- | --- | --- | --- |
| Ollama `gpt-oss:20b`, local `/v1/chat/completions` | Passed | Passed | Not observed; two sequential calls worked | Passed | 5 live requests; 930 input / 982 output tokens reported |
| OpenAI `gpt-4.1-mini-2025-04-14`, Chat Completions | Passed | Passed | Observed | Passed | 4 live requests; 453 input / 138 output tokens reported |
| Anthropic Messages | Fixture coverage | Fixture coverage | Grouped results verified with fixtures | Request mapping verified with fixtures | No live model selected or Anthropic credential available |
| Gemini through its OpenAI compatibility endpoint | Shared adapter fixture coverage | Shared adapter fixture coverage | Unverified live | Shared adapter request mapping only | No live model selected or Google credential available |
| Other compatible services | Shared adapter fixture coverage | Shared adapter fixture coverage | Unverified live | Model-dependent | Select and check an exact endpoint/model |

“Not observed” is not evidence that the model cannot emit multiple calls. Nexus executes client tools sequentially even when a model returns several calls together. Anthropic result blocks are grouped into the next user message as its protocol requires. A structured-output pass means the probe received the requested two-field JSON object; it does not certify every schema. The workflow planner still parses and validates its own JSON proposal separately.

## Repeat a check

```sh
nexus providers
nexus providers check local-ollama
nexus doctor
```

`providers` and `doctor` only read saved evidence; they make no model calls. `providers check NAME` explicitly invokes a configured profile, up to six requests with no automatic retries. Remote providers may charge for those requests. Ctrl+C cancels the request and saves the check outcome. No default routes are changed.

Receipts live in `.nexus/provider-checks`. They include the exact model/endpoint, request options, pass/fail checks, usage and timestamp; no API keys, model output or synthetic tool values are saved. Earlier receipts may omit request options; the tracked matrix records the settings used for the initial checks. Changing a profile's model, URL, limits, credential reference or rates marks its old receipt stale. Changing the credential value or a model behind an unchanged alias is not detectable; rerun the check. Saved evidence is historical, not a health check.

For an explicit environment-only check without adding a profile:

```sh
NEXUS_PROVIDER=compatible \
NEXUS_MODEL=gpt-4.1-mini-2025-04-14 \
NEXUS_BASE_URL=https://api.openai.com/v1 \
NEXUS_CHECK_MAX_TOKENS=512 \
NEXUS_CHECK_TOKEN_FIELD=max_completion_tokens \
nexus providers check-env
```

The example uses an already-exported `OPENAI_API_KEY`. For Anthropic use `NEXUS_PROVIDER=anthropic`, the intended model ID, `https://api.anthropic.com/v1` and `ANTHROPIC_API_KEY`. Other services use an explicit `NEXUS_API_KEY`; ambient OpenAI/Anthropic keys are used only at the corresponding official origin. Do not paste credentials into configuration files or commit receipts containing private endpoint information.

## Profile settings

The [configuration example](../integrations/providers.example.json) includes OpenAI, Anthropic, local and Gemini-compatible profiles. Model availability depends on the account; placeholders must be replaced before use. A real OpenAI baseline was tested without making it this workspace's default.

```json
{
  "kind": "compatible",
  "model": "gpt-4.1-mini-2025-04-14",
  "baseUrl": "https://api.openai.com/v1",
  "keyEnv": "OPENAI_API_KEY",
  "maxOutputTokens": 4096,
  "tokenLimitField": "max_completion_tokens",
  "timeoutMs": 120000
}
```

`maxOutputTokens` is 1–32,768 and defaults to 4,096. `timeoutMs` is 100–120,000 and defaults to 120,000. `tokenLimitField` selects `max_tokens` (default for compatible servers) or `max_completion_tokens`; Anthropic always sends `max_tokens`. Use the parameter supported by the chosen endpoint/model. Reaching the token limit fails the response before executing tools. The limit may include reasoning tokens, depending on the service. Missing explicitly referenced credentials fail before a request; profiles do not borrow unrelated environment keys.

Low-level `provider.complete(messages, tools, {signal, responseSchema: {name, schema}})` maps a JSON schema to compatible `response_format` or Anthropic `output_config.format`. Services may reject unsupported features. Nexus does not automatically retry with the schema removed, and callers must validate returned data for their task. Streaming, multimodal input, provider-hosted tools, native Gemini API and the OpenAI Responses API are not implemented in these adapters.

## Errors and accounting

Adapters validate the entire returned tool batch before any call reaches the runtime: object arguments, valid unique call IDs, bounded count, usable text, completion state and nonnegative token counts. Truncation, refusal, blank output and malformed JSON fail explicitly. Some compatible servers omit completion reasons; a reason is inferred only for an otherwise valid response. Unknown or explicitly null reasons are rejected. The response body remains bounded to 4 MiB.

HTTP failures expose sanitized status and categories: authentication, rate limit, quota, missing model, context limit, timeout or other HTTP error. Cancellation and connection failures are separate. Error bodies and credentials are not echoed. Checks and runs do not retry automatically, preventing hidden repeated model charges.

Usage sums reported common input/output tokens. Missing/partial usage leaves `reported: false` and `estimatedCost: null`; failed provider requests also leave cost unknown in checks and runs, including after an earlier successful request. Optional `inputCostPerMillion` and `outputCostPerMillion` are user-supplied estimates. Provider-specific cache, batch, service-tier and other charges are not reproduced; provider billing is authoritative. No monetary estimate was claimed for the initial live checks because rates were not configured.

Fixture coverage includes both adapters' serialization, multiple calls/results, structured requests, refusal/truncation, malformed responses, HTTP classification, cancellation/timeouts, response limits, credential isolation, persisted failed/cancelled runs and usage totals. Tests use loopback HTTP servers and synthetic secrets; normal CI does not contact model providers. Anthropic/Google live validation remains outstanding until exact models and credentials are available.

Protocol references used for the adapters: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).

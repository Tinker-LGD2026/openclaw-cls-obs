# OpenClaw CLS Agent Observability

An OpenClaw plugin that exports agent execution as Tencent Cloud CLS Agent
Traces. Install and go — no changes to OpenClaw itself: call trees, token
usage, tool calls, and errors appear automatically in the CLS console's agent
observability view.

[中文文档](README.md)

## What you get

| Capability | Details |
|---|---|
| Call tree | Full tree per question: Turn → ReAct rounds → model calls → tool executions |
| Token usage | Precise **per model call** attribution (input/output/cache separated), aggregated per turn |
| Cost estimation | Per-call cost from the model price table (not billing) |
| Tool details | Name, arguments, result, duration, exit code |
| Error classification | Low-cardinality `error.type` for tool failures, broken streams, etc. |
| Subagents | Parent/child traces linked; `sessions_spawn` children never orphaned |
| Content capture | Off by default; opt-in message bodies with automatic delta dedup for long sessions |

Export is standard OTLP/HTTP straight to your CLS trace topic.

## Quick start (5 minutes)

**1. Install**

```bash
# COS (recommended)
curl -fsSL https://agent-plugin-1254139626.cos.ap-shanghai.myqcloud.com/cls-agent-observability/latest/install.sh | sh

# or npm
openclaw plugins install npm:openclaw-cls-agent-observability
```

**2. Configure credentials** (4 env vars, injected at runtime)

```bash
export CLS_ENDPOINT=https://ap-shanghai.cls.tencentcs.com   # your region
export CLS_TRACE_TOPIC_ID=<trace topic ID>
export CLS_SECRET_ID=<SecretId>
export CLS_SECRET_KEY=<SecretKey>
export CLS_CONTENT_MODE=truncate   # recommended; default off captures structure only
```

> `CLS_TRACE_TOPIC_ID` is the **trace topic ID**, not the agent application ID —
> the #1 cause of "no data in console".

**3. Grant conversation hooks** (npm channel must-read)

Non-bundled plugins get no conversation hooks by default; without the grant the
plugin loads but reports **nothing**. `install.sh` writes it automatically; for
npm installs, ensure `openclaw.json` contains:

```json
{ "plugins": { "entries": { "cls-agent-observability": { "enabled": true,
  "hooks": { "allowConversationAccess": true } } } } }
```

**4. Restart the gateway and verify**

```text
[plugins] CLS agent trace export enabled service=openclaw-gateway content=truncate
```

Ask the agent anything; the full trace shows up under Agent Observability in
the CLS console.

## How it works

The plugin consumes OpenClaw's plugin hooks and mirrors the host's real span
tree into the five CLS span kinds:

```text
[entry] enter_application          one question (turn-level IO summary)
└─ [agent] invoke_agent            the whole run (usage aggregate, final state)
   ├─ [step] react round_1         ReAct round 1
   │  ├─ [chat] chat               model call: context in → tool_call out
   │  └─ [tool] tool_call          tool execution: arguments → result
   └─ [step] react round_2
      └─ [chat] chat               model call: tool results → final answer
```

OpenClaw tracks real span IDs via `AsyncLocalStorage` and forwards them through
`ctx.trace`; the plugin uses them directly and never infers parentage.

## Configuration

**Two sources: environment variables win over the config file.** The file form
lives at `plugins.entries.cls-agent-observability.config` in `openclaw.json`
with camelCase keys (e.g. `contentMode`); unknown keys are rejected by the
host, edits **hot-reload** without a gateway restart, and the startup log
prints a redacted `effective config:` summary.

Required: `CLS_ENDPOINT`, `CLS_TRACE_TOPIC_ID`, `CLS_SECRET_ID`,
`CLS_SECRET_KEY`. Highlights (full table in the [Chinese README](README.md)):

| Env var | Default | Purpose |
|---|---|---|
| `CLS_CONTENT_MODE` | `off` | `off` / `truncate` / `full` message capture |
| `CLS_CONTENT_MAX_CHARS` | `1100000` | Per-field truncation under `truncate` |
| `CLS_INPUT_MESSAGES_MODE` | `delta` | First call full, later calls delta (prefix-verified) |
| `CLS_SYSTEM_PROMPT_MODE` | `full` | System prompt once per session; `hash` / `off` available |
| `CLS_IDENTITY_MODE` | `hash` | `hash` (needs `CLS_IDENTITY_HMAC_KEY`) / `raw` / `static` |
| `CLS_TRACE_SAMPLE_RATE` | `1` | Sampling rate |
| `CLS_STATS_INTERVAL_MS` | `300000` | Self-observability stats log interval; `0` disables |

With no configuration the plugin sleeps and never blocks gateway startup;
invalid values log warnings instead of silently falling back.

## Deployment & operations

- [docs/deployment.md](docs/deployment.md) — Docker / TKE initContainer /
  systemd / offline, including the "bake once, starts enabled" image pattern
- [docs/operations.md](docs/operations.md) — restart semantics, hot reload,
  capacity planning
- [docs/data-classification.md](docs/data-classification.md) — what each mode
  sends where, for security review
- [docs/compatibility.md](docs/compatibility.md) — host version matrix
  (`v2026.6.5`, `v2026.7.1-2`, dual-version release gate)

## Security posture

- No prompts, model outputs, or tool payloads by default
- Error bodies off by default; low-cardinality `error.type` only
- Identities HMAC-pseudonymized by default
- Credentials scrubbed from `process.env` right after reading
- Endpoint pinned to CLS official domains
- Private `TracerProvider`; coexists with the official OTel exporter

## Compliance & support

- License: Apache-2.0 ([LICENSE](LICENSE)); third-party attribution: [NOTICE](NOTICE)
- SBOM: `package-lock.json` (runtime closure: 11 Apache-2.0 packages)
- Vulnerability gate: CI runs `npm audit --audit-level=high --omit=dev`
- Issues: [GitHub Issues](https://github.com/Tinker-LGD2026/openclaw-cls-obs/issues)

## Development

```bash
npm install
npm test                      # unit tests + real-traffic replay + contract checks
npm run pack:dist             # zero-dependency bundle + tarball
npm run e2e                   # real-gateway E2E (host auto-fetched; needs DEEPSEEK_API_KEY)
sh scripts/compat-matrix.sh   # dual-host smoke (release gate)
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

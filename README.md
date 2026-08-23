# AI Coworker Desktop

A local-first Electron application for running independent AI coworkers. Each coworker has a durable task queue, an isolated Pi worker runtime, a confined workspace, and policy-controlled tools.

## What is included

- React 19 desktop UI with CopilotKit React v2 headless hooks and typed tool rendering
- Local AG-UI-to-Pi event bridge over restricted Electron IPC
- One Node worker thread and one active task at a time per coworker
- Main-process-owned SQLite state, checkpoints, history, artifacts, and crash recovery
- Local image attachments sent to vision-capable models as multimodal context
- Streaming, Markdown-rendered coworker replies with picker and drag-and-drop image input
- Searchable live model catalogs, OpenRouter input/output pricing, and quick per-coworker model switching
- Agent Skills-compatible global skill library with per-coworker enablement
- Bundled web-search skill with Tavily, Exa, Firecrawl, and SerpAPI credential fallback
- Confined file, invoice, PDF/Word export, email-draft, and email-send tools
- Durable approval inbox with editable decisions and idempotent resume
- Persistent cron and one-time schedules, with chat reminders routed to the approval-gated local scheduler instead of file exports
- OS-backed encrypted model and integration credentials
- Tray/background operation, launch-at-login controls, and electron-builder packaging

The built-in demo coworkers use Pi's faux provider, so the complete Ava/Sarah milestone works without an API key. Open-ended coworkers can use Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, or a custom OpenAI-compatible endpoint after the provider is verified in Settings. Ollama defaults to `http://127.0.0.1:11434/v1`, LM Studio defaults to `http://127.0.0.1:1234/v1`, and both can be configured without an API key.

## Development

Requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Useful checks:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm package
pnpm dist
```

`pnpm test` builds the production worker first, then verifies queue isolation, real concurrent Pi workers, approval pause/resume, idempotency, scheduler recovery, and workspace confinement.

## Agent evals

The dedicated Vitest Evals suite exercises production worker threads and controlled tools, not mocked agent facades. Offline cases cover tool selection, response contracts, approval pause/approve/reject behavior, idempotent side effects, scheduler-first reminders, path confinement, malformed tool input, and multimodal validation.

```sh
# Deterministic, keyless suite used by CI
pnpm eval

# Also write eval-results/latest.json for the report UI or CI checks
pnpm eval:report
pnpm eval:ui
```

Live-provider quality cases are opt-in. They use the same harness and remain skipped unless all required variables are present:

```sh
EVAL_PROVIDER=openai \
EVAL_MODEL=gpt-4.1-mini \
EVAL_API_KEY=... \
pnpm eval
```

`EVAL_PROVIDER` supports `anthropic`, `openai`, `google`, and `openrouter`. The provider-specific `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or `OPENROUTER_API_KEY` can be used instead of `EVAL_API_KEY`. Live evals may incur provider charges; the deterministic suite never makes remote model calls.

## Local data and security

Application state is stored under Electron's user-data directory. Model and email API keys are encrypted with Electron `safeStorage`; plaintext keys are never written to SQLite or exposed back to the renderer.

Provider configuration, catalog, startup, inference, and runtime-exit failures are written as redacted JSON Lines to `logs/provider-errors.jsonl` under that directory. Records include provider/model and task/run identifiers, but exclude prompts and credentials; the file rotates at 5 MB. Recent entries can be reviewed in Settings → Data, where a redacted support report can be copied or exported for sharing.

The renderer has context isolation, sandboxing, no Node integration, a restrictive CSP, and a narrow preload API. Workers cannot access SQLite or credentials directly. File tools resolve relative paths against the coworker's workspace and reject traversal or escaping symlinks. Attached images are validated, limited to four images and 20 MB total per message, and stored inside the coworker's workspace so queued work can recover after a restart. V1 intentionally has no arbitrary shell, Python, or code-execution tool.

Email defaults to a local `.eml` outbox. Resend can be configured for real delivery, but `email.send` follows the coworker's durable approval policy and uses a stable idempotency key.

Skills can be uploaded as `SKILL.md` files or installed from an HTTPS URL in Settings. Pasting a compliant skill URL into coworker chat also installs it globally and enables it for that coworker. Skill metadata is exposed to the model first; full instructions are loaded on demand through the controlled skill reader. Remote skill downloads reject credential-bearing, local, and private-network URLs, and bundled skills cannot be replaced by downloaded content.

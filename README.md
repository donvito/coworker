# AI Coworker Desktop

A local-first Electron application for running independent AI coworkers. Each coworker has a durable task queue, an isolated Pi worker runtime, a confined workspace, and policy-controlled tools.

## What is included

- React 19 desktop UI with CopilotKit React v2 headless hooks and typed tool rendering
- Local AG-UI-to-Pi event bridge over restricted Electron IPC
- One Node worker thread and one active task at a time per coworker
- Main-process-owned SQLite state, checkpoints, history, artifacts, and crash recovery
- Local image attachments sent to vision-capable models as multimodal context
- Confined file, invoice, PDF/Word export, email-draft, and email-send tools
- Durable approval inbox with editable decisions and idempotent resume
- Persistent cron and one-time schedules with run-once missed-run recovery
- OS-backed encrypted model and integration credentials
- Tray/background operation, launch-at-login controls, and electron-builder packaging

The built-in demo coworkers use Pi's faux provider, so the complete Ava/Sarah milestone works without an API key. Open-ended coworkers can use Anthropic, OpenAI, or Google after a credential is stored in Settings.

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

## Local data and security

Application state is stored under Electron's user-data directory. Model and email API keys are encrypted with Electron `safeStorage`; plaintext keys are never written to SQLite or exposed back to the renderer.

The renderer has context isolation, sandboxing, no Node integration, a restrictive CSP, and a narrow preload API. Workers cannot access SQLite or credentials directly. File tools resolve relative paths against the coworker's workspace and reject traversal or escaping symlinks. Attached images are validated, limited to four images and 20 MB total per message, and stored inside the coworker's workspace so queued work can recover after a restart. V1 intentionally has no arbitrary shell, Python, or code-execution tool.

Email defaults to a local `.eml` outbox. Resend can be configured for real delivery, but `email.send` follows the coworker's durable approval policy and uses a stable idempotency key.

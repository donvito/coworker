# Features

Coworker is a local-first Electron app for independent AI coworkers. Each coworker has its own durable task queue, an isolated worker runtime, a confined workspace, and policy-controlled tools — so it can do real work (documents, invoices, email drafts, scheduled reminders) without arbitrary code execution.

## Coworkers and chat

- Multiple coworkers, each with its own role, system prompt, tool set, and workspace
- Direct conversations with one coworker
- Multiple named conversations persisted across restarts
- Search conversation titles and message contents, with messages grouped and timestamped by day
- Right-click any coworker in the chat sidebar to open their settings
- Streaming, Markdown-rendered replies with typed tool call rendering
- Image attachments via picker or drag-and-drop, sent to vision-capable models
- Searchable live model catalogs with OpenRouter pricing and quick per-coworker model switching

## Work execution

- One task at a time per coworker, on an isolated Node worker thread
- Durable SQLite task queue with checkpoints, history, artifacts, and crash recovery
- Approval inbox with editable decisions and idempotent resume
- Persistent cron and one-time schedules; chat reminders route to the approval-gated scheduler

## Tools

- Confined file read/list/write inside the coworker workspace
- Invoice creation
- Document export to PDF, Word DOCX, Excel XLSX, and CSV from semantic Markdown
- Email drafts (`.eml` outbox by default) and approval-gated sending via Resend
- Web search with Tavily, Exa, Firecrawl, and SerpAPI credential fallback

## Skills

- Agent Skills-compatible global skill library with per-coworker enablement
- Bundled `web-search` and `document-authoring` skills
- Install by uploading a `SKILL.md`, from an HTTPS URL in Settings, or by pasting a skill URL into chat
- Metadata is exposed to the model first; full instructions load on demand through a controlled skill reader

## Telegram

Pair a private Telegram chat and message a coworker from your phone.

- Replies stream back to Telegram and mirror to the desktop conversation
- Documents and photos move both ways
- Approvals arrive as buttons you can tap
- `/stop` cancels in-flight work and keeps the partial reply in both places

## Platform

- Tray/background operation and launch-at-login controls
- electron-builder packaging for macOS, Windows, and Linux
- OS-backed encrypted model and integration credentials
- Redacted application diagnostics with downloadable ZIP support bundles
- Complete ZIP backups of conversations, database state, coworker workspaces, and outbox files

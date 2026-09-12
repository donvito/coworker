# Features

Coworker is a local-first Electron app for independent AI coworkers. Each coworker has its own durable task queue, an isolated worker runtime, a confined workspace, and policy-controlled tools — so it can do real work (documents, invoices, email drafts, scheduled reminders) without arbitrary code execution.

## Coworkers and chat

- Multiple coworkers, each with its own role, system prompt, tool set, workspace, and saved memory
- Direct conversations with one coworker
- Multiple named conversations persisted across restarts
- Search conversation titles and message contents, with messages grouped and timestamped by day
- Right-click any coworker in the chat sidebar to open their settings
- Streaming, Markdown-rendered replies with typed tool call rendering
- Image attachments via picker or drag-and-drop, sent to vision-capable models
- Searchable live model catalogs with OpenRouter pricing and quick per-coworker model switching

## Appearance

- Light, Dark, and System modes, independent of the selected color theme
- Graphite, Forest, Ocean, Plum, and Clay themes in both light and dark mode
- Quick **Appearance** controls in the workspace, coworker chat, and channel sidebars, also available in **Settings → General**
- Switch in place without losing unsent drafts; saved choices restore across restarts, and System mode follows device changes

## Memory

- One local `MEMORY.md` per coworker, shared across its conversations and retained across restarts
- Ask a coworker to remember, show, correct, or forget saved facts and preferences through the bundled `coworker-memory` skill
- The model can suggest durable preferences and ongoing project facts you share naturally; every model-proposed change requires approval
- Inline chat cards show the proposed item and let you approve, edit, or reject it
- Telegram shows the full proposal with approval buttons and an edit-by-reply option
- Memory loads at the start of every turn, including scheduled work; edits apply on the next turn
- Edit or clear memory in coworker settings or with `coworker memory show`, `set`, and `clear`
- An 8,000-character limit and revision checks to protect against conflicting app writes
- Included in workspace backups

See the [memory guide](memory.md) for examples, limits, and privacy details.

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
- Bundled skills include `web-search`, `document-authoring`, and `coworker-memory`
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

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

## Team collaboration

- **Primary coworker.** Mark one coworker as primary in its settings. It acts as chief of staff: a single point of contact that routes requests to the right specialist, coordinates multi-coworker work, and reports back in one conversation. Only one coworker can be primary; promoting another moves the role. Behavior comes from the bundled `primary-coordinator` skill, which is enabled only on the primary.
- **Team digest.** A primary coworker gets a daily "Team digest" schedule, and is the default assignee on the Home page, (09:00, editable on the Schedules page) that summarizes what the other coworkers did and surfaces anything needing your attention. You can also ask it "what's going on?" at any time. Turning the role off disables the schedule.
- **Messaging between coworkers.** Every coworker has the bundled `coworker-messaging` skill (`coworkers.list`, `coworkers.send_message`). Messages are asynchronous. The target does the work in one standing conversation per requester in their own chat history ("From Ava"), so earlier requests stay together and give them context. Open it from their history or the Activity entry. When they finish, the sender gets a follow-up and reports a short summary back in its own conversation; the full work is not pasted. If a coworker consults someone else while answering, its later answer is forwarded to the original sender too. Nesting is limited to 3 levels (A asks B asks C asks D); asking several coworkers one after another doesn't count against it. There's also a limit of 30 requests per pair per hour, and no self-messaging. Unanswered requests are delivered after a restart, and cancelled or failed requests report back instead of leaving the sender waiting.
- **Tagging in chat.** Type `@` in any direct chat to tag another active coworker. The tagged coworker works on your message in their own conversation, and the chat's coworker summarizes the result back in your chat when they're done. The chat's coworker only answers the message itself if you tag it too. Images can't be sent with tagged messages yet.
- **Photos.** Upload a photo for any coworker when creating it or in its settings (PNG, JPEG, or WebP up to 10 MB; stored locally, cropped to a 256 px square). Removing it restores the bundled avatar.
- **Tags and search.** Give coworkers up to 10 tags. The Coworkers page has a search box (name, role, description, tags; `#tag` matches tags only) and clickable tag filters.

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
- Telegram and Discord show the full proposal with approval buttons and an edit-by-reply option
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
- Web search with Tavily, Exa, Firecrawl, and SerpAPI credential fallback, working without a key on Firecrawl's free tier

## Skills

- Agent Skills-compatible global skill library with per-coworker enablement
- Bundled skills include `web-search`, `document-authoring`, and `coworker-memory`
- Install by uploading a `SKILL.md`, from an HTTPS URL in Settings, or by pasting a skill URL into chat
- Metadata is exposed to the model first; full instructions load on demand through a controlled skill reader

## Telegram

Connect one Telegram bot per coworker, paired to one private chat. Telegram connections are independent across coworkers, with separate conversations, credentials, and pairing controls.

- Replies stream back to Telegram and mirror to the desktop conversation
- Documents and photos move both ways
- Approvals arrive as buttons you can tap
- `/stop` cancels in-flight work and keeps the partial reply in both places

## Discord

Connect one Discord bot per coworker, paired to one server channel (or a thread/forum post in it). A coworker may have both one Telegram and one Discord connection. Discord connections are independent across coworkers, with separate conversations and connection controls.

- Invite the bot, then paste the pairing code in the channel or thread you want — that is the only pairing action
- Threads and forum posts become their own desktop conversations
- In the paired parent channel, ordinary chatter is ignored; any human can @mention the bot to start a thread (named from the message) and talk there. Messages in that thread continue without another mention
- Other guild channels are ignored
- The bot reacts 👀 after it has injected the message and the coworker run has started
- Replies finish as Discord markdown (typing while they work; no live draft stream)
- Documents and photos move both ways into `discord-inbox/`
- Approvals arrive as buttons you can tap; reply to the edit prompt to approve replacement text
- `/stop` cancels in-flight work

Bot conversations remain accessible in the desktop app. Desktop replies within one of those conversations go only to its bot; ordinary desktop conversations are not broadcast. Desktop-started conversations stay local. If you request delivery to Telegram or Discord and several coworker connections match, the coworker asks which connection to use. An incoming bot request uses its own connection by default.

On upgrade, existing bots stay paired and future messages start in fresh bot-specific conversations. Previous history remains in the desktop app.

## Platform

- Tray/background operation and launch-at-login controls
- electron-builder packaging for macOS, Windows, and Linux
- OS-backed encrypted model and integration credentials
- Redacted application diagnostics with downloadable ZIP support bundles
- Complete ZIP backups of conversations, database state, coworker workspaces, and outbox files

### Messaging configuration

Each coworker can connect one Telegram bot and one Discord bot. Configure them in the coworker’s settings or in the global **Settings → Channels** page; both views manage the same connections. Messaging changes save independently of the coworker’s other settings. Unpairing keeps the platform slot occupied; disconnecting frees it. Conversations started on desktop remain local, while conversations started through a bot sync with that bot.

If an older profile has several active bots on the same platform for one coworker, the upgrade pauses those conflicting connections and keeps their credentials, pairings, and history. Reconnect the desired bot or move a bot to a coworker with a free slot. Reconnecting a paused bot can reuse its stored token; explicitly disconnecting it removes that token.

### Coworker files and output folders

Open **Files** beside **History** and **New** in a coworker conversation to browse its workspace and granted folders. Preview documents or images, open or reveal files, download individual files, or select files/folders and choose **Download ZIP**. Unregistered files are included. PDF, DOCX, XLSX, PPTX, and text content can be previewed; HTML and SVG appear as source.

Navigate with the folder tree or choose **All files** to search across locations. ZIP downloads save only to the location selected in the save dialog. **Delete** moves selected regular files to Trash or Recycle Bin after confirming their paths. Folders can also be deleted: a separate confirmation warns that all files and subfolders will be permanently deleted and cannot be recovered. Deletion requires current write access; workspace and granted-folder roots, symbolic-link selections, and managed memory files are protected. Files changed while confirmation is open must be reviewed again.

Historical tool-result file cards show **Deleted** after their artifact record is removed, without Open or Download buttons. File actions check availability when mounted, when artifacts or folder grants change, and when the app regains focus. Files removed outside the app show **File missing**; their records are retained so restoring the file restores its actions. Access failures show **File unavailable** instead of marking the file deleted.

In coworker settings, add a folder and optionally enable **Allow writing**. Choose **Default output** to save work deliverables there. Existing grants remain read-only. Memory and internal working files stay in the coworker workspace. Removing a generated external artifact from the artifact list leaves its original file in your folder.

Document and invoice exports use the configured output folder when no destination is supplied. An explicit destination takes precedence; Workspace is the fallback only when no output folder is configured. If the configured folder is unavailable or no longer writable, export reports an error instead of saving elsewhere.

The bundled file-archiving skill creates ZIP deliverables. Document authoring also supports HTML, JSON, and TSV through packaged scripts, alongside the existing Office and PDF formats.

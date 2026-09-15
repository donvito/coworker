# Terminal and headless guide

Coworker includes a CLI for headless operation and administration. It uses the Electron runtime bundled with the desktop app; no separate Node installation is needed for an installed app. Headless mode creates no window or tray, but still runs workers, schedules, and configured Telegram and Discord connections. This release requires a desktop environment and access to the user's OS credential storage; it is not a display-free Linux server distribution.

## Coworker memory

Each coworker keeps one `MEMORY.md` in its own workspace, shared across its conversations. Memory is loaded at the start of each turn, including scheduled work. Find the coworker's ID, then read, replace, or clear its memory:

```sh
coworker coworkers list
coworker memory show COWORKER_ID
coworker memory show COWORKER_ID > notes.md
# Edit notes.md before replacing the saved memory.
coworker memory set COWORKER_ID --file notes.md
coworker memory clear COWORKER_ID
```

These commands take a coworker ID, not its display name. The app must be running in the selected profile; use `coworker start` if needed and the same global `--data-path` option as the desktop when using a custom profile. Direct memory commands do not require a model or API key.

`show` prints the exact saved text without adding a newline, so it can be redirected to a UTF-8 file and imported again. `set` replaces the whole file; preserve existing entries in the file you submit. Memory is limited to 8,000 characters. `clear` saves empty memory, while previous chats, tool history, and existing backups remain.

For edits that must detect changes since you began editing, obtain both `content` and `revision` from `memory show COWORKER_ID --json`. Edit that content in a local file and supply the same revision:

```sh
coworker memory show COWORKER_ID --json
coworker memory set COWORKER_ID --file notes.md --revision REVISION
# The same check is available when clearing memory.
coworker memory clear COWORKER_ID --revision REVISION
```

Replace `REVISION` with the value returned by `show --json`. A conflicting write fails; keep your draft, fetch the latest content and revision, then merge and retry. Without `--revision`, the CLI reads the current revision immediately before writing. This catches a competing app write during the command, but does not detect changes made while you were editing the local file. Revision checks coordinate app writers; direct edits in an external editor do not participate in the app's write lock.

With a configured model and the memory skill enabled, you can also ask in chat:

```sh
coworker chat Ava "Remember that I prefer invoice totals in SGD."
```

Chat-based memory changes pause for approval, including an explicit remember request. Review the proposed item in the desktop chat or paired Telegram conversation, or use the CLI's `approvals` commands. Direct `memory set` and `memory clear` commands are user-operated edits and save without an extra approval.

The same saved memory is editable in coworker settings under **Saved memory (Markdown)**. See the [memory guide](memory.md) for inline editing, Telegram approval, desktop steps, skill enablement, limits, and data handling.

## Install the command

After installing the desktop app, run its executable with `--install-cli`. Installation is explicit and never replaces an existing `coworker` command.

macOS:

```sh
/Applications/Coworker.app/Contents/MacOS/Coworker --install-cli
export PATH="$HOME/.local/bin:$PATH"
```

Linux (use your actual executable or AppImage path):

```sh
/path/to/Coworker --install-cli
export PATH="$HOME/.local/bin:$PATH"
```

Windows PowerShell (use your actual installation path):

```powershell
& "$env:LOCALAPPDATA\Programs\Coworker\Coworker.exe" --install-cli
$env:PATH = "$env:LOCALAPPDATA\Coworker\bin;$env:PATH"
```

Make the PATH change permanent in your shell profile or Windows user environment settings. `--bin-dir /absolute/directory` chooses a different installation directory. After moving the app, remove only its old generated launcher and reinstall it. The launcher contains app paths, not credentials. For an AppImage, keep the AppImage file in a stable location; the launcher resolves its changing internal mount path each time.

From a checkout:

```sh
pnpm build
pnpm cli --help
pnpm cli start
```

## Lifecycle and shared desktop state

```sh
coworker start
coworker status
coworker restart
coworker stop
coworker run --headless
```

`start` runs headless in the background and returns after readiness. It returns the existing instance's status if that profile is already running. `run --headless` stays in the foreground and refuses to attach to an existing owner; Ctrl-C or SIGTERM shuts it down. A supervisor can use this foreground command, but the CLI does not install OS services.

A profile has one owner. Opening the desktop while headless mode is running reveals that owner's UI without duplicating schedules, Telegram polling, Discord Gateway, or workers. CLI changes are visible in the desktop. Closing the desktop retains the existing **Run in background** setting; `stop` explicitly quits the entire instance.

`restart` preserves the owning app executable and identity, profile, and whether the app has desktop UI. It stops services, flushes logs, waits for process exit, and starts the replacement. Active tasks follow the app's existing interrupted-task recovery on restart. Shutdown failures or timeouts are reported; the CLI never silently force-kills the owner. Configuration commands do not start an app automatically because startup also activates scheduled work.

Credentials are reused within the same OS user, app identity, and profile. Development uses **Coworker Development**, separate from the installed app. Choose an explicit profile with:

```sh
coworker --data-path /absolute/path/to/profile start
coworker --data-path /absolute/path/to/profile status
```

`--data-path` takes precedence over `COWORKER_DATA_PATH`. Existing symlink ancestors resolve to the same profile. A relative path or filesystem root is rejected. Secure-storage errors require restoring OS credential access or re-entering credentials under the correct app identity; there is no plaintext fallback added by the CLI.

## Start automatically at user login

With the installed macOS or Windows app running:

```sh
coworker startup enable --headless
coworker startup status
coworker startup disable
```

`startup enable` defaults to headless. Use `startup enable --ui` to open the desktop when you sign in. Enabling saves the running owner's executable, selected data profile, and startup mode; it does not change the current running mode. These commands require a running app, like other configuration commands. Development checkouts and Linux startup registration are not supported in this version.

This starts Coworker when you sign in, not before login. The existing **Launch at login** checkbox controls the same OS registration and preserves the selected mode. One profile can be registered per installed app identity. Use `--data-path` to select a custom profile; disable startup from the registered profile before enabling it for another one. Repeated login launches use the profile's existing instance lock.

`startup status` reports the OS registration, whether it is enabled, the saved mode, and the owning profile. If macOS requires approval or Windows has disabled the entry, follow the reported Login Items/Startup Apps instructions. Unrelated settings changes never re-enable startup. `startup disable` removes the registration while remembering the mode. After moving or reinstalling the app, run `startup enable` from the new installation to refresh its registration.

## Models and coworkers

Run `pnpm cli start --ui` to open the desktop window, including for an existing headless instance. No restart is needed.

Chat prints tool names and status changes to stderr while waiting (checked every 500 ms). Fast calls may appear only as completed. `chat result TASK_ID` displays recorded tool states and follows new changes. Arguments and tool results are omitted; `--json` suppresses progress output.

Send a message directly from the terminal using a coworker's name or ID:

```sh
pnpm cli chat Ava "Hello, introduce yourself briefly."
pnpm cli chat Ava "Continue our discussion" --conversation CONVERSATION_ID
pnpm cli chat result TASK_ID
```

Installed users replace `pnpm cli` with `coworker`. A new chat creates a direct conversation visible in the desktop. The command prints the reply when complete, plus conversation and task IDs. `--timeout 120` controls how long to wait (1–3600 seconds); `--json` returns a structured result. Timeout or Ctrl-C stops waiting without cancelling accepted work. Pending approvals are displayed for manual review using the approval commands; after deciding, run `chat result TASK_ID` to wait for the reply. Chat uses the coworker's existing model and tools.

If interrupted before message submission, the CLI does not send the message. An interrupt during conversation creation may leave an empty conversation; if submission is already in flight, any returned task/conversation IDs are still reported in normal terminal output.

```sh
coworker models providers
coworker models configure openai --prompt-key
coworker models list openai
coworker models default openai MODEL_ID
coworker models default
coworker models endpoints add --name Local --base-url http://127.0.0.1:1234/v1
coworker models endpoints remove ENDPOINT_ID
coworker models credentials remove openai
coworker coworkers list
coworker coworkers show COWORKER_ID
coworker coworkers update COWORKER_ID --provider openai --model MODEL_ID
coworker coworkers update COWORKER_ID --status paused
```

`--prompt-key` hides input. Scripts may pipe a key from their secret manager to `--key-stdin`. API-key values are never accepted as flags or returned by credential-status commands. Omit both key flags to reuse the saved credential. Provider configuration verifies connectivity and model availability using the same service as the desktop. Custom provider IDs can be used as global defaults.

Create a coworker with `coworker coworkers create --file coworker.json`:

```json
{
  "name": "Reporter",
  "role": "Reporting assistant",
  "systemPrompt": "Prepare concise reports using the available tools.",
  "modelProvider": "demo",
  "modelName": "faux-1",
  "enabledTools": ["files.read", "files.write"],
  "enabledSkillIds": []
}
```

The example explicitly disables all skills with `enabledSkillIds: []`. Omit that field to enable the default skills, including `coworker-memory`.

`coworkers update ID --file patch.json` accepts the same patch fields as desktop settings, including `enabledSkillIds`, `policies`, and `sharedFolderPaths`. Explicit flags override file fields. Inspect the current object before replacing list fields. `coworkers remove ID` uses the desktop's removal behavior.

## Telegram

Configure the bot without exposing its token in shell history:

```sh
coworker telegram configure COWORKER_ID --prompt-token
# or: printf '%s' "$TELEGRAM_BOT_TOKEN" | coworker telegram configure COWORKER_ID --token-stdin
coworker telegram status
coworker telegram unpair --integration-id INTEGRATION_ID
coworker telegram disconnect --integration-id INTEGRATION_ID
```

The token is entered through hidden terminal input or stdin and is stored using the same OS-backed credential store as the desktop. After configuring, send the pairing link/code to the bot and confirm `Pairing: paired` before sending work. `unpair` keeps the bot configured but requires pairing again; `disconnect` removes the Telegram connection.

Configure without `--integration-id` adds a bot when the coworker has no active Telegram connection. A coworker may have one active Telegram connection; to edit or move an existing bot, use `coworker telegram configure COWORKER_ID --integration-id INTEGRATION_ID`. Omit the token to retain its current credential. Get integration IDs from `coworker telegram status`. Connections on different coworkers have independent pairing and conversations.

`telegram configure`, `telegram unpair`, and `telegram status` print the pairing link while waiting for pairing. Once paired, they show the chat ID instead. The main `status` command distinguishes an unconfigured Telegram integration from connected, disconnected, and error states.

## Discord

Configure the bot without exposing its token in shell history:

```sh
coworker discord configure COWORKER_ID --prompt-token
# or: printf '%s' "$DISCORD_BOT_TOKEN" | coworker discord configure COWORKER_ID --token-stdin
coworker discord status
coworker discord unpair --integration-id INTEGRATION_ID
coworker discord disconnect --integration-id INTEGRATION_ID
```

The token is entered through hidden terminal input or stdin and is stored using the same OS-backed credential store as the desktop. After configuring, invite the bot with the printed URL (leave the pre-selected permissions as-is), turn on Message Content Intent if the printed portal link says so, and post the pairing code in the Discord channel or thread you want. Confirm the status shows the guild and `#channel` before sending work. In a paired text channel, @mention the bot to start a thread; ordinary parent-channel chatter is ignored. `unpair` keeps the bot configured, issues a new code, and requires pairing again; `disconnect` removes the Discord connection and deletes the token.

Configure without `--integration-id` adds a bot when the coworker has no active Discord connection. A coworker may have one active Discord connection; to edit or move an existing bot, use `coworker discord configure COWORKER_ID --integration-id INTEGRATION_ID`. Omit the token to retain its current credential. Get integration IDs from `coworker discord status`. Connections on different coworkers have independent pairing and conversations.

`discord configure`, `discord unpair`, and `discord status` print the invite URL, pairing code, and Message Content Intent link while waiting for pairing. Once paired, they show the coworker, guild, and `#channel` (plus a thread name if you paired from one). The main `status` command distinguishes an unconfigured Discord integration from connected, disconnected, and error states. Telegram and Discord may both be connected.

## Skills, schedules, and approvals

```sh
coworker skills list
coworker skills show SKILL_ID
coworker skills install ./example/SKILL.md
coworker skills install ./example.skill --coworker COWORKER_ID
coworker skills install https://example.com/SKILL.md
coworker skills enable SKILL_ID --coworker COWORKER_ID
coworker skills disable SKILL_ID --coworker COWORKER_ID
coworker skills remove SKILL_ID

coworker schedules create --coworker COWORKER_ID --name "Morning report" \
  --cron '0 9 * * *' --timezone Asia/Singapore \
  --title "Prepare report" --input "Prepare today's report"
coworker schedules list
coworker schedules show SCHEDULE_ID
coworker schedules disable SCHEDULE_ID
coworker schedules enable SCHEDULE_ID
coworker schedules run SCHEDULE_ID
coworker schedules remove SCHEDULE_ID

coworker approvals list
coworker approvals show APPROVAL_ID
coworker approvals approve APPROVAL_ID
coworker approvals reject APPROVAL_ID
```

Skill archives use the standard root folder with `SKILL.md` and optional packaged resources. Installing a standalone `SKILL.md` installs only that file; use `.skill` or `.zip` to include scripts and resources. Assignment enables native model selection; it does not force a skill to load.

For one-time work, use `--run-at '2030-01-01T09:00:00+08:00'` instead of `--cron`. Both require an explicit timezone. `schedules create --file schedule.json` and `schedules update ID --file patch.json` accept the existing application schema, including `taskTemplate: { "title": "...", "input": "...", "priority": 0 }`. When changing a task template through flags, supply both `--title` and `--input`, or provide the complete template in a file.

Approval listing defaults to `PENDING`. Decisions use the existing validation, durable state, and worker-resumption path. Headless operation does not bypass approvals or broaden a coworker's tools.

`approvals show ID` displays the action, risk, coworker/task IDs, timestamps, and complete proposed payload as indented JSON. Resolved approvals also show their decided payload when present, so you can inspect the exact action before deciding.

## Diagnostics and scripting

```sh
coworker logs show --source app --level error --limit 100
coworker logs show --since '2026-09-01T00:00:00Z'
coworker logs follow --source provider
coworker logs export --output ./coworker-support.zip
coworker status --json
```

Log sources are `all`, `app`, and `provider`. Output is chronological and defaults to the most recent 100 matching records; `--since` and `--until` accept timestamps with offsets. Follow tolerates log rotation. Reading/following retained logs and exporting a support ZIP work while the app is stopped. An existing export requires `--overwrite`. Export includes retained application/provider diagnostics and system metadata, not the database, workspaces, or credential files.

`--json` emits one JSON value for normal commands and one JSON object per record for `logs follow`. Errors go to stderr. Do not automatically retry timed-out mutations: they may already have succeeded; inspect the resulting state first.

Without `--json`, commands print concise summaries and tables intended for people. For example, `coworker status` prints the running mode, PID, profile, and service state; list commands print aligned columns; and log commands print one readable line per record. Use `--json` when another program will consume structured output. `memory show` is an exception: its normal output is the exact Markdown, suitable for file export.

`models providers` includes built-in provider IDs and credential states, plus custom endpoint IDs, names, and base URLs. Creating an endpoint prints its provider ID for subsequent commands. `models default` shows the selected provider/model, or explicitly reports that they are not set.

`coworker activity list --limit 20` displays recent activity. The limit must be an integer from 1 to 1,000 and defaults to 50. Invalid limits return usage exit code 2 even when the app is stopped.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Operation or startup failure |
| 2 | Usage error or foreground profile already running |
| 3 | App stopped |
| 4 | Timeout |
| 5 | Control authentication or protocol mismatch |

The local control interface is versioned and authenticated. Unix sockets and descriptor files are private to the OS user; Windows uses a randomly named pipe with a token kept in the user's profile. Requests have size/time limits. Application diagnostics record method names and outcomes, never request payloads. The CLI exposes no credential-read, arbitrary SQL, or shell-execution endpoint.

## Verification

`pnpm test` includes CLI parsing, service operations, transport authentication/isolation, log handling, profile tests, and memory editing. `pnpm test:cli:smoke` runs a real Electron test with a temporary profile and a localhost fake provider: headless startup, concurrent starts, desktop attachment, credential sharing, restart, foreground signals, launcher installation, and offline diagnostics. Memory checks cover read/replace/clear, coworker isolation, stale revisions, desktop/CLI shared state, exact text export/import including the size limit, and persistence after restart.

To test an unpacked desktop distribution on each supported OS:

```sh
COWORKER_SMOKE_EXECUTABLE=/absolute/path/to/Coworker pnpm test:cli:smoke
```

No live model-provider account is used by the smoke test. It needs a desktop session and available OS secure storage.

Startup registration tests mock the OS and cover mode/profile persistence, conflicting profiles, OS approval and disabled states, rollback, and the shared desktop toggle. The macOS development smoke test also simulates the login signal through the real app entry point, verifying profile redirection before instance ownership. Smoke tests never enable or disable real login items. Actual sign-out/sign-in behavior still needs verification on installed macOS and Windows builds.

The model-routing evaluation `evals/administration-skill.eval.ts` checks matching and excluded requests with a real evaluation model or a saved recording. Like other behavior evaluations, it skips when neither is configured; deterministic discovery tests do not substitute for that model check.

### Manual login-startup test

Use an installed build: development checkouts intentionally reject `startup enable`. On macOS, run `pnpm package`, quit existing Coworker instances, and install the generated `Coworker.app` from `release/` into `/Applications`. Install the CLI using the instructions above if needed. On Windows, install the build under test and use its CLI.

1. Run `coworker start`, then `coworker startup enable --headless` and `coworker startup status`. Expect `enabled`, mode `headless`, and the intended profile path. Allow the login item in OS settings if approval is required.
2. Run `coworker stop`, then sign out and back in. Run only `coworker status`: it should report a running headless instance with no window or tray. Running `start` first would hide a failed login launch.
3. Run `coworker start --ui`, then `coworker status`. The desktop should open with the same PID, using the existing instance.
4. To test desktop startup, run `coworker startup enable --ui`, stop the app, and sign out and back in. Expect the desktop window to open automatically.
5. Clean up with `coworker startup disable`, verify `startup status` reports `disabled`, and run `coworker stop`. Sign out and back in once more to confirm Coworker stays stopped.

For a custom profile, pass the same `--data-path /absolute/profile` to every command. On macOS, turn off reopening windows for this test so session restoration does not obscure the login-startup result.

# Terminal administration

Coworker includes a CLI for headless operation and administration. It uses the Electron runtime bundled with the desktop app; no separate Node installation is needed for an installed app. Headless mode creates no window or tray, but still runs workers, schedules, and configured Telegram connections. This release requires a desktop environment and access to the user's OS credential storage; it is not a display-free Linux server distribution.

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

A profile has one owner. Opening the desktop while headless mode is running reveals that owner's UI without duplicating schedules, Telegram polling, or workers. CLI changes are visible in the desktop. Closing the desktop retains the existing **Run in background** setting; `stop` explicitly quits the entire instance.

`restart` preserves the owning app executable and identity, profile, and whether the app has desktop UI. It stops services, flushes logs, waits for process exit, and starts the replacement. Active tasks follow the app's existing interrupted-task recovery on restart. Shutdown failures or timeouts are reported; the CLI never silently force-kills the owner. Configuration commands do not start an app automatically because startup also activates scheduled work.

Credentials are reused within the same OS user, app identity, and profile. Development uses **Coworker Development**, separate from the installed app. Choose an explicit profile with:

```sh
coworker --data-path /absolute/path/to/profile start
coworker --data-path /absolute/path/to/profile status
```

`--data-path` takes precedence over `COWORKER_DATA_PATH`. Existing symlink ancestors resolve to the same profile. A relative path or filesystem root is rejected. Secure-storage errors require restoring OS credential access or re-entering credentials under the correct app identity; there is no plaintext fallback added by the CLI.

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

`coworkers update ID --file patch.json` accepts the same patch fields as desktop settings, including `enabledSkillIds`, `policies`, and `sharedFolderPaths`. Explicit flags override file fields. Inspect the current object before replacing list fields. `coworkers remove ID` uses the desktop's removal behavior.

## Skills, schedules, and approvals

## Telegram

Configure the bot without exposing its token in shell history:

```sh
coworker telegram configure COWORKER_ID --prompt-token
# or: printf '%s' "$TELEGRAM_BOT_TOKEN" | coworker telegram configure COWORKER_ID --token-stdin
coworker telegram status
coworker telegram unpair
coworker telegram disconnect
```

The token is entered through hidden terminal input or stdin and is stored using the same OS-backed credential store as the desktop. After configuring, send the pairing link/code to the bot and confirm `Pairing: paired` before sending work. `unpair` keeps the bot configured but requires pairing again; `disconnect` removes the Telegram connection.

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

Without `--json`, commands print concise summaries and tables intended for people. For example, `coworker status` prints the running mode, PID, profile, and service state; list commands print aligned columns; and log commands print one readable line per record. Use `--json` when another program will consume the output.

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

`pnpm test` includes CLI parsing, service operations, transport authentication/isolation, log handling, and profile tests. `pnpm test:cli:smoke` runs a real Electron test with a temporary profile and a localhost fake provider: headless startup, concurrent starts, desktop attachment, credential sharing, restart, foreground signals, launcher installation, and offline diagnostics.

To test an unpacked desktop distribution on each supported OS:

```sh
COWORKER_SMOKE_EXECUTABLE=/absolute/path/to/Coworker pnpm test:cli:smoke
```

No live model-provider account is used by the smoke test. It needs a desktop session and available OS secure storage.

The model-routing evaluation `evals/administration-skill.eval.ts` checks matching and excluded requests with a real evaluation model or a saved recording. Like other behavior evaluations, it skips when neither is configured; deterministic discovery tests do not substitute for that model check.

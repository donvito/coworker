# Memory guide

Each coworker has its own saved memory: one local `MEMORY.md` in its workspace, shared across its conversations and retained across app restarts. Use it for concise facts and preferences you want that coworker to know in future work.

A saved document format helps the coworker make a specific suggestion. For example, with “Default document format: PDF” saved, a request to create a document without a format should prompt “Your saved default is PDF. Shall I use PDF for this document, or would you prefer a different format?” Confirming that suggestion lets the coworker proceed. An explicit format in your request takes precedence, and using another format for one document does not change your saved preference.

## Remember, review, and forget in chat

Ask the coworker directly:

- “Remember that I prefer invoice totals in SGD.”
- “What have you saved in memory?”
- “Update my saved currency preference to EUR.”
- “Forget my saved currency preference.”

The bundled `coworker-memory` skill handles adding, updating, forgetting, and showing saved facts. It also lets the model propose a useful, durable fact or preference you state in conversation, such as your usual working timezone. This is model judgment, so it may miss a useful fact or make an unnecessary suggestion; explicit requests remain the most reliable way to ask for a memory update. Chat requests need a configured model and the skill enabled for that coworker.

Every model-proposed memory change requires approval, including explicit “remember this” requests. The coworker reads the current memory and proposes a focused change; nothing is saved while it is pending. File-tool permissions still apply. Reading saved memory does not require a memory-change approval.

The skill is enabled by default for new coworkers and added once to existing coworkers when this feature is first loaded. You can disable it in coworker settings. Disabling the skill removes its memory-management instructions; existing saved memory continues to load. Clear the saved text if you want to stop using it.

The skill excludes temporary instructions, duplicates, guesses, credentials, and facts taken from quoted documents or websites. No conversation content is silently saved. A reminder belongs in a schedule; saving “remind me tomorrow” as a fact does not create one.

## Review a proposal in chat

The inline approval card shows the proposed item and, for a correction or deletion, the existing text it changes.

- **Approve** applies the proposed change.
- **Edit** opens the proposed text directly in the card. Choose **Approve edited text** to use your version.
- **Reject** leaves memory unchanged.

The coworker resumes after the decision. Other messages to that coworker wait while an approval is pending. An optional suggestion should come after the answer or work you requested. You can also review memory proposals on the **Approvals** page.

## Review a proposal in Telegram

In the paired Telegram conversation, the bot shows the same proposed text with **Approve**, **Reject**, and **Edit & approve** buttons. Long proposals are sent in parts, with buttons after the complete text.

Tap **Edit & approve** to open a reply prompt. Reply to that specific message with the replacement text; sending that reply approves the text you wrote. Reply `/cancel` to cancel the edit and keep the original proposal pending. The edit reply is handled as an approval rather than being forwarded as a new model request. For text too long for a Telegram message, use the desktop editor.

Decisions sync between Telegram and the desktop. Memory changes always require approval; there is no **Always allow** option for them. Telegram editing requires the paired private user and the original message topic, and an already decided approval cannot be applied again.

## When memory is used

The app loads the latest memory at the start of every turn, including work in new conversations and scheduled tasks. Messages through Telegram use the paired coworker's same memory. Saving an edit takes effect on the next turn without restarting the coworker or changing an already running turn's context snapshot.

Each coworker and app data profile has separate memory. Saving a preference for Ava does not save it for Sarah. Current user instructions take precedence over saved facts; memory does not change tool permissions or grant approvals.

## Edit in the desktop app

1. Right-click the coworker in the chat sidebar and open its settings.
2. Find **Memory** and edit **Saved memory (Markdown)**.
3. Click **Save memory** and wait for the saved confirmation.

Memory saves separately from the other settings. While memory has unsaved changes, **Save changes** for the other settings is disabled; save or reload memory first. **Reload memory** replaces your draft with the latest saved text, so copy any unsaved work before reloading.

To clear all saved memory, delete the text and click **Save memory**. To forget only one fact, remove its entry and preserve the rest. This user-operated editor saves directly; it does not create a second approval request.

## Edit from the terminal

The app must be running in the same data profile. Direct memory commands do not need a model or API key. See the [terminal guide](cli.md#install-the-command) to install the CLI; from a checkout, replace `coworker` with `pnpm cli`.

```sh
coworker start
coworker coworkers list
coworker memory show COWORKER_ID
coworker memory show COWORKER_ID > notes.md
```

Use the coworker's ID from the list. Edit the exported UTF-8 Markdown file in your text editor, then save it back:

```sh
coworker memory set COWORKER_ID --file notes.md
```

`set` replaces the entire memory, so keep any entries you still want in `notes.md`. `show` outputs the exact saved text, including its existing line endings, without adding a newline. To clear all saved memory:

```sh
coworker memory clear COWORKER_ID
```

For an edit that must detect changes since your original read, use `coworker memory show COWORKER_ID --json` to obtain the content and its revision together. Edit that content, then pass its revision to `memory set COWORKER_ID --file notes.md --revision REVISION`. `clear` accepts the same flag. Without it, the CLI checks for competing app writes only during the command, not during your editing session. See [CLI memory commands](cli.md#coworker-memory) for the full workflow.

For a custom profile, include the same global `--data-path /absolute/path/to/profile` on each command. Installed apps and development checkouts use different default profiles.

## Limits and data handling

- Memory is limited to 8,000 characters per coworker, with a counter in the desktop editor. Keep entries short; if it fills up, shorten or remove entries you no longer need.
- The whole saved file is included in each turn's model context. There is no vector search, automatic conversation summarization, or expiry in this first implementation.
- Memory is plaintext on disk and included in workspace backups. Do not use it to store passwords or API keys. A configured cloud model receives memory in its context; a local model processes it locally.
- Clearing or forgetting changes future memory context. Earlier chats, tool history, existing backups, and data already sent to a provider are not erased.
- An absent `MEMORY.md` is treated as empty memory. The file is created when memory is first saved.

See [Data and security](security.md) for the wider storage and permission model.

## Troubleshooting

**A save reports that memory changed.** Another app writer updated the file after it was read. Copy your draft, reload the latest memory, merge your intended change, and save again. In the CLI, fetch the latest content and revision together before merging, then save with that revision. Direct edits in an external editor do not participate in the app's write lock; prefer the desktop or CLI for coordinated edits.

**A pending proposal reports that memory changed.** Reject the stale proposal and ask the coworker to propose the intended change again. The new proposal uses the current memory. Desktop approval errors keep your edited draft so you can copy it first. A failed Telegram edit reply leaves the original proposal pending.

**The coworker did not save a chat request.** Check that `coworker-memory` is enabled, the coworker uses a configured model, and any file-write approval has been completed. Ask it to show the saved memory, or inspect it with the desktop editor or `memory show`. A response alone is not evidence that the file was saved.

**Memory is missing or belongs to the wrong coworker.** Check the coworker ID and selected data profile. Memory is shared across that coworker's conversations, but not across coworkers or profiles.

**Memory fails to load after a manual file edit.** Invalid UTF-8, unsupported text, or a file over the size limit produces an error instead of being silently truncated. Find the coworker's `workspacePath` with `coworker coworkers show COWORKER_ID --json`, repair its `MEMORY.md` in a text editor as valid UTF-8 within the limit, and reload. Avoid editing a file while the coworker is also updating it.

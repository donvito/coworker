---
name: telegram-messaging
description: Send requested messages or files to Telegram when explicitly selected as the destination, or when delivery has no explicit destination and incoming request metadata identifies Telegram as the current channel. Do not use for ordinary conversation replies, delivery to Discord or email, or unspecified delivery from local (desktop or CLI) or missing channel metadata. A paired integration or a request for phone delivery alone does not select Telegram.
---

# Telegram messaging

Use the `telegram.send` tool to proactively deliver a message or files through a paired Telegram bot connection.

## When to use it

- The user asks to receive a file, report, or summary "on Telegram".
- The user asks "send it to me", "send it here", or requests file delivery without naming a destination, and incoming request metadata says `channel: telegram`.
- The user asks to be pinged or notified on Telegram when work finishes.
- A scheduled task's instructions say results should go to Telegram.

Do not call it for a normal reply in a conversation: the app already mirrors conversation replies to Telegram. Only call it when delivery to Telegram is itself the requested action.

## Select the destination

- Use `eligibleConnections` in request metadata to identify this coworker’s paired Telegram bot and destination. Each coworker has at most one active Telegram connection. Do not use another coworker’s connection.
- An explicit destination in the request or scheduled task instructions overrides the incoming channel. If it selects Discord, email, or another destination, do not use `telegram.send`.
- With no explicit destination, "send it to me", "send it here", and file delivery default to the current incoming channel identified by request metadata (`discord`, `telegram`, or `local`). Use this skill for that default only when the channel is `telegram`.
- A connected or paired integration indicates availability, not the intended destination. "On my phone" alone does not identify a provider.
- If the current request originated from Telegram, keep its `originatingIntegrationId`. Otherwise use this coworker’s eligible Telegram connection. If an originating connection is no longer available, report that instead of switching bots.
- For `local` (desktop or CLI), provide the local artifact using the current interface. If the destination is unspecified and no current channel supports the requested delivery, ask where to send it before calling a messaging tool. Missing or null channel metadata is not a reason to choose a paired provider.
- If delivery fails, report the failure and keep the selected destination. Do not switch providers unless the user explicitly chooses another destination.

## How to use it

1. Create any file you were asked to send first, in the workspace, using `files.write`, `documents.export`, or `invoice.create`.
2. Call `telegram.send` with:
   - `integrationId`: optional; supply the current coworker’s connection ID from request metadata when explicitly selected or originating there. Otherwise the app resolves the coworker’s sole paired connection.
   - `message`: short markdown text. Bold, italics, inline code, code blocks, links, and lists render in Telegram.
   - `attachments`: workspace-relative paths of the files to deliver (optional).
3. Check the tool result before claiming delivery. Only say the message was sent when the tool succeeded; on failure, report the actual error.

## Constraints

- Photos up to 10 MB send as pictures; every other file up to 50 MB sends as a document. Larger files fail — say so and offer an alternative.
- The message goes to the selected bot’s paired chat or mapped topic. You cannot message anyone else on Telegram.
- If the tool reports that Telegram is not connected or paired, tell the user to connect it in the coworker’s settings or Settings → Integrations and stop; do not retry.

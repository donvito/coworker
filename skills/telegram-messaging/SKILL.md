---
name: telegram-messaging
description: Send a message or deliver files to the user's Telegram through the connected Telegram bot. Use when the user asks to receive something on Telegram or on their phone, or asks to be messaged, reminded, or sent a file there. Do not use for ordinary conversation replies, which already reach Telegram automatically, or for sending email.
---

# Telegram messaging

Use the `telegram.send` tool to proactively deliver a message or files to the user's paired Telegram chat.

## When to use it

- The user asks to receive a file, report, or summary "on Telegram" or "on my phone".
- The user asks to be pinged or notified on Telegram when work finishes.
- A scheduled task's instructions say results should go to Telegram.

Do not call it for a normal reply in a conversation: the app already mirrors conversation replies to Telegram. Only call it when delivery to Telegram is itself the requested action.

## How to use it

1. Create any file you were asked to send first, in the workspace, using `files.write`, `documents.export`, or `invoice.create`.
2. Call `telegram.send` with:
   - `message`: short markdown text. Bold, italics, inline code, code blocks, links, and lists render in Telegram.
   - `attachments`: workspace-relative paths of the files to deliver (optional).
3. Check the tool result before claiming delivery. Only say the message was sent when the tool succeeded; on failure, report the actual error.

## Constraints

- Photos up to 10 MB send as pictures; every other file up to 50 MB sends as a document. Larger files fail — say so and offer an alternative.
- The message goes to the one chat the user paired. You cannot message anyone else on Telegram.
- If the tool reports that Telegram is not connected or paired, tell the user to connect it in Settings → Integrations and stop; do not retry.

---
name: discord-messaging
description: Send a message or deliver files to the user's Discord through the connected Discord bot. Use when the user asks to receive something on Discord, or asks to be messaged, reminded, or sent a file there. Do not use for ordinary conversation replies, which already reach Discord automatically, or for sending email or Telegram.
---

# Discord messaging

Use the `discord.send` tool to proactively deliver a message or files to the user's paired Discord channel or thread.

## When to use it

- The user asks to receive a file, report, or summary "on Discord".
- The user asks to be pinged or notified on Discord when work finishes.
- A scheduled task's instructions say results should go to Discord.

Do not call it for a normal reply in a conversation: the app already mirrors conversation replies to Discord. Only call it when delivery to Discord is itself the requested action.

## How to use it

1. Create any file you were asked to send first, in the workspace, using `files.write`, `documents.export`, or `invoice.create`.
2. Call `discord.send` with:
   - `message`: short markdown text. Bold, italics, inline code, code blocks, links, and lists render in Discord.
   - `attachments`: workspace-relative paths of the files to deliver (optional).
3. Check the tool result before claiming delivery. Only say the message was sent when the tool succeeded; on failure, report the actual error.

## Constraints

- Photos up to 10 MB and other files up to 25 MB send as attachments. Larger files fail — say so and offer an alternative.
- The message goes to the mapped Discord thread for this conversation, or the thread the user last wrote from. Parent-channel chatter is mention-only. You cannot message other servers or DMs.
- If the tool reports that Discord is not connected or paired, tell the user to connect it in Settings → Integrations and stop; do not retry.

---
name: folder-access
description: Find and read documents in the read-only folders the user granted this coworker on their computer. Use when the user references files, documents, reports, or folders on their machine that are not in the coworker workspace and not attached to the message. Do not use for files in the coworker workspace, for attachments, or when no shared folder is granted.
---

# Reading the user's shared folders

The user can grant this coworker read-only access to specific folders on their computer. Those grants are the only parts of their machine you can see.

## Workflow

1. Call `folders.list` with no arguments to see every granted folder and its alias.
2. Browse a folder with `folders.list` using its alias and a relative path (`.` is the folder root).
3. Read a file with `folders.read` using the alias and the file's relative path.
   - PDF, Word DOCX, and Excel XLSX documents return extracted text.
   - Text files (Markdown, CSV, JSON, source code, and similar) return their contents.
   - Other binary files return name, size, and type only; report that honestly instead of guessing contents.
4. Very large documents are truncated; the result says so. Mention the truncation when it matters to the answer.

## Rules

- Shared folders are strictly read-only. You cannot create, modify, or delete anything in them, and no tool will ever let you. Never claim to have edited a shared file.
- To work on a copy of a shared document, read it with `folders.read` and write the material you need into the workspace with `files.write`, then continue from the workspace copy.
- If the user names a file you cannot find, browse the likely folder with `folders.list` before concluding it does not exist, then tell them which granted folder you searched.
- If no granted folder plausibly contains what the user wants, say which folders you can access and ask them to grant the right folder in this coworker's settings.
- Cite the folder alias and relative path of every shared document you rely on so the user can find it themselves.

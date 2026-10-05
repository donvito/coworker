---
name: folder-access
description: Find, read, or save work files in folders the user explicitly granted, or help the user remove files through the Files explorer. Use for files outside the coworker workspace, a requested shared output folder, or file deletion. Do not use for message attachments or workspace-only operations other than file deletion.
---
# Granted folders

Call `folders.list` to see granted folders, their root IDs, and access modes; browse with its alias and relative path. Use `folders.read` for PDF, DOCX, XLSX, PPTX and text extraction. Report truncation or binary-only metadata honestly.

For deliverables, honor the user's explicit destination; otherwise inspect `files.roots` and use the default output root. Pass `root` to `files.write` or `documents.export`; use the root ID in `skills.run` file references. Writable grants allow creating or updating work files; read-only grants allow reading only. Never claim a write succeeded without a successful result. For an explicit edit read first and pass its revision; do not overwrite an unrelated file.

If access is missing, explain which folders are available and direct the user to this coworker's Folder access settings. Cite the folder alias and relative path for referenced files. Do not use grants to access internal app data.

## Removing files

For deletion, direct the user to Files in the coworker header. They can select files or folders and choose Delete, or use an item's Delete action, then confirm the listed paths in the app. Individually selected files move to Trash or Recycle Bin. Folders and all their contents are permanently deleted after a warning that they cannot be recovered. Deletion requires current write access. Workspace and granted-folder roots, symbolic-link selections, and managed memory files (including their containing folders) are protected. Do not use scripts or write tools to simulate deletion, and do not claim that items were removed unless the app reports success. Cancellation leaves the items untouched.

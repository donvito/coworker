---
name: file-archiving
description: Create a downloadable ZIP archive from selected files or folders in the coworker workspace or explicitly granted folders. Use for bundling deliverables, compressing files, or requesting an archive. Do not load for ordinary document creation, reading a single file, or extracting archives.
---
# Bundle files

Browse with files.list or folders.list to identify the requested sources. Use only the user's requested selection. Choose the output destination they specified, otherwise the default output root reported by files.roots, otherwise workspace.

Call skills.run with skill `file-archiving`, script `scripts/zip.js`, inputs as `{root, path}` references, destination `{root, path: "bundle.zip"}`, and options `{}`. Folder selections include their contents; source files are preserved. Symlinks and unreadable files are reported as errors. Correct the selection rather than silently omitting requested files.

The runtime returns actual output paths and registered artifacts. Link the returned archive only after success. Download is available on its artifact card and in Files. This skill does not extract archives.

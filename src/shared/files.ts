import { z } from "zod";
export const fileRefSchema = z.object({ root: z.string().min(1).max(128), path: z.string().min(1).max(2000) });
export type FileRef = z.infer<typeof fileRefSchema>;
export interface FileRoot { id: string; name: string; path: string; writable: boolean; defaultOutput: boolean }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory' | 'symlink'; size: number; modifiedAt: string }
export interface FilePreview { kind: 'text' | 'image' | 'binary'; name: string; content: string; truncated?: boolean }
export interface FileDeleteResult { deleted: FileRef[]; permanentlyDeleted: FileRef[]; trashed: FileRef[]; cancelled: boolean; errors: Array<{ ref: FileRef; message: string }> }
export interface FileDeleteConfirmation { token: string; paths: string[]; permanentFolders: string[] }
export const scriptRequestSchema = z.object({
  skill: z.string().min(1).max(128), script: z.string().regex(/^scripts\/[\w./-]+\.m?js$/),
  inputs: z.array(fileRefSchema).max(100), destination: fileRefSchema,
  options: z.record(z.string(), z.unknown()).default({}),
});
export type ScriptRequest = z.input<typeof scriptRequestSchema>;

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LibraryConfig } from "./config.js";

export const VIDEO_EXTENSIONS = new Set([
  ".3g2", ".3gp", ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4",
  ".mpeg", ".mpg", ".mts", ".ogv", ".ts", ".webm", ".wmv",
]);

export type MediaItem = {
  id: string;
  title: string;
  filename: string;
  library: string;
  folder: string;
  extension: string;
  size: number;
  isExtra: boolean;
  modifiedAt: string;
  path: string;
};

export type PublicMediaItem = Omit<MediaItem, "path">;

export function mediaId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}

export function titleFromFilename(filename: string): string {
  return path.basename(filename, path.extname(filename)).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

async function walk(
  directory: string,
  root: string,
  libraryName: string,
  extraThresholdBytes: number,
  output: MediaItem[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "EACCES" || cause.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith(".")) return;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath, root, libraryName, extraThresholdBytes, output);
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return;

    const details = await stat(fullPath);
    output.push({
      id: mediaId(fullPath),
      title: titleFromFilename(entry.name),
      filename: entry.name,
      library: libraryName,
      folder: path.relative(root, path.dirname(fullPath)),
      extension: path.extname(entry.name).slice(1).toUpperCase(),
      size: details.size,
      isExtra: details.size < extraThresholdBytes,
      modifiedAt: details.mtime.toISOString(),
      path: fullPath,
    });
  }));
}

export async function scanMedia(
  libraries: Array<LibraryConfig | string>,
  options: { extraThresholdBytes?: number } = {},
): Promise<MediaItem[]> {
  const output: MediaItem[] = [];
  const extraThresholdBytes = options.extraThresholdBytes ?? 800 * 1024 * 1024;
  for (const configuredLibrary of libraries) {
    const library = typeof configuredLibrary === "string"
      ? { name: path.basename(configuredLibrary), path: configuredLibrary }
      : configuredLibrary;
    const root = path.resolve(library.path);
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot access library "${library.name}" at ${root}: ${message}`, { cause: error });
    }
    await walk(root, root, library.name, extraThresholdBytes, output);
  }

  return output.sort((a, b) => Number(a.isExtra) - Number(b.isExtra)
    || a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export function publicMediaItem({ path: _path, ...publicFields }: MediaItem): PublicMediaItem {
  return publicFields;
}

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const VIDEO_EXTENSIONS = new Set([
  ".3g2",
  ".3gp",
  ".avi",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ogv",
  ".ts",
  ".webm",
  ".wmv",
]);

export function mediaId(filePath) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}

export function titleFromFilename(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function walk(directory, root, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "EACCES" || error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, root, output);
        return;
      }

      if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return;
      }

      const details = await stat(fullPath);
      output.push({
        id: mediaId(fullPath),
        title: titleFromFilename(entry.name),
        filename: entry.name,
        folder: path.relative(root, path.dirname(fullPath)) || path.basename(root),
        extension: path.extname(entry.name).slice(1).toUpperCase(),
        size: details.size,
        modifiedAt: details.mtime.toISOString(),
        path: fullPath,
      });
    }),
  );
}

export async function scanMedia(directories) {
  const output = [];
  for (const directory of directories) {
    await walk(path.resolve(directory), path.resolve(directory), output);
  }

  return output.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export function publicMediaItem(item) {
  const { path: _privatePath, ...publicFields } = item;
  return publicFields;
}

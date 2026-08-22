import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mediaId, scanMedia, titleFromFilename } from "../lib/media-library.js";

test("titleFromFilename creates readable titles", () => {
  assert.equal(titleFromFilename("The.Matrix.1999.mkv"), "The Matrix 1999");
  assert.equal(titleFromFilename("my_movie.mp4"), "my movie");
});

test("mediaId is stable and path-specific", () => {
  assert.equal(mediaId("/movies/a.mp4"), mediaId("/movies/a.mp4"));
  assert.notEqual(mediaId("/movies/a.mp4"), mediaId("/movies/b.mp4"));
});

test("scanMedia recursively finds supported videos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tailscreen-test-"));
  await mkdir(path.join(root, "Sci Fi"));
  await writeFile(path.join(root, "Sci Fi", "Arrival.mkv"), "video");
  await writeFile(path.join(root, "notes.txt"), "not media");

  const items = await scanMedia([root]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Arrival");
  assert.equal(items[0].folder, "Sci Fi");
  assert.equal(items[0].extension, "MKV");
});

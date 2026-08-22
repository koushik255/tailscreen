import assert from "node:assert/strict";
import test from "node:test";
import { getLaunchSpec, launchMedia } from "../lib/launcher.js";

test("uses the native macOS launcher by default", () => {
  assert.deepEqual(getLaunchSpec("/Movies/Test.mp4", {}, "darwin"), {
    command: "open",
    args: ["/Movies/Test.mp4"],
  });
});

test("substitutes file paths without invoking a shell", () => {
  assert.deepEqual(
    getLaunchSpec("/Movies/One & Two.mkv", {
      PLAYER_COMMAND: "vlc",
      PLAYER_ARGS_JSON: '["--fullscreen","{file}"]',
    }),
    { command: "vlc", args: ["--fullscreen", "/Movies/One & Two.mkv"] },
  );
});

test("reports an unavailable player without crashing the process", async () => {
  await assert.rejects(
    launchMedia("/Movies/Test.mp4", {
      env: { PLAYER_COMMAND: "definitely-not-a-real-tailscreen-player" },
      platform: "linux",
    }),
    { code: "ENOENT" },
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { clipMediaPath, clipServiceUrl } from "../lib/clips.js";

test("creates a Downloads-relative movie path", () => {
  assert.equal(
    clipMediaPath("/home/koushik/Downloads/Movies/Alien/Alien.mkv", "/home/koushik/Downloads"),
    "Movies/Alien/Alien.mkv",
  );
});

test("rejects movies outside the clipping media root", () => {
  assert.throws(
    () => clipMediaPath("/srv/media/Alien.mkv", "/home/koushik/Downloads"),
    /outside the clipping media root/,
  );
});

test("keeps status requests on the configured clip service", () => {
  const base = new URL("http://100.98.83.82:8765");
  assert.equal(
    clipServiceUrl(base, "http://localhost:8765/api/clips/123?detail=1").href,
    "http://100.98.83.82:8765/api/clips/123?detail=1",
  );
});

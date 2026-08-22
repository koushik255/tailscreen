import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../lib/config.js";

test("normalizes named media libraries", () => {
  const config = normalizeConfig({
    libraries: [
      { name: "Movies", path: "/srv/media/Movies" },
      { name: "TV Shows", path: "/srv/media/TV Shows" },
    ],
  });

  assert.deepEqual(config.libraries, [
    { name: "Movies", path: "/srv/media/Movies" },
    { name: "TV Shows", path: "/srv/media/TV Shows" },
  ]);
});

test("rejects relative library paths", () => {
  assert.throws(
    () => normalizeConfig({ libraries: [{ name: "Movies", path: "./Movies" }] }),
    /absolute path/,
  );
});

test("environment variables can override config values", () => {
  const config = normalizeConfig(
    { port: 8787, libraries: [] },
    { PORT: "9000", MEDIA_DIRS: "/media/one:/media/two" },
  );
  assert.equal(config.port, 9000);
  assert.deepEqual(config.libraries.map((library) => library.path), ["/media/one", "/media/two"]);
});

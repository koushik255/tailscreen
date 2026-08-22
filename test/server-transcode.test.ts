import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TRANSCODE_WINDOW_SECONDS, parseTranscodeWindow } from "../lib/server-transcode.js";

test("parses a bounded server transcode window", () => {
  assert.deepEqual(parseTranscodeWindow("725.5", "120"), { start: 725.5, duration: 120 });
});

test("rejects invalid server transcode windows", () => {
  assert.throws(() => parseTranscodeWindow("-1", "120"), /start must be zero or greater/);
  assert.throws(
    () => parseTranscodeWindow("0", String(MAX_TRANSCODE_WINDOW_SECONDS + 1)),
    /duration must be between/,
  );
});

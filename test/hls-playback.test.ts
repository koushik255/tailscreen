import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ffmpegHlsArguments, isHdrTransfer, isHlsFileName, parsePlaybackStart } from "../lib/hls-playback.js";

test("parses a playback start position", () => {
  assert.equal(parsePlaybackStart("725.5"), 725.5);
  assert.throws(() => parsePlaybackStart("-1"), /zero or greater/);
  assert.throws(() => parsePlaybackStart("later"), /zero or greater/);
});

test("builds a bounded rolling HLS stream with iPad codecs", () => {
  const directory = path.join("tmp", "session");
  const args = ffmpegHlsArguments("movie.mkv", directory, 90);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), ["-ss", "90"]);
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "libx264"]);
  assert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "aac"]);
  assert.deepEqual(args.slice(args.indexOf("-readrate"), args.indexOf("-readrate") + 2), ["-readrate", "1.05"]);
  assert.deepEqual(args.slice(args.indexOf("-hls_list_size"), args.indexOf("-hls_list_size") + 2), ["-hls_list_size", "12"]);
  assert.equal(args.at(-1), path.join(directory, "index.m3u8"));
});

test("tone maps HDR transfers to BT.709", () => {
  assert.equal(isHdrTransfer("smpte2084\n"), true);
  assert.equal(isHdrTransfer("arib-std-b67"), true);
  assert.equal(isHdrTransfer("bt709"), false);
  const args = ffmpegHlsArguments("hdr.mkv", "session", 0, true);
  assert.match(args[args.indexOf("-vf") + 1]!, /tonemap=hable/);
  assert.deepEqual(args.slice(args.indexOf("-color_trc"), args.indexOf("-color_trc") + 2), ["-color_trc", "bt709"]);
});

test("only permits generated HLS file names", () => {
  assert.equal(isHlsFileName("index.m3u8"), true);
  assert.equal(isHlsFileName("init.mp4"), true);
  assert.equal(isHlsFileName("segment-000001.m4s"), true);
  assert.equal(isHlsFileName("../config.json"), false);
  assert.equal(isHlsFileName("segment-1.m4s"), false);
});

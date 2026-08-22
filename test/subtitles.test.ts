import assert from "node:assert/strict";
import test from "node:test";
import { parseAss, parseSrt } from "../web/subtitles.js";

test("parses SRT timestamps and multiline captions", () => {
  const cues = parseSrt(`1
00:00:01,250 --> 00:00:03,500
First line
Second line

2
00:01:00,000 --> 00:01:02,000
Later`);

  assert.deepEqual(cues, [
    { start: 1.25, end: 3.5, text: "First line\nSecond line" },
    { start: 60, end: 62, text: "Later" },
  ]);
});

test("parses ASS event fields without losing commas in dialogue", () => {
  const cues = parseAss(`[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\i1}Hello, there{\\i0}\\NSecond line`);

  assert.deepEqual(cues, [{
    start: 2,
    end: 4.5,
    text: "{\\i1}Hello, there{\\i0}\\NSecond line",
  }]);
});

import { registerMediabunnyServer } from "@mediabunny/server";
import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  Conversion,
  FilePathSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";

registerMediabunnyServer();

export const MAX_TRANSCODE_WINDOW_SECONDS = 180;

export type TranscodeWindow = { start: number; duration: number };

export function parseTranscodeWindow(startValue: unknown, durationValue: unknown): TranscodeWindow {
  const start = Number(startValue);
  const duration = Number(durationValue);
  if (!Number.isFinite(start) || start < 0) throw new Error("start must be zero or greater");
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_TRANSCODE_WINDOW_SECONDS) {
    throw new Error(`duration must be between 1 and ${MAX_TRANSCODE_WINDOW_SECONDS} seconds`);
  }
  return { start, duration };
}

export async function createCompatibleWindow(
  filePath: string,
  target: WritableStream<Uint8Array>,
  window: TranscodeWindow,
) {
  const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
    target: new AppendOnlyStreamTarget(target),
  });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      trim: { start: window.start, end: window.start + window.duration },
      video: async (track) => ({
        codec: "avc",
        height: Math.min(await track.getDisplayHeight(), 1080),
        quality: new Quality("medium"),
        keyFrameInterval: 2,
        forceTranscode: true,
      }),
      audio: { codec: "aac", numberOfChannels: 2, quality: new Quality("medium"), forceTranscode: true },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("This file has no tracks that can be converted for Safari.");

    return {
      mimeType: "video/mp4",
      execute: () => conversion.execute(),
      cancel: () => conversion.cancel(),
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

import { createReadStream } from "node:fs";
import { SubtitleParser } from "matroska-subtitles";

export type EmbeddedSubtitleTrack = {
  number: number;
  language?: string;
  type: string;
  name?: string;
};

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

type ParserTrack = EmbeddedSubtitleTrack & { header?: string };
type ParserCue = { text: string; time: number; duration: number };

export function listEmbeddedSubtitleTracks(filePath: string): Promise<EmbeddedSubtitleTrack[]> {
  return new Promise((resolve, reject) => {
    const source = createReadStream(filePath);
    const parser = new SubtitleParser();
    const stop = () => {
      source.destroy();
      parser.destroy();
    };

    parser.once("tracks", (tracks: ParserTrack[]) => {
      resolve(tracks.map(({ number, language, type, name }) => ({ number, language, type, name })));
      stop();
    });
    parser.once("error", reject);
    source.once("error", reject);
    source.pipe(parser);
  });
}

export function extractEmbeddedSubtitleTrack(
  filePath: string,
  trackNumber: number,
  onCue: (cue: SubtitleCue) => void,
): { done: Promise<void>; cancel: () => void } {
  const source = createReadStream(filePath);
  const parser = new SubtitleParser();
  let canceled = false;
  const cancel = () => {
    canceled = true;
    source.destroy();
    parser.destroy();
  };

  const done = new Promise<void>((resolve, reject) => {
    parser.on("subtitle", (subtitle: ParserCue, number: number) => {
      if (number !== trackNumber || canceled) return;
      const start = subtitle.time / 1000;
      const duration = Number.isFinite(subtitle.duration) ? subtitle.duration / 1000 : 4;
      onCue({ start, end: start + Math.max(duration, 0.1), text: subtitle.text });
    });
    parser.once("finish", resolve);
    parser.once("close", () => { if (canceled) resolve(); });
    parser.once("error", reject);
    source.once("error", reject);
    source.pipe(parser);
  });

  return { done, cancel };
}

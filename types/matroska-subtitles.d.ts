declare module "matroska-subtitles" {
  import { Transform } from "node:stream";
  export class SubtitleParser extends Transform {}
}

export type SubtitleCue = { start: number; end: number; text: string };
type EmbeddedTrack = { number: number; language?: string; type: string; name?: string };

export class SubtitleController {
  private cues: SubtitleCue[] = [];
  private activeKey = "";
  private currentTime = 0;
  private request: AbortController | null = null;

  constructor(
    private readonly overlay: HTMLElement,
    private readonly button: HTMLButtonElement,
  ) {}

  clear(): void {
    this.request?.abort();
    this.request = null;
    this.cues = [];
    this.activeKey = "";
    this.currentTime = 0;
    this.overlay.replaceChildren();
    this.button.textContent = "Add subtitles";
    this.button.title = "Choose an SRT or ASS subtitle file";
  }

  async loadEmbedded(mediaId: string): Promise<void> {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    try {
      const response = await fetch(`/api/media/${mediaId}/subtitles`, { signal: request.signal });
      if (!response.ok) return;
      const { tracks } = await response.json() as { tracks: EmbeddedTrack[] };
      const track = preferredTrack(tracks);
      if (!track || request.signal.aborted) return;

      const label = track.name || track.language?.toUpperCase() || "Embedded";
      this.button.textContent = `Subtitles: ${label}`;
      this.button.title = "Embedded subtitles loaded. Click to choose a different file.";
      await this.readEmbeddedCues(mediaId, track.number, request.signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.warn("Could not load subtitles", error);
    }
  }

  async loadFile(file: File): Promise<void> {
    this.request?.abort();
    this.request = null;
    const text = await file.text();
    const extension = file.name.split(".").pop()?.toLowerCase();
    this.setCues(extension === "ass" || extension === "ssa" ? parseAss(text) : parseSrt(text));
    this.button.textContent = `Subtitles: ${file.name}`;
    this.button.title = "Local subtitle file loaded. Click to choose a different file.";
  }

  update(time: number): void {
    this.currentTime = time;
    const upper = upperBound(this.cues, time);
    const active = this.cues.slice(Math.max(0, upper - 20), upper)
      .filter((cue) => cue.start <= time && cue.end > time);
    const key = active.map((cue) => `${cue.start}:${cue.end}:${cue.text}`).join("|");
    if (key === this.activeKey) return;
    this.activeKey = key;
    this.overlay.replaceChildren(...active.map((cue) => {
      const line = document.createElement("div");
      const text = document.createElement("span");
      text.textContent = cleanSubtitleText(cue.text);
      line.append(text);
      return line;
    }));
  }

  private setCues(cues: SubtitleCue[]): void {
    this.cues = cues.sort((a, b) => a.start - b.start);
    this.activeKey = "";
    this.update(this.currentTime);
  }

  private async readEmbeddedCues(mediaId: string, trackNumber: number, signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api/media/${mediaId}/subtitles/${trackNumber}`, { signal });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = "";
    while (true) {
      const { done, value } = await reader.read();
      remainder += decoder.decode(value, { stream: !done });
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.cues.push(JSON.parse(line) as SubtitleCue);
      }
      this.update(this.currentTime);
      if (done) break;
    }
    if (remainder.trim()) this.cues.push(JSON.parse(remainder) as SubtitleCue);
    this.cues.sort((a, b) => a.start - b.start);
    this.update(this.currentTime);
  }
}

export function parseSrt(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of source.replace(/\r/g, "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timeLine = lines.findIndex((line) => line.includes("-->"));
    if (timeLine < 0) continue;
    const [startText, endText] = lines[timeLine]!.split("-->");
    const start = parseTimestamp(startText ?? "");
    const end = parseTimestamp((endText ?? "").trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push({ start, end, text: lines.slice(timeLine + 1).join("\n") });
  }
  return cues;
}

export function parseAss(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  for (const rawLine of source.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) inEvents = line.toLowerCase() === "[events]";
    else if (inEvents && /^format:/i.test(line)) {
      fields = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim().toLowerCase());
    } else if (inEvents && /^dialogue:/i.test(line)) {
      const values = splitFields(line.slice(line.indexOf(":") + 1).trim(), fields.length);
      const start = parseTimestamp(values[fields.indexOf("start")] ?? "");
      const end = parseTimestamp(values[fields.indexOf("end")] ?? "");
      const text = values[fields.indexOf("text")] ?? "";
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ start, end, text });
    }
  }
  return cues;
}

function preferredTrack(tracks: EmbeddedTrack[]): EmbeddedTrack | undefined {
  return tracks.find((track) => /^(eng|en)$/i.test(track.language ?? "") || /english/i.test(track.name ?? ""))
    ?? tracks[0];
}

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":");
  if (parts.length !== 3) return Number.NaN;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

function splitFields(value: string, count: number): string[] {
  const fields: string[] = [];
  let rest = value;
  for (let index = 1; index < count; index++) {
    const comma = rest.indexOf(",");
    if (comma < 0) break;
    fields.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  fields.push(rest);
  return fields;
}

function cleanSubtitleText(value: string): string {
  return value.replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "")
    .replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
}

function upperBound(cues: SubtitleCue[], time: number): number {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle]!.start <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

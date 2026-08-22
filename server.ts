import express, { type ErrorRequestHandler } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { type MediaItem, publicMediaItem, scanMedia } from "./lib/media-library.js";
import {
  extractEmbeddedSubtitleTrack,
  type EmbeddedSubtitleTrack,
  listEmbeddedSubtitleTracks,
  type SubtitleCue,
} from "./lib/subtitles.js";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const config = await loadConfig({ cwd: appDirectory });
let media: MediaItem[] = [];
let mediaById = new Map<string, MediaItem>();
let lastScannedAt: string | null = null;
let scanInFlight: Promise<MediaItem[]> | null = null;
const subtitleTracks = new Map<string, Promise<EmbeddedSubtitleTrack[]>>();
const subtitleCues = new Map<string, SubtitleCue[]>();

async function refreshLibrary(): Promise<MediaItem[]> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = scanMedia(config.libraries, {
    extraThresholdBytes: config.extraThresholdMb * 1024 * 1024,
  }).then((items) => {
    media = items;
    mediaById = new Map(items.map((item) => [item.id, item]));
    lastScannedAt = new Date().toISOString();
    return items;
  }).finally(() => { scanInFlight = null; });
  return scanInFlight;
}

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    mediaCount: media.length,
    libraries: config.libraries.map((library) => library.name),
    lastScannedAt,
  });
});

app.get("/api/media", async (_request, response, next) => {
  try {
    const items = await refreshLibrary();
    response.json({ items: items.map(publicMediaItem), lastScannedAt });
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id/stream", async (request, response, next) => {
  try {
    const item = mediaById.get(request.params.id);
    if (!item) return response.status(404).json({ error: "Media item not found" });

    const details = await stat(item.path);
    const range = request.headers.range;
    response.setHeader("Accept-Ranges", "bytes");
    response.type(item.extension.toLowerCase());
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.filename)}`);

    if (!range) {
      response.setHeader("Content-Length", details.size);
      return createReadStream(item.path).pipe(response);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return response.status(416).setHeader("Content-Range", `bytes */${details.size}`).end();

    let start = match[1] ? Number.parseInt(match[1], 10) : 0;
    let end = match[2] ? Number.parseInt(match[2], 10) : details.size - 1;
    if (!match[1] && match[2]) {
      start = Math.max(details.size - Number.parseInt(match[2], 10), 0);
      end = details.size - 1;
    }
    if (start > end || start >= details.size) {
      return response.status(416).setHeader("Content-Range", `bytes */${details.size}`).end();
    }
    end = Math.min(end, details.size - 1);

    response.status(206);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${details.size}`);
    response.setHeader("Content-Length", end - start + 1);
    return createReadStream(item.path, { start, end }).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id/subtitles", async (request, response, next) => {
  try {
    const item = mediaById.get(request.params.id);
    if (!item) return response.status(404).json({ error: "Media item not found" });
    if (item.extension !== "MKV") return response.json({ tracks: [] });

    const key = `${item.id}:${item.modifiedAt}`;
    let pending = subtitleTracks.get(key);
    if (!pending) {
      pending = listEmbeddedSubtitleTracks(item.path);
      subtitleTracks.set(key, pending);
    }
    response.json({ tracks: await pending });
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id/subtitles/:trackNumber", async (request, response, next) => {
  try {
    const item = mediaById.get(request.params.id);
    if (!item) return response.status(404).json({ error: "Media item not found" });
    const trackNumber = Number.parseInt(request.params.trackNumber, 10);
    if (!Number.isInteger(trackNumber)) return response.status(400).json({ error: "Invalid subtitle track" });

    const trackKey = `${item.id}:${item.modifiedAt}:${trackNumber}`;
    response.type("application/x-ndjson");
    response.setHeader("Cache-Control", "private, max-age=3600");
    const cached = subtitleCues.get(trackKey);
    if (cached) {
      for (const cue of cached) response.write(`${JSON.stringify(cue)}\n`);
      return response.end();
    }

    const cues: SubtitleCue[] = [];
    const extraction = extractEmbeddedSubtitleTrack(item.path, trackNumber, (cue) => {
      cues.push(cue);
      response.write(`${JSON.stringify(cue)}\n`);
    });
    response.on("close", () => {
      if (!response.writableEnded) extraction.cancel();
    });
    await extraction.done;
    subtitleCues.set(trackKey, cues);
    response.end();
  } catch (error) {
    if (response.headersSent) response.end();
    else next(error);
  }
});

app.use(express.static(path.join(appDirectory, "public"), {
  extensions: ["html"],
  maxAge: 0,
  setHeaders(response, filePath) {
    if (filePath.endsWith("service-worker.js")) response.setHeader("Cache-Control", "no-cache");
  },
}));

app.get("*path", (_request, response) => response.sendFile(path.join(appDirectory, "public", "index.html")));

const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
};
app.use(handleError);

export function startServer() {
  if (!config.libraries.length) {
    console.warn(`No libraries configured. Copy config.example.json to ${config.configPath} and add media paths.`);
  }

  refreshLibrary().catch((error) => console.error("Initial media scan failed:", error));
  const timer = setInterval(() => {
    refreshLibrary().catch((error) => console.error("Media scan failed:", error));
  }, config.scanIntervalMs);
  timer.unref();

  return app.listen(config.port, "0.0.0.0", () => {
    console.log(`TailScreen is listening on http://0.0.0.0:${config.port}`);
    console.log(`Using configuration: ${config.configPath}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();

export { app, refreshLibrary };

import express, { type ErrorRequestHandler } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { clipMediaPath, clipServiceUrl } from "./lib/clips.js";
import { loadConfig } from "./lib/config.js";
import { HlsPlaybackManager, parsePlaybackStart } from "./lib/hls-playback.js";
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
const clipApiBase = new URL(process.env.CLIP_API_URL || "http://100.98.83.82:8765");
const clipMediaRoot = path.resolve(process.env.CLIP_MEDIA_ROOT || "/home/koushik/Downloads");
const hlsPlayback = new HlsPlaybackManager();

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
app.use(express.json({ limit: "4kb" }));

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

app.post("/api/media/:id/playback", async (request, response, next) => {
  const item = mediaById.get(request.params.id);
  if (!item) return response.status(404).json({ error: "Media item not found" });

  let start;
  try {
    start = parsePlaybackStart(request.body?.start);
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }

  try {
    const session = await hlsPlayback.create(item.id, item.path, start);
    response.status(202).json({
      ...session,
      statusUrl: `/api/playback/${session.id}`,
      playlistUrl: `/api/playback/${session.id}/index.m3u8`,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/playback/:sessionId", async (request, response, next) => {
  try {
    const session = await hlsPlayback.get(request.params.sessionId);
    if (!session) return response.status(404).json({ error: "Playback session not found" });
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ...session,
      playlistUrl: `/api/playback/${session.id}/index.m3u8`,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/playback/:sessionId/:action", (request, response) => {
  const action = request.params.action;
  if (action !== "pause" && action !== "resume") return response.status(404).json({ error: "Unknown playback action" });
  if (!hlsPlayback.setPaused(request.params.sessionId, action === "pause")) {
    return response.status(404).json({ error: "Playback session is no longer running" });
  }
  response.status(204).end();
});

app.delete("/api/playback/:sessionId", (request, response) => {
  hlsPlayback.remove(request.params.sessionId);
  response.status(204).end();
});

app.get("/api/playback/:sessionId/:fileName", async (request, response, next) => {
  try {
    const filePath = await hlsPlayback.file(request.params.sessionId, request.params.fileName);
    if (!filePath) return response.status(404).end();
    if (request.params.fileName.endsWith(".m3u8")) {
      response.type("application/vnd.apple.mpegurl");
      response.setHeader("Cache-Control", "no-store");
    } else {
      response.type("video/mp4");
      response.setHeader("Cache-Control", "private, max-age=300");
    }
    response.sendFile(filePath);
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

app.post("/api/media/:id/clips", async (request, response, next) => {
  try {
    const item = mediaById.get(request.params.id);
    if (!item) return response.status(404).json({ error: "Media item not found" });

    const end = Number(request.body?.end);
    const duration = Number(request.body?.duration);
    if (!Number.isFinite(end) || end < 0) return response.status(400).json({ error: "end must be zero or greater" });
    if (!Number.isFinite(duration) || duration < 1 || duration > 60) {
      return response.status(400).json({ error: "duration must be between 1 and 60 seconds" });
    }

    const upstream = await fetch(new URL("/api/clips", clipApiBase), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: clipMediaPath(item.path, clipMediaRoot), end, duration }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
    if (!upstream.ok) return response.status(upstream.status).json(payload);
    if (typeof payload.status_url !== "string") {
      return response.status(502).json({ error: "Clip service did not return a status_url" });
    }

    const statusTarget = clipServiceUrl(clipApiBase, payload.status_url);
    response.status(upstream.status).json({
      ...payload,
      status_url: `/api/clips/status?path=${encodeURIComponent(statusTarget.pathname + statusTarget.search)}`,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/clips/status", async (request, response, next) => {
  try {
    if (typeof request.query.path !== "string") return response.status(400).json({ error: "Missing clip status path" });
    const upstream = await fetch(clipServiceUrl(clipApiBase, request.query.path), {
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof payload.clip_url === "string") {
      payload.clip_url = clipServiceUrl(clipApiBase, payload.clip_url).href;
    }
    response.status(upstream.status).json(payload);
  } catch (error) {
    next(error);
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

  return app.listen(config.port, "0.0.0.0", (error?: Error) => {
    if (error) {
      console.error(`TailScreen could not listen on port ${config.port}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`TailScreen is listening on http://0.0.0.0:${config.port}`);
    console.log(`Using configuration: ${config.configPath}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();

export { app, refreshLibrary };

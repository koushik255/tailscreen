import express from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { launchMedia } from "./lib/launcher.js";
import { publicMediaItem, scanMedia } from "./lib/media-library.js";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const config = await loadConfig({ cwd: appDirectory });
const playerEnvironment = config.player
  ? {
      ...process.env,
      PLAYER_COMMAND: config.player.command,
      PLAYER_ARGS_JSON: JSON.stringify(config.player.args),
    }
  : process.env;

let media = [];
let mediaById = new Map();
let lastScannedAt = null;
let scanInFlight = null;

async function refreshLibrary() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = scanMedia(config.libraries, {
    extraThresholdBytes: config.extraThresholdMb * 1024 * 1024,
  })
    .then((items) => {
      media = items;
      mediaById = new Map(items.map((item) => [item.id, item]));
      lastScannedAt = new Date().toISOString();
      return items;
    })
    .finally(() => {
      scanInFlight = null;
    });
  return scanInFlight;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((request, response, next) => {
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
    if (!lastScannedAt) await refreshLibrary();
    response.json({
      items: media.map(publicMediaItem),
      lastScannedAt,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scan", async (_request, response, next) => {
  try {
    const items = await refreshLibrary();
    response.json({ count: items.length, lastScannedAt });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/:id/launch", async (request, response, next) => {
  try {
    const item = mediaById.get(request.params.id);
    if (!item) return response.status(404).json({ error: "Media item not found" });

    await stat(item.path);
    await launchMedia(item.path, { env: playerEnvironment });
    response.status(202).json({ ok: true, title: item.title });
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
      const suffixLength = Number.parseInt(match[2], 10);
      start = Math.max(details.size - suffixLength, 0);
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

app.use(express.static(path.join(appDirectory, "public"), {
  extensions: ["html"],
  maxAge: 0,
  setHeaders(response, filePath) {
    if (filePath.endsWith("service-worker.js")) response.setHeader("Cache-Control", "no-cache");
  },
}));

app.get("*path", (_request, response) => {
  response.sendFile(path.join(appDirectory, "public", "index.html"));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || "Unexpected server error" });
});

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}

export { app, refreshLibrary };

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PLAYLIST_NAME = "index.m3u8";
const SESSION_MAX_IDLE_MS = 30 * 60 * 1000;

export type HlsSessionState = "starting" | "ready" | "complete" | "failed";

export type PublicHlsSession = {
  id: string;
  mediaId: string;
  start: number;
  hdr: boolean;
  state: HlsSessionState;
  error?: string;
};

type HlsSession = PublicHlsSession & {
  directory: string;
  process: ChildProcess;
  lastAccessedAt: number;
  stderr: string;
  paused: boolean;
};

export function parsePlaybackStart(value: unknown): number {
  const start = Number(value);
  if (!Number.isFinite(start) || start < 0) throw new Error("start must be zero or greater");
  return start;
}

export function isHdrTransfer(value: string): boolean {
  return value.split(/\s+/).some((transfer) => transfer === "smpte2084" || transfer === "arib-std-b67");
}

export function ffmpegHlsArguments(
  inputPath: string,
  outputDirectory: string,
  start: number,
  hdr = false,
): string[] {
  const scale = "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const videoFilter = hdr
    ? `${scale},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
    : `${scale},format=yuv420p`;
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostdin",
    "-re",
    "-ss", String(start),
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-sn",
    "-dn",
    "-vf", videoFilter,
    ...(hdr ? ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-maxrate", "6M",
    "-bufsize", "12M",
    "-profile:v", "high",
    "-level:v", "4.1",
    "-g", "48",
    "-keyint_min", "48",
    "-sc_threshold", "0",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ac", "2",
    "-ar", "48000",
    "-avoid_negative_ts", "make_zero",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "12",
    "-hls_delete_threshold", "4",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(outputDirectory, "segment-%06d.m4s"),
    "-hls_flags", "delete_segments+independent_segments+temp_file",
    path.join(outputDirectory, PLAYLIST_NAME),
  ];
}

export function isHlsFileName(fileName: string): boolean {
  return fileName === PLAYLIST_NAME
    || fileName === "init.mp4"
    || /^segment-\d{6}\.m4s$/.test(fileName);
}

export class HlsPlaybackManager {
  private readonly sessions = new Map<string, HlsSession>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly rootDirectory = path.join(os.tmpdir(), "tailscreen-hls"),
    private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  ) {
    this.cleanupTimer = setInterval(() => this.removeIdleSessions(), 60_000);
    this.cleanupTimer.unref();
  }

  async create(mediaId: string, inputPath: string, start: number): Promise<PublicHlsSession> {
    await mkdir(this.rootDirectory, { recursive: true });
    const hdr = await detectHdrVideo(inputPath, this.ffprobePath);
    const id = randomUUID();
    const directory = await mkdtemp(path.join(this.rootDirectory, `${id}-`));
    const child = spawn(this.ffmpegPath, ffmpegHlsArguments(inputPath, directory, start, hdr), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const session: HlsSession = {
      id,
      mediaId,
      start,
      hdr,
      state: "starting",
      directory,
      process: child,
      lastAccessedAt: Date.now(),
      stderr: "",
      paused: false,
    };
    this.sessions.set(id, session);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      session.stderr = `${session.stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", (error) => {
      session.state = "failed";
      session.error = error.message;
    });
    child.once("exit", (code, signal) => {
      if (session.state === "failed") return;
      if (code === 0) session.state = "complete";
      else if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        session.state = "failed";
        session.error = lastFfmpegMessage(session.stderr) || `FFmpeg stopped with code ${code ?? "unknown"}.`;
      }
    });
    return publicSession(session);
  }

  async get(id: string): Promise<PublicHlsSession | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.touch(session);
    if (session.state === "starting" && await this.playlistExists(session)) session.state = "ready";
    return publicSession(session);
  }

  async file(id: string, fileName: string): Promise<string | undefined> {
    const session = this.sessions.get(id);
    if (!session || !isHlsFileName(fileName)) return undefined;
    this.touch(session);
    const filePath = path.join(session.directory, fileName);
    return await stat(filePath).then((details) => details.isFile() ? filePath : undefined).catch(() => undefined);
  }

  setPaused(id: string, paused: boolean): boolean {
    const session = this.sessions.get(id);
    if (!session || session.process.exitCode !== null) return false;
    this.touch(session);
    if (session.paused === paused) return true;
    session.process.kill(paused ? "SIGSTOP" : "SIGCONT");
    session.paused = paused;
    return true;
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    if (session.process.exitCode === null) {
      if (session.paused) session.process.kill("SIGCONT");
      session.process.kill("SIGTERM");
    }
    setTimeout(() => {
      if (session.process.exitCode === null) session.process.kill("SIGKILL");
      void rm(session.directory, { recursive: true, force: true });
    }, 5_000).unref();
    return true;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const id of this.sessions.keys()) this.remove(id);
  }

  private touch(session: HlsSession): void {
    session.lastAccessedAt = Date.now();
  }

  private async playlistExists(session: HlsSession): Promise<boolean> {
    try {
      const playlist = await readFile(path.join(session.directory, PLAYLIST_NAME), "utf8");
      return playlist.includes("#EXTINF:");
    } catch {
      return false;
    }
  }

  private removeIdleSessions(): void {
    const cutoff = Date.now() - SESSION_MAX_IDLE_MS;
    for (const session of this.sessions.values()) {
      if (session.lastAccessedAt < cutoff) this.remove(session.id);
    }
  }
}

function publicSession(session: HlsSession): PublicHlsSession {
  return {
    id: session.id,
    mediaId: session.mediaId,
    start: session.start,
    hdr: session.hdr,
    state: session.state,
    ...(session.error ? { error: session.error } : {}),
  };
}

function lastFfmpegMessage(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => line !== "Conversion failed!");
  return (useful.length ? useful : lines).slice(-3).join(" ") || undefined;
}

function detectHdrVideo(filePath: string, ffprobePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=color_transfer",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      resolve(!error && isHdrTransfer(stdout));
    });
  });
}

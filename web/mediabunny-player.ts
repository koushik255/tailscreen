import { registerAc3Decoder } from "@mediabunny/ac3";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import { registerDtsDecoder } from "@mediabunny/dts";
import { registerProresDecoder } from "@mediabunny/prores";
import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  Input,
  UrlSource,
  type InputTrack,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from "mediabunny";

registerAc3Decoder();
registerAacEncoder();
registerDtsDecoder();
registerProresDecoder();

export class UnsupportedVideoError extends Error {
  constructor(readonly codec: string | null, readonly duration: number) {
    super(`The browser cannot decode the ${codec ?? "unknown"} video track.`);
  }
}

export async function canPlayNatively(url: string, video: HTMLVideoElement): Promise<boolean> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    return video.canPlayType(await input.getMimeType()) !== "";
  } finally {
    input.dispose();
  }
}

type PlayerEvents = {
  onError: (message: string) => void;
  onPlayingChange: (playing: boolean) => void;
  onTimeChange: (current: number, duration: number) => void;
};

export class CompatibilityPlayer {
  private input: Input | null = null;
  private videoSink: CanvasSink | null = null;
  private audioSink: AudioBufferSink | null = null;
  private videoFrames: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private audioBuffers: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private audioContext: AudioContext | null = null;
  private gain: GainNode | null = null;
  private queuedAudio = new Set<AudioBufferSourceNode>();
  private current = 0;
  private start = 0;
  private duration = 0;
  private clockStart = 0;
  private playing = false;
  private loadId = 0;
  private videoRunId = 0;
  private audioRunId = 0;
  private animationFrame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: PlayerEvents,
  ) {}

  get isPlaying(): boolean { return this.playing; }

  async load(url: string): Promise<void> {
    this.destroy();
    const loadId = ++this.loadId;
    this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    let videoTrack = await this.input.getPrimaryVideoTrack();
    let audioTrack = await this.input.getPrimaryAudioTrack();
    const tracks: InputTrack[] = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);
    if (!tracks.length) throw new Error("No audio or video track was found.");

    this.start = Math.max(await this.input.getFirstTimestamp(tracks), 0);
    this.duration = await this.input.getDurationFromMetadata(tracks, { skipLiveWait: true })
      ?? await this.input.computeDuration(tracks, { skipLiveWait: true });
    this.current = this.start;

    const videoCodec = await videoTrack?.getCodec() ?? null;
    if (videoTrack && (videoCodec === "hevc" || !videoCodec || !(await videoTrack.canDecode()))) {
      this.destroy();
      throw new UnsupportedVideoError(videoCodec, this.duration);
    }
    if (audioTrack && (!(await audioTrack.getCodec()) || !(await audioTrack.canDecode()))) audioTrack = null;
    if (!videoTrack && !audioTrack) throw new Error("This browser cannot decode this file's audio or video.");
    if (loadId !== this.loadId) return;

    const AudioContextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not provide Web Audio playback.");
    const sampleRate = await audioTrack?.getSampleRate();
    this.audioContext = new AudioContextClass(sampleRate ? { sampleRate } : undefined);
    this.gain = this.audioContext.createGain();
    this.gain.connect(this.audioContext.destination);
    this.setVolume(1);

    if (videoTrack) {
      const sourceWidth = await videoTrack.getDisplayWidth();
      const sourceHeight = await videoTrack.getDisplayHeight();
      const scale = Math.min(1920 / sourceWidth, 1);
      this.canvas.width = Math.round(sourceWidth * scale);
      this.canvas.height = Math.round(sourceHeight * scale);
      this.videoSink = new CanvasSink(videoTrack, {
        poolSize: 2,
        width: this.canvas.width,
        height: this.canvas.height,
        fit: "contain",
        alpha: await videoTrack.canBeTransparent(),
      });
      this.canvas.hidden = false;
    } else {
      this.canvas.hidden = true;
    }
    this.audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;
    await this.restartVideoFrames();
    this.events.onTimeChange(this.current, this.duration);
  }

  async play(): Promise<void> {
    if (!this.audioContext) return;
    if (this.current >= this.duration) await this.seek(this.start);
    await this.audioContext.resume();
    this.clockStart = this.audioContext.currentTime;
    this.playing = true;
    this.events.onPlayingChange(true);

    if (this.audioSink) {
      const audioRun = ++this.audioRunId;
      this.audioBuffers = this.audioSink.buffers(this.current);
      void this.scheduleAudio(audioRun).catch((error: unknown) => this.fail(error));
    }
    this.tick();
  }

  pause(): void {
    if (this.playing) this.current = Math.min(this.playbackTime(), this.duration);
    this.playing = false;
    this.stopAudio();
    cancelAnimationFrame(this.animationFrame);
    this.events.onPlayingChange(false);
    this.events.onTimeChange(this.current, this.duration);
  }

  async seek(seconds: number): Promise<void> {
    const resume = this.playing;
    this.pause();
    this.current = Math.min(Math.max(seconds, this.start), this.duration);
    await this.restartVideoFrames();
    this.events.onTimeChange(this.current, this.duration);
    if (resume && this.current < this.duration) await this.play();
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(volume, 1)) ** 2;
  }

  destroy(): void {
    this.pause();
    this.loadId++;
    this.videoRunId++;
    void this.videoFrames?.return();
    this.videoFrames = null;
    this.nextFrame = null;
    this.input?.dispose();
    this.input = null;
    if (this.audioContext && this.audioContext.state !== "closed") void this.audioContext.close();
    this.audioContext = null;
    this.videoSink = null;
    this.audioSink = null;
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private playbackTime(): number {
    return this.playing && this.audioContext
      ? this.audioContext.currentTime - this.clockStart + this.current
      : this.current;
  }

  private async restartVideoFrames(): Promise<void> {
    if (!this.videoSink) return;
    const runId = ++this.videoRunId;
    await this.videoFrames?.return();
    this.videoFrames = this.videoSink.canvases(this.current);
    const first = (await this.videoFrames.next()).value ?? null;
    if (runId !== this.videoRunId) return;
    if (first) this.draw(first);
    void this.readNextFrame(runId);
  }

  private async readNextFrame(runId: number): Promise<void> {
    while (this.videoFrames && runId === this.videoRunId) {
      const frame = (await this.videoFrames.next()).value ?? null;
      if (!frame || runId !== this.videoRunId) return;
      if (frame.timestamp > this.playbackTime()) {
        this.nextFrame = frame;
        return;
      }
      this.draw(frame);
    }
  }

  private draw(frame: WrappedCanvas): void {
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(frame.canvas, 0, 0);
  }

  private tick = (): void => {
    if (!this.playing) return;
    const time = this.playbackTime();
    if (time >= this.duration) {
      this.current = this.duration;
      this.pause();
      return;
    }
    if (this.nextFrame && this.nextFrame.timestamp <= time) {
      this.draw(this.nextFrame);
      this.nextFrame = null;
      void this.readNextFrame(this.videoRunId);
    }
    this.events.onTimeChange(time, this.duration);
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private async scheduleAudio(runId: number): Promise<void> {
    if (!this.audioBuffers || !this.audioContext || !this.gain) return;
    for await (const { buffer, timestamp } of this.audioBuffers) {
      if (runId !== this.audioRunId || !this.playing) return;
      const node = this.audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(this.gain);
      const scheduled = this.clockStart + timestamp - this.current;
      const offset = Math.max(this.audioContext.currentTime - scheduled, 0);
      if (offset < buffer.duration) node.start(Math.max(scheduled, this.audioContext.currentTime), offset);
      this.queuedAudio.add(node);
      node.onended = () => this.queuedAudio.delete(node);

      while (timestamp - this.playbackTime() >= 1 && runId === this.audioRunId) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private stopAudio(): void {
    this.audioRunId++;
    void this.audioBuffers?.return();
    this.audioBuffers = null;
    for (const node of this.queuedAudio) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    this.queuedAudio.clear();
  }

  private fail(error: unknown): void {
    this.pause();
    this.events.onError(error instanceof Error ? error.message : String(error));
  }
}

export class ServerConversionPlayer {
  private static readonly windowDuration = 120;
  private mediaId: string | null = null;
  private duration = 0;
  private windowStart = 0;
  private current = 0;
  private active = false;
  private wantsToPlay = false;
  private loadId = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: PlayerEvents,
    private readonly onStatus: (message: string) => void,
  ) {
    video.addEventListener("timeupdate", () => {
      if (!this.active) return;
      this.current = Math.min(this.windowStart + video.currentTime, this.duration);
      this.events.onTimeChange(this.current, this.duration);
    });
    video.addEventListener("play", () => {
      if (this.active) this.events.onPlayingChange(true);
    });
    video.addEventListener("pause", () => {
      if (this.active) this.events.onPlayingChange(false);
    });
    video.addEventListener("ended", () => {
      if (!this.active) return;
      const next = Math.min(this.windowStart + Math.max(video.currentTime, 1), this.duration);
      this.current = next;
      if (next < this.duration - 0.1) void this.loadWindow(next, true);
      else this.events.onPlayingChange(false);
    });
    video.addEventListener("error", () => {
      if (this.active && video.error?.code !== MediaError.MEDIA_ERR_ABORTED) {
        this.events.onError("The server-converted video could not be played.");
      }
    });
  }

  get isPlaying(): boolean { return this.active && !this.video.paused; }
  get currentTime(): number { return this.current; }

  async load(mediaId: string, duration: number): Promise<void> {
    this.destroy();
    this.mediaId = mediaId;
    this.duration = duration;
    this.active = true;
    this.video.controls = false;
    this.video.hidden = false;
    this.events.onTimeChange(0, duration);
    await this.loadWindow(0, true);
  }

  destroy(): void {
    this.loadId++;
    this.active = false;
    this.wantsToPlay = false;
    this.mediaId = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  async play(): Promise<void> {
    this.wantsToPlay = true;
    await this.video.play();
  }

  pause(): void {
    this.wantsToPlay = false;
    this.video.pause();
  }

  async seek(seconds: number): Promise<void> {
    this.current = Math.min(Math.max(seconds, 0), this.duration);
    this.events.onTimeChange(this.current, this.duration);
    await this.loadWindow(this.current, this.wantsToPlay);
  }

  setVolume(volume: number): void {
    this.video.volume = Math.max(0, Math.min(volume, 1));
  }

  private async loadWindow(start: number, autoplay: boolean): Promise<void> {
    if (!this.mediaId || start >= this.duration) return;
    const loadId = ++this.loadId;
    this.wantsToPlay = autoplay;
    this.windowStart = start;
    this.current = start;
    this.onStatus(`Converting from ${formatPlayerTime(start)} on the server…`);
    this.video.pause();
    const duration = Math.min(ServerConversionPlayer.windowDuration, this.duration - start);
    this.video.src = `/api/media/${encodeURIComponent(this.mediaId)}/compatible?start=${start}&duration=${duration}`;
    this.video.load();

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error("Server conversion took too long to start.")), 60_000);
      const ready = () => finish();
      const failed = () => finish(new Error("The server could not create compatible playback."));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.video.removeEventListener("canplay", ready);
        this.video.removeEventListener("error", failed);
        if (error && loadId === this.loadId && this.active) reject(error);
        else resolve();
      };
      this.video.addEventListener("canplay", ready, { once: true });
      this.video.addEventListener("error", failed, { once: true });
    });
    if (loadId !== this.loadId || !this.active) return;
    this.onStatus("Server-compatible playback is ready.");
    if (autoplay) await this.video.play().catch(() => undefined);
  }
}

function formatPlayerTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

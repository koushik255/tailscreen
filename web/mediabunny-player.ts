import { registerAc3Decoder } from "@mediabunny/ac3";
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
registerDtsDecoder();
registerProresDecoder();

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

    if (videoTrack && (!(await videoTrack.getCodec()) || !(await videoTrack.canDecode()))) videoTrack = null;
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

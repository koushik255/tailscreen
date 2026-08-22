import {
  canPlayNatively,
  CompatibilityPlayer,
  StreamingConversionPlayer,
  UnsupportedVideoError,
} from "./mediabunny-player.js";
import { SubtitleController } from "./subtitles.js";

type MediaItem = {
  id: string;
  title: string;
  filename: string;
  library: string;
  folder: string;
  extension: string;
  size: number;
  isExtra: boolean;
};

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing element: ${selector}`);
  return value;
}

const grid = element<HTMLElement>("#mediaGrid");
const template = element<HTMLTemplateElement>("#mediaCardTemplate");
const emptyState = element<HTMLElement>("#emptyState");
const emptyMessage = element<HTMLElement>("#emptyMessage");
const count = element<HTMLElement>("#libraryCount");
const search = element<HTMLInputElement>("#searchInput");
const libraryView = element<HTMLElement>("#libraryView");
const playerView = element<HTMLElement>("#playerView");
const title = element<HTMLElement>("#playerTitle");
const nativeVideo = element<HTMLVideoElement>("#nativePlayer");
const compatibility = element<HTMLElement>("#compatibilityPlayer");
const canvas = element<HTMLCanvasElement>("#playerCanvas");
const status = element<HTMLElement>("#playerStatus");
const playButton = element<HTMLButtonElement>("#togglePlayback");
const playerControls = element<HTMLElement>(".player-controls");
const seek = element<HTMLInputElement>("#seek");
const time = element<HTMLElement>("#playerTime");
const volume = element<HTMLInputElement>("#volume");
const subtitleOverlay = element<HTMLElement>("#subtitleOverlay");
const subtitleButton = element<HTMLButtonElement>("#subtitleButton");
const subtitleFile = element<HTMLInputElement>("#subtitleFile");

let library: MediaItem[] = [];
let openRequest = 0;
let nativeMode: "none" | "direct" | "converted" = "none";
let activeMediaId: string | null = null;
let libraryScrollY = 0;
const subtitles = new SubtitleController(subtitleOverlay, subtitleButton);

const player = new CompatibilityPlayer(canvas, {
  onError: (message) => { status.textContent = message; },
  onPlayingChange: (playing) => { playButton.textContent = playing ? "Pause" : "Play"; },
  onTimeChange: (current, duration) => {
    seek.max = String(duration);
    if (!seek.matches(":active")) seek.value = String(current);
    time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    subtitles.update(current);
  },
});
const convertedPlayer = new StreamingConversionPlayer(
  nativeVideo,
  (message) => {
    compatibility.hidden = false;
    status.textContent = message;
  },
  (message) => { status.textContent = message; },
);

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = bytes ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

function stopPlayback(): void {
  openRequest++;
  nativeMode = "none";
  convertedPlayer.destroy();
  nativeVideo.pause();
  nativeVideo.removeAttribute("src");
  nativeVideo.load();
  player.destroy();
  subtitles.clear();
}

function showLibrary(): void {
  stopPlayback();
  activeMediaId = null;
  playerView.hidden = true;
  libraryView.hidden = false;
  document.title = "Media";
  requestAnimationFrame(() => window.scrollTo(0, libraryScrollY));
}

function backToLibrary(): void {
  const state = history.state as { mediaId?: unknown } | null;
  if (activeMediaId && state?.mediaId === activeMediaId) history.back();
  else showLibrary();
}

async function useCompatibilityPlayer(url: string, request: number): Promise<void> {
  nativeVideo.pause();
  nativeVideo.removeAttribute("src");
  nativeVideo.load();
  nativeVideo.hidden = true;
  compatibility.hidden = false;
  playerControls.hidden = false;
  status.textContent = "Preparing browser-compatible playback…";
  playButton.disabled = true;
  try {
    await player.load(url);
    if (request !== openRequest) return;
    status.textContent = "Compatibility playback is ready.";
    playButton.disabled = false;
  } catch (error) {
    if (error instanceof UnsupportedVideoError && request === openRequest) {
      await useConvertedPlayer(url, request);
      return;
    }
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function useConvertedPlayer(url: string, request: number): Promise<void> {
  player.destroy();
  compatibility.hidden = false;
  canvas.hidden = true;
  playerControls.hidden = true;
  nativeVideo.hidden = true;
  status.textContent = "Converting the container and audio for browser playback…";
  try {
    nativeMode = "converted";
    await convertedPlayer.load(url);
    if (request !== openRequest) return;
    compatibility.hidden = true;
    nativeVideo.hidden = false;
    await nativeVideo.play().catch(() => undefined);
  } catch (error) {
    convertedPlayer.destroy();
    nativeMode = "none";
    compatibility.hidden = false;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function openPlayer(item: MediaItem, pushHistory = true): Promise<void> {
  if (!libraryView.hidden) libraryScrollY = window.scrollY;
  stopPlayback();
  const request = ++openRequest;
  const url = `/api/media/${item.id}/stream`;
  activeMediaId = item.id;
  title.textContent = item.title;
  document.title = item.title;
  libraryView.hidden = true;
  playerView.hidden = false;
  window.scrollTo(0, 0);
  if (pushHistory) history.pushState({ mediaId: item.id }, "", `#watch=${encodeURIComponent(item.id)}`);
  nativeVideo.hidden = true;
  compatibility.hidden = false;
  status.textContent = "Checking browser support…";
  void subtitles.loadEmbedded(item.id);

  try {
    if (await canPlayNatively(url, nativeVideo)) {
      if (request !== openRequest) return;
      compatibility.hidden = true;
      nativeVideo.hidden = false;
      nativeMode = "direct";
      nativeVideo.src = url;
      await nativeVideo.play().catch(() => undefined);
    } else {
      await useCompatibilityPlayer(url, request);
    }
  } catch {
    if (request === openRequest) await useCompatibilityPlayer(url, request);
  }
}

function render(): void {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = library.filter((item) =>
    `${item.title} ${item.library} ${item.folder} ${item.extension}`.toLocaleLowerCase().includes(query));

  grid.replaceChildren();
  let extrasHeadingAdded = false;
  for (const item of filtered) {
    if (item.isExtra && !extrasHeadingAdded) {
      const heading = document.createElement("h2");
      heading.className = "section-label";
      heading.textContent = "Extras";
      grid.append(heading);
      extrasHeadingAdded = true;
    }
    const card = template.content.firstElementChild?.cloneNode(true) as HTMLElement;
    card.querySelector<HTMLElement>(".media-title-text")!.textContent = item.title;
    const location = [item.library, item.folder].filter(Boolean).join(" / ");
    card.querySelector<HTMLElement>(".media-meta")!.textContent = `${location} · ${formatBytes(item.size)}`;
    card.querySelector<HTMLElement>(".format-badge")!.textContent = item.extension;
    const button = card.querySelector<HTMLButtonElement>("button")!;
    button.setAttribute("aria-label", `Play ${item.title}`);
    button.addEventListener("click", () => void openPlayer(item));
    grid.append(card);
  }

  count.textContent = `${filtered.length} ${filtered.length === 1 ? "title" : "titles"}`;
  emptyState.classList.toggle("hidden", filtered.length !== 0);
  emptyMessage.textContent = library.length
    ? "No titles match your search."
    : "Add a library to config.json on the server and reload this page.";
}

async function loadLibrary(): Promise<void> {
  try {
    const payload = await api<{ items: MediaItem[] }>("/api/media");
    library = payload.items;
    render();
    const mediaId = (history.state as { mediaId?: unknown } | null)?.mediaId;
    const item = typeof mediaId === "string" ? library.find((entry) => entry.id === mediaId) : undefined;
    if (item) void openPlayer(item, false);
    else if (mediaId) {
      history.replaceState({ mediaId: null }, "", `${location.pathname}${location.search}`);
      showLibrary();
    }
  } catch (error) {
    count.textContent = "Offline";
    emptyState.classList.remove("hidden");
    emptyMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}

search.addEventListener("input", render);
element<HTMLButtonElement>("#closePlayer").addEventListener("click", backToLibrary);
nativeVideo.addEventListener("error", () => {
  if (!playerView.hidden && nativeMode === "direct" && nativeVideo.src) {
    void useCompatibilityPlayer(nativeVideo.src, openRequest);
  }
});
playButton.addEventListener("click", () => {
  if (player.isPlaying) player.pause();
  else void player.play().catch((error: unknown) => { status.textContent = String(error); });
});
seek.addEventListener("change", () => void player.seek(Number(seek.value)));
volume.addEventListener("input", () => player.setVolume(Number(volume.value)));
nativeVideo.addEventListener("timeupdate", () => subtitles.update(nativeVideo.currentTime));
nativeVideo.addEventListener("seeking", () => subtitles.update(nativeVideo.currentTime));
subtitleButton.addEventListener("click", () => subtitleFile.click());
subtitleFile.addEventListener("change", () => {
  const file = subtitleFile.files?.[0];
  if (file) void subtitles.loadFile(file);
  subtitleFile.value = "";
});

window.addEventListener("popstate", (event) => {
  const mediaId = (event.state as { mediaId?: unknown } | null)?.mediaId;
  const item = typeof mediaId === "string" ? library.find((entry) => entry.id === mediaId) : undefined;
  if (item) void openPlayer(item, false);
  else showLibrary();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !playerView.hidden) backToLibrary();
});

const initialHashId = new URLSearchParams(location.hash.slice(1)).get("watch");
const savedMediaId = (history.state as { mediaId?: unknown } | null)?.mediaId;
if (typeof savedMediaId !== "string") {
  history.replaceState({ mediaId: null }, "", `${location.pathname}${location.search}`);
  if (initialHashId) history.pushState({ mediaId: initialHashId }, "", `#watch=${encodeURIComponent(initialHashId)}`);
}

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js");
void loadLibrary();

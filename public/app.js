const grid = document.querySelector("#mediaGrid");
const template = document.querySelector("#mediaCardTemplate");
const emptyState = document.querySelector("#emptyState");
const emptyMessage = document.querySelector("#emptyMessage");
const count = document.querySelector("#libraryCount");
const search = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const toast = document.querySelector("#toast");
const dialog = document.querySelector("#playerDialog");
const player = document.querySelector("#videoPlayer");
const playerTitle = document.querySelector("#playerTitle");

let library = [];
let toastTimer;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function playHere(item) {
  playerTitle.textContent = item.title;
  player.src = `/api/media/${item.id}/stream`;
  dialog.showModal();
  player.play().catch(() => {});
}

async function launch(item, button) {
  button.disabled = true;
  try {
    await api(`/api/media/${item.id}/launch`, { method: "POST" });
    showToast(`Launched “${item.title}” on the server`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function render() {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = library.filter((item) =>
    `${item.title} ${item.library} ${item.folder} ${item.extension}`.toLocaleLowerCase().includes(query),
  );

  grid.replaceChildren();
  for (const item of filtered) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.querySelector(".media-title-text").textContent = item.title;
    const location = [item.library, item.folder].filter(Boolean).join(" / ");
    card.querySelector(".media-meta").textContent = `${location} · ${formatBytes(item.size)}`;
    card.querySelector(".format-badge").textContent = item.extension;
    card.querySelectorAll('[data-action="play-here"]').forEach((button) => {
      button.setAttribute("aria-label", `Play ${item.title} here`);
      button.addEventListener("click", () => playHere(item));
    });
    const launchButton = card.querySelector('[data-action="launch"]');
    launchButton.setAttribute("aria-label", `Launch ${item.title} on server`);
    launchButton.addEventListener("click", () => launch(item, launchButton));
    grid.append(card);
  }

  count.textContent = `${filtered.length} ${filtered.length === 1 ? "title" : "titles"}`;
  emptyState.classList.toggle("hidden", filtered.length !== 0);
  emptyMessage.textContent = library.length
    ? "No titles match your search."
    : "Add a library to config.json on the server, then rescan.";
}

async function loadLibrary() {
  try {
    const payload = await api("/api/media");
    library = payload.items;
    render();
  } catch (error) {
    count.textContent = "Offline";
    emptyState.classList.remove("hidden");
    emptyMessage.textContent = error.message;
  }
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    await api("/api/scan", { method: "POST" });
    await loadLibrary();
    showToast("Library refreshed");
  } catch (error) {
    showToast(error.message);
  } finally {
    refreshButton.disabled = false;
  }
});

search.addEventListener("input", render);
document.querySelector("#closePlayer").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  player.pause();
  player.removeAttribute("src");
  player.load();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
loadLibrary();

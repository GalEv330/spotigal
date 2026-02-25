// WalkPlayer — Web Audio batch scheduling for iOS lock-screen continuity
// Audio files are served from /songs on the same origin.

// Gradient pairs for the album-art placeholder; cycles per track index.
const TRACK_GRADIENTS = [
  ['#0f3460', '#533483'],
  ['#1a2e4a', '#0f3460'],
  ['#1a472a', '#2d6a4f'],
  ['#4a1942', '#c94b4b'],
  ['#0f2027', '#2c5364'],
  ['#3c1053', '#ad5389'],
  ['#0d2137', '#11998e'],
  ['#2c003e', '#a855f7'],
];

// Parse "Artist - Title.mp3" filenames. Falls back to the bare name as title.
function parseSongMeta(filename) {
  const name = filename.replace(/\.mp3$/i, "");
  const dash = name.indexOf(" - ");
  if (dash !== -1) {
    return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
  }
  return { artist: "—", title: name };
}

// Fetch /songs/ directory listing (works with python3 -m http.server).
// Returns an array of song objects, or null if the listing is unavailable.
async function scanSongsDir() {
  try {
    const res = await fetch("/songs/");
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const songs = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href.toLowerCase().endsWith(".mp3")) continue;
      // href is already URL-encoded by the server; use it directly as the path.
      const filename = decodeURIComponent(href.split("/").pop());
      const { title, artist } = parseSongMeta(filename);
      songs.push({ title, artist, file: `/songs/${href.split("/").pop()}` });
    }
    return songs.length ? songs : null;
  } catch {
    return null;
  }
}

function buildSongs(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Track ${i + 1}`,
    artist: "—",
    file: `/songs/${String(i + 1).padStart(2, "0")}.mp3`,
  }));
}

let SONGS = buildSongs(1); // placeholder until scanSongsDir() resolves

const $ = (id) => document.getElementById(id);

const ui = {
  npTitle:      $("npTitle"),
  npArtist:     $("npArtist"),
  npMeta:       $("npMeta"),
  albumArt:     $("albumArt"),
  nextUpTrack:  $("nextUpTrack"),
  progressBar:  $("progressBar"),
  timeCur:      $("timeCur"),
  timeTot:      $("timeTot"),
  statusLine:   $("statusLine"),

  btnPrev:      $("btnPrev"),
  btnPlay:      $("btnPlay"),
  btnNext:      $("btnNext"),
  playIcon:     $("playIcon"),
  playText:     $("playText"),

  playlistSize: $("playlistSize"),
  batchCustom:  $("batchCustom"),

  list:         $("list"),
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// --- Audio Engine (Web Audio API) ---
class BatchScheduledPlayer {
  constructor(songs) {
    this.songs = songs;
    this.idx = 0;

    this.ctx = null;
    this.gain = null;

    this.isPlaying = false;
    this.isLoading = false;

    this.batchSize = 5;
    this.scheduled = []; // [{ index, startTime, endTime, source, duration }]

    this.bufferCache = new Map();
    this.cacheOrder = [];
    this.maxCached = 8;
  }

  async ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: "playback" });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
    this.setupMediaSession();
  }

  setBatchSize(v) { this.batchSize = v; }

  async play() {
    await this.ensureContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.scheduled.length === 0) {
      await this.rebuildBatchFrom(this.idx, { autostart: true });
      return;
    }
    this.isPlaying = true;
    this.setPlaybackState("playing");
  }

  async pause() {
    if (!this.ctx) return;
    if (this.ctx.state === "running") await this.ctx.suspend();
    this.isPlaying = false;
    this.setPlaybackState("paused");
  }

  async toggle() {
    if (!this.ctx || this.ctx.state !== "running" || !this.isPlaying) {
      await this.play();
    } else {
      await this.pause();
    }
  }

  async next() {
    this.idx = (this.idx + 1) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, {
      autostart: this.isPlaying || this.ctx?.state === "running",
    });
  }

  async prev() {
    const cur = this.getCurrent();
    if (cur && this.ctx.currentTime - cur.startTime > 3) {
      await this.rebuildBatchFrom(cur.index, { autostart: true });
      return;
    }
    this.idx = (this.idx - 1 + this.songs.length) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, {
      autostart: this.isPlaying || this.ctx?.state === "running",
    });
  }

  stopAllScheduled() {
    for (const s of this.scheduled) {
      try { s.source.stop(0); } catch {}
      try { s.source.disconnect(); } catch {}
    }
    this.scheduled = [];
  }

  async rebuildBatchFrom(startIndex, { autostart }) {
    await this.ensureContext();

    this.isLoading = true;
    setStatus("Loading + decoding batch…");
    this.stopAllScheduled();

    const batchCount = Math.min(this.batchSize, this.songs.length);
    const indices = Array.from({ length: batchCount },
      (_, i) => (startIndex + i) % this.songs.length);

    const buffers = [];
    for (const i of indices) {
      const buf = await this.loadDecodedBuffer(this.songs[i].file);
      buffers.push({ index: i, buffer: buf });
    }

    const startAt = this.ctx.currentTime + 0.18;
    let t = startAt;

    for (const item of buffers) {
      const source = this.ctx.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.gain);
      const duration = item.buffer.duration;
      source.start(t);
      this.scheduled.push({ index: item.index, source, startTime: t, endTime: t + duration, duration });
      t += duration;
    }

    this.idx = startIndex;
    this.isLoading = false;
    setStatus(`Scheduled ${this.scheduled.length} track(s).`);

    if (autostart) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.isPlaying = true;
      this.setPlaybackState("playing");
    } else {
      this.isPlaying = false;
      this.setPlaybackState("paused");
    }

    this.updateNowPlayingMetadata(startIndex);
    scheduleMetadataUpdates();
  }

  async loadDecodedBuffer(url) {
    if (this.bufferCache.has(url)) return this.bufferCache.get(url);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(arr, resolve, reject);
    });
    this.bufferCache.set(url, buf);
    this.cacheOrder.push(url);
    while (this.cacheOrder.length > this.maxCached) {
      this.bufferCache.delete(this.cacheOrder.shift());
    }
    return buf;
  }

  getCurrent() {
    if (!this.ctx || !this.scheduled.length) return null;
    const t = this.ctx.currentTime;
    for (const seg of this.scheduled) {
      if (t >= seg.startTime && t < seg.endTime) return seg;
    }
    return this.scheduled[this.scheduled.length - 1] ?? null;
  }

  getProgress() {
    const cur = this.getCurrent();
    if (!cur) return { ratio: 0, pos: 0, dur: 0, index: this.idx };
    const t = this.ctx.currentTime;
    const pos = Math.max(0, t - cur.startTime);
    const dur = cur.duration;
    return { ratio: dur > 0 ? clamp01(pos / dur) : 0, pos, dur, index: cur.index };
  }

  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", async () => { await this.play(); render(); });
      navigator.mediaSession.setActionHandler("pause", async () => { await this.pause(); render(); });
      navigator.mediaSession.setActionHandler("nexttrack", async () => { await this.next(); render(); });
      navigator.mediaSession.setActionHandler("previoustrack", async () => { await this.prev(); render(); });
    } catch {}
  }

  updateNowPlayingMetadata(index) {
    if (!("mediaSession" in navigator)) return;
    const song = this.songs[index];
    if (!song) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: "WalkPlayer",
        artwork: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    } catch {}
    this.setPlaybackState(this.isPlaying ? "playing" : "paused");
  }

  setPlaybackState(state) {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = state; } catch {}
  }
}

// --- Scheduled metadata timers for lock-screen track transitions ---
const metadataTimers = [];

function scheduleMetadataUpdates() {
  metadataTimers.forEach(id => clearTimeout(id));
  metadataTimers.length = 0;
  if (!player.ctx || !player.scheduled.length) return;
  const audioNow = player.ctx.currentTime;
  for (const seg of player.scheduled) {
    const delayMs = (seg.startTime - audioNow) * 1000 - 50;
    if (delayMs <= 0) continue;
    const { index } = seg;
    metadataTimers.push(setTimeout(() => {
      player.updateNowPlayingMetadata(index);
    }, delayMs));
  }
}

// --- UI wiring ---
const player = new BatchScheduledPlayer(SONGS);

function setStatus(msg) {
  ui.statusLine.textContent = msg;
}

function buildList() {
  ui.list.innerHTML = "";
  SONGS.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.dataset.index = String(i);
    li.innerHTML = `
      <div class="l">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="a">${escapeHtml(s.artist)}</div>
      </div>
      <div class="r">#${i + 1}</div>
    `;
    li.addEventListener("click", async () => {
      player.idx = i;
      await player.rebuildBatchFrom(i, { autostart: true });
      render(true);
    });
    ui.list.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markActive(index) {
  ui.list.querySelectorAll(".item").forEach(el => el.classList.remove("active"));
  const active = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (active) {
    active.classList.add("active");
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function render(forceMetadata = false) {
  const cur = player.getCurrent();
  const p = player.getProgress();
  const idx = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  ui.npTitle.textContent  = song ? song.title  : "Not playing";
  ui.npArtist.textContent = song ? song.artist : "Tap Play to start";
  ui.npMeta.textContent   = song ? `Track ${idx + 1} / ${SONGS.length}` : "—";

  const [c1, c2] = TRACK_GRADIENTS[idx % TRACK_GRADIENTS.length];
  ui.albumArt.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  const nextIdx  = (idx + 1) % SONGS.length;
  const nextSong = SONGS[nextIdx];
  if (nextSong && SONGS.length > 1) {
    ui.nextUpTrack.textContent = nextSong.artist !== "—"
      ? `${nextSong.title} · ${nextSong.artist}`
      : nextSong.title;
  } else {
    ui.nextUpTrack.textContent = "—";
  }

  ui.progressBar.style.width = `${Math.round(p.ratio * 100)}%`;
  ui.timeCur.textContent = fmtTime(p.pos);
  ui.timeTot.textContent = fmtTime(p.dur);

  const playing = player.isPlaying && player.ctx?.state === "running";
  ui.playIcon.textContent = playing ? "⏸" : "▶️";
  ui.playText.textContent = playing ? "Pause" : "Play";

  markActive(idx);

  if (player.ctx && player.isPlaying && p.dur > 0) {
    try {
      navigator.mediaSession?.setPositionState({
        duration: p.dur,
        playbackRate: 1,
        position: Math.min(p.pos, p.dur),
      });
    } catch {}
  }

  if (forceMetadata && song) player.updateNowPlayingMetadata(idx);
}

// --- Batch size controls ---
let currentBatchSize = 5;

function applyBatchSize(val) {
  currentBatchSize = val;
  player.setBatchSize(val);
  document.querySelectorAll(".batch-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.val) === val);
  });
  if (ui.batchCustom.value !== String(val)) {
    ui.batchCustom.value = val;
  }
}

document.querySelectorAll(".batch-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const val = Math.max(1, parseInt(btn.dataset.val, 10));
    applyBatchSize(val);
    if (player.ctx && player.scheduled.length) {
      try {
        await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
        render(true);
      } catch (e) { setStatus(`Error: ${e.message}`); }
    } else {
      setStatus(`Batch size set to ${val}.`);
    }
  });
});

ui.batchCustom.addEventListener("change", async (ev) => {
  const val = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = val;
  applyBatchSize(val);
  if (player.ctx && player.scheduled.length) {
    try {
      await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
      render(true);
    } catch (e) { setStatus(`Error: ${e.message}`); }
  } else {
    setStatus(`Batch size set to ${val}.`);
  }
});

// --- Playback controls ---
ui.btnPlay.addEventListener("click", async () => {
  try { await player.toggle(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.btnNext.addEventListener("click", async () => {
  try { await player.next(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.btnPrev.addEventListener("click", async () => {
  try { await player.prev(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

$("btnReseed").addEventListener("click", async () => {
  try {
    await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
    render(true);
  } catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.playlistSize.addEventListener("change", (ev) => {
  const n = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = n;
  SONGS = buildSongs(n);
  player.songs = SONGS;
  player.idx = Math.min(player.idx, SONGS.length - 1);
  player.stopAllScheduled();
  player.isPlaying = false;
  player.setPlaybackState("paused");
  buildList();
  setStatus(`Playlist set to ${n} track(s). Press Play to start.`);
  render(true);
});

// --- Animation loop ---
let lastRenderedTrackIndex = -1;

function tick() {
  render(false);
  const cur = player.getCurrent();
  if (cur && cur.index !== lastRenderedTrackIndex) {
    lastRenderedTrackIndex = cur.index;
    player.updateNowPlayingMetadata(cur.index);
    markActive(cur.index);
  }
  requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const cur = player.getCurrent();
    if (cur) player.updateNowPlayingMetadata(cur.index);
    render(true);
  }
});

// --- Init ---
async function init() {
  // Try to auto-discover songs from the /songs/ directory listing.
  const scanned = await scanSongsDir();
  if (scanned) {
    SONGS = scanned;
    player.songs = SONGS;
    ui.playlistSize.value = SONGS.length;
    setStatus(`Found ${SONGS.length} song(s) in /songs/.`);
  } else {
    // Fall back to numbered files based on the playlist size input.
    const n = Math.max(1, parseInt(ui.playlistSize.value, 10) || 12);
    SONGS = buildSongs(n);
    player.songs = SONGS;
    setStatus("Could not scan /songs/. Set playlist size manually.");
  }

  buildList();
  applyBatchSize(currentBatchSize);
  render(true);
  requestAnimationFrame(tick);
}

init();

// PWA service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("/sw.js"); } catch {}
  });
}

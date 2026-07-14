// Same-origin API route — Vercel serves this automatically from /api/search.js.
// No external URL to configure, and no CORS issues since it's the same domain.
const WORKER_URL = "";

const form = document.getElementById("search-form");
const input = document.getElementById("topic-input");
const searchBtn = document.getElementById("search-btn");
const statusLine = document.getElementById("status-line");
const loadingSteps = document.getElementById("loading-steps");
const resultsSection = document.getElementById("results");
const resultsList = document.getElementById("results-list");
const resultsTopic = document.getElementById("results-topic");
const resultsMeta = document.getElementById("results-meta");
const emptyState = document.getElementById("empty-state");
const offlineBanner = document.getElementById("offline-banner");
const noResultsEl = document.getElementById("no-results");
const filterBar = document.querySelector(".filter-bar");

const LAST_SEARCH_KEY = "relevo:last-search";

// Holds the most recent result set so filter chips can re-sort
// client-side without spending another search on the backend.
let currentResults = [];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = input.value.trim();
  if (!topic) return;
  await runSearch(topic);
});

// ---- Progressive loading sequence.
// These four steps are the actual order the backend pipeline runs in
// (see api/search.js) — this is a timed approximation of real progress,
// not a live stream, so the timing is a reasonable estimate rather than
// an exact readout.
const STEP_DELAYS_MS = [0, 1800, 3600, 6500];
let stepTimers = [];

function startLoadingSteps() {
  loadingSteps.hidden = false;
  const steps = loadingSteps.querySelectorAll(".loading-step");
  steps.forEach((s) => s.classList.remove("is-done", "is-active"));
  stepTimers.forEach(clearTimeout);
  stepTimers = STEP_DELAYS_MS.map((delay, i) =>
    setTimeout(() => {
      steps.forEach((s, idx) => {
        if (idx < i) s.classList.add("is-done");
        s.classList.toggle("is-active", idx === i);
      });
    }, delay)
  );
}

function stopLoadingSteps() {
  stepTimers.forEach(clearTimeout);
  stepTimers = [];
  loadingSteps.hidden = true;
  loadingSteps.querySelectorAll(".loading-step").forEach((s) => {
    s.classList.remove("is-active");
    s.classList.add("is-done");
  });
}

async function runSearch(topic) {
  setLoading(true);
  statusLine.textContent = "";
  startLoadingSteps();
  emptyState.hidden = true;
  noResultsEl.hidden = true;

  try {
    const res = await fetch(`${WORKER_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    currentResults = data.results || [];
    renderResults(data);
    cacheLastSearch(data);
  } catch (err) {
    statusLine.textContent = `Something went wrong: ${err.message}. Showing your last saved search if available.`;
    const cached = loadLastSearch();
    if (cached) {
      currentResults = cached.results || [];
      renderResults(cached, { stale: true });
    }
  } finally {
    setLoading(false);
    stopLoadingSteps();
  }
}

function renderResults(data, { stale = false } = {}) {
  resultsTopic.textContent = `Results for "${data.topic}"`;
  if (stale) {
    resultsMeta.textContent = "showing your last saved search (offline)";
  } else if (data.cached) {
    resultsMeta.textContent = `${data.results.length} scored · instant (cached)`;
  } else {
    resultsMeta.textContent = `${data.results.length} scored · ${data.consideredButNotDeepened || 0} more considered`;
  }

  resetFilterChips();
  resultsSection.hidden = false;

  if (!data.results || data.results.length === 0) {
    resultsList.innerHTML = "";
    noResultsEl.hidden = false;
    filterBar.hidden = true;
    return;
  }

  filterBar.hidden = false;
  noResultsEl.hidden = true;
  renderList(data.results);
}

function renderList(list) {
  resultsList.innerHTML = "";
  list.forEach((v, i) => {
    resultsList.appendChild(renderCard(v, i + 1));
  });
}

// ---- Client-side sort: all data needed already came back with the
// original search, so re-sorting costs nothing — no new API call.
function resetFilterChips() {
  if (!filterBar) return;
  filterBar.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.sort === "best");
  });
}

if (filterBar) {
  filterBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    filterBar.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    renderList(sortResults(currentResults, chip.dataset.sort));
  });
}

function sortResults(list, sortKey) {
  const copy = [...list];
  switch (sortKey) {
    case "newest":
      return copy.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    case "popular":
      return copy.sort((a, b) => b.views - a.views);
    case "short":
      return copy.sort((a, b) => parseDuration(a.duration) - parseDuration(b.duration));
    case "best":
    default:
      return copy.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
  }
}

// Parses YouTube's ISO 8601 duration format (e.g. "PT14M32S") into seconds.
function parseDuration(iso) {
  if (!iso) return Infinity;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return Infinity;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

function formatDuration(iso) {
  const totalSeconds = parseDuration(iso);
  if (!isFinite(totalSeconds)) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function renderCard(v, rank) {
  const li = document.createElement("li");
  const wrapper = document.createElement("div");
  wrapper.className = "result-card";

  const rankNum = String(rank).padStart(2, "0");
  const durationText = formatDuration(v.duration);
  const confidence = v.finalScore ?? v.semanticScore ?? 0;

  wrapper.innerHTML = `
    <a class="result-link" href="${v.url}" target="_blank" rel="noopener">
      <div class="result-top">
        <span class="result-rank">${rankNum}</span>
        <div class="result-thumb-wrap">
          <img class="result-thumb" src="${v.thumbnail || ""}" alt="" loading="lazy">
          ${durationText ? `<span class="thumb-duration">${durationText}</span>` : ""}
        </div>
        <div class="result-body">
          <p class="result-title">${escapeHtml(v.title)}</p>
          <p class="result-channel">${escapeHtml(v.channelTitle)} · ${formatViews(v.views)} views</p>
          <p class="result-reason">${escapeHtml(v.reason || "")}</p>
        </div>
        <div class="confidence-badge" title="Overall AI confidence score">
          <span class="confidence-value">${confidence}</span>
          <span class="confidence-label">AI score</span>
        </div>
      </div>
    </a>
    <button type="button" class="breakdown-toggle" aria-expanded="false">Show score breakdown <i class="chevron"></i></button>
    <div class="score-bars">
      <div class="score-row">
        <span class="score-name">Relevance</span>
        <span class="score-track"><span class="score-fill relevance" data-fill="${v.semanticScore}"></span></span>
        <span class="score-value">${v.semanticScore}</span>
      </div>
      <div class="score-row">
        <span class="score-name">Comments</span>
        <span class="score-track"><span class="score-fill comments" data-fill="${v.commentQuality}"></span></span>
        <span class="score-value">${v.commentQuality}</span>
      </div>
      <div class="score-row">
        <span class="score-name">Momentum</span>
        <span class="score-track"><span class="score-fill momentum" data-fill="${v.heuristicScore}"></span></span>
        <span class="score-value">${v.heuristicScore}</span>
      </div>
    </div>
    ${(v.pro || v.con) ? `
    <div class="pros-cons">
      ${v.pro ? `<div class="pc-row pc-pro"><i class="pc-icon" aria-hidden="true"></i>${escapeHtml(v.pro)}</div>` : ""}
      ${v.con ? `<div class="pc-row pc-con"><i class="pc-icon" aria-hidden="true"></i>${escapeHtml(v.con)}</div>` : ""}
    </div>` : ""}
  `;
  li.appendChild(wrapper);

  const toggle = wrapper.querySelector(".breakdown-toggle");
  const bars = wrapper.querySelector(".score-bars");
  toggle.addEventListener("click", () => {
    const willOpen = !bars.classList.contains("is-open");
    bars.classList.toggle("is-open", willOpen);
    toggle.setAttribute("aria-expanded", String(willOpen));
    toggle.classList.toggle("is-open", willOpen);
    if (willOpen) {
      requestAnimationFrame(() => {
        bars.querySelectorAll(".score-fill").forEach((bar) => {
          bar.style.setProperty("--fill", `${bar.dataset.fill || 0}%`);
          bar.classList.add("is-filled");
        });
      });
    }
  });

  return li;
}

function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading;
  searchBtn.textContent = isLoading ? "Scanning…" : "Search";
}

function cacheLastSearch(data) {
  try {
    localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(data));
  } catch {
    // storage full or unavailable — non-critical
  }
}

function loadLastSearch() {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- Offline detection ----
window.addEventListener("offline", () => (offlineBanner.hidden = false));
window.addEventListener("online", () => (offlineBanner.hidden = true));
if (!navigator.onLine) offlineBanner.hidden = false;

// ---- Install prompt (PWA) ----
let deferredPrompt;
const installBtn = document.getElementById("install-btn");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

// ---- Register service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(console.error);
  });
}

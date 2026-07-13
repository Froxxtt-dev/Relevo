// Same-origin API route — Vercel serves this automatically from /api/search.js.
// No external URL to configure, and no CORS issues since it's the same domain.
const WORKER_URL = "";

const form = document.getElementById("search-form");
const input = document.getElementById("topic-input");
const searchBtn = document.getElementById("search-btn");
const statusLine = document.getElementById("status-line");
const resultsSection = document.getElementById("results");
const resultsList = document.getElementById("results-list");
const resultsTopic = document.getElementById("results-topic");
const resultsMeta = document.getElementById("results-meta");
const emptyState = document.getElementById("empty-state");
const offlineBanner = document.getElementById("offline-banner");

const LAST_SEARCH_KEY = "relevo:last-search";

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = input.value.trim();
  if (!topic) return;
  await runSearch(topic);
});

async function runSearch(topic) {
  setLoading(true);
  statusLine.textContent = "Pulling candidates from YouTube and scoring relevance…";
  emptyState.hidden = true;

  try {
    const res = await fetch(`${WORKER_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    renderResults(data);
    cacheLastSearch(data);
    statusLine.textContent = "";
  } catch (err) {
    statusLine.textContent = `Something went wrong: ${err.message}. Showing your last saved search if available.`;
    const cached = loadLastSearch();
    if (cached) renderResults(cached, { stale: true });
  } finally {
    setLoading(false);
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

  resultsList.innerHTML = "";
  data.results.forEach((v, i) => {
    resultsList.appendChild(renderCard(v, i + 1));
  });

  resultsSection.hidden = false;
}

function renderCard(v, rank) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.className = "result-card";
  a.href = v.url;
  a.target = "_blank";
  a.rel = "noopener";

  const rankNum = String(rank).padStart(2, "0");

  a.innerHTML = `
    <div class="result-top">
      <span class="result-rank">${rankNum}</span>
      <img class="result-thumb" src="${v.thumbnail || ""}" alt="" loading="lazy">
      <div class="result-body">
        <p class="result-title">${escapeHtml(v.title)}</p>
        <p class="result-channel">${escapeHtml(v.channelTitle)} · ${formatViews(v.views)} views</p>
        <p class="result-reason">${escapeHtml(v.reason || "")}</p>
      </div>
    </div>
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
  `;
  li.appendChild(a);

  // Set the fill % as a CSS variable, then flip a class on the next frame
  // so the transition (defined in styles.css) actually animates in.
  requestAnimationFrame(() => {
    li.querySelectorAll(".score-fill").forEach((bar) => {
      bar.style.setProperty("--fill", `${bar.dataset.fill || 0}%`);
      bar.classList.add("is-filled");
    });
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
  searchBtn.textContent = isLoading ? "Scanning…" : "Find videos";
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

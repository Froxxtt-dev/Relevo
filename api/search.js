/**
 * Relevo — YouTube learning relevance API (Vercel serverless function)
 *
 * Pipeline per search:
 *   1. Check cache (Redis, via the Vercel Marketplace integration) —
 *      identical topics within the TTL return instantly with zero
 *      YouTube/Groq quota spent.
 *   2. YouTube search.list -> candidate pool
 *   3. YouTube videos.list -> stats/duration for all candidates
 *   4. Heuristic score (view velocity + engagement) ranks them
 *   5. Top N candidates get: comments pulled + an actual transcript
 *      snippet fetched (real content matching, not just title/description)
 *   6. One batched Groq call scores semantic relevance + comment quality
 *   7. Result is cached, then returned
 *
 * Environment Variables (Project → Settings → Environment Variables):
 *   YOUTUBE_API_KEY
 *   GROQ_API_KEY
 *   REDIS_URL — auto-injected once you connect a Redis database to this
 *   project via the Storage tab (see README). A standard redis:// or
 *   rediss:// connection string.
 */

import Redis from "ioredis";
import { YoutubeTranscript } from "youtube-transcript";

// Reused across warm invocations of this function — ioredis handles
// reconnection internally. Conservative retry settings so a Redis
// hiccup can't hang the whole request; cache failures always degrade
// to "just do the search without caching" rather than breaking search.
let redis = null;
function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 4000,
      lazyConnect: false,
    });
    redis.on("error", (err) => console.error("Redis connection error:", err));
  }
  return redis;
}

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

const SEARCH_POOL_SIZE = 20;
const DEEP_ANALYZE_COUNT = 10;
const COMMENTS_PER_VIDEO = 5;
const TRANSCRIPT_CHAR_BUDGET = 500; // keep prompt size in check
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(404).json({ error: "Not found" });

  try {
    const { topic } = req.body || {};
    if (!topic || typeof topic !== "string" || topic.trim().length < 2) {
      return res.status(400).json({ error: "Provide a topic string (min 2 characters)." });
    }
    const cleanTopic = topic.trim();
    const cacheKey = `relevo:search:${normalizeKey(cleanTopic)}`;

    // ---- 1. Cache check ----
    const client = getRedis();
    if (client) {
      try {
        const cached = await client.get(cacheKey);
        if (cached) {
          return res.status(200).json({ ...JSON.parse(cached), cached: true });
        }
      } catch (cacheErr) {
        // Redis not reachable / not configured yet — degrade to no-cache
        // rather than failing the whole search.
        console.error("Cache read failed (continuing without cache):", cacheErr);
      }
    }

    const result = await handleSearch(cleanTopic);

    // ---- 7. Cache write (best-effort, never blocks the response) ----
    if (client) {
      try {
        await client.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
      } catch (cacheErr) {
        console.error("Cache write failed (result still returned):", cacheErr);
      }
    }

    return res.status(200).json({ ...result, cached: false });
  } catch (err) {
    // Full detail goes to Vercel's server-side logs only. The client
    // gets a safe, generic message — no provider internals, no org IDs.
    console.error("search handler error:", err);
    return res.status(500).json({
      error: "Search is temporarily unavailable. Please try again shortly.",
    });
  }
}

function normalizeKey(topic) {
  return topic.toLowerCase().trim().replace(/\s+/g, " ");
}

async function handleSearch(topic) {
  const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  const searchParams = new URLSearchParams({
    part: "snippet",
    q: topic,
    type: "video",
    maxResults: String(SEARCH_POOL_SIZE),
    relevanceLanguage: "en",
    safeSearch: "moderate",
    key: YOUTUBE_API_KEY,
  });
  const searchRes = await fetch(`${YT_BASE}/search?${searchParams}`);
  const searchData = await searchRes.json();
  if (searchData.error) throw new Error(`YouTube search error: ${searchData.error.message}`);

  const videoIds = (searchData.items || [])
    .map((item) => item.id?.videoId)
    .filter(Boolean);

  if (videoIds.length === 0) {
    return { topic, results: [], note: "No videos found for this topic." };
  }

  const statsParams = new URLSearchParams({
    part: "statistics,contentDetails,snippet",
    id: videoIds.join(","),
    key: YOUTUBE_API_KEY,
  });
  const statsRes = await fetch(`${YT_BASE}/videos?${statsParams}`);
  const statsData = await statsRes.json();
  if (statsData.error) throw new Error(`YouTube videos error: ${statsData.error.message}`);

  let candidates = (statsData.items || []).map((v) => buildCandidate(v));

  candidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const toDeepen = candidates.slice(0, DEEP_ANALYZE_COUNT);
  const rest = candidates.slice(DEEP_ANALYZE_COUNT);

  // Comments and transcript are independent fetches per video — run
  // both concurrently across all shortlisted candidates.
  await Promise.all(
    toDeepen.map(async (c) => {
      const [comments, transcript] = await Promise.all([
        fetchTopComments(c.id, YOUTUBE_API_KEY),
        fetchTranscriptSnippet(c.id),
      ]);
      c.topComments = comments;
      c.transcriptSnippet = transcript;
    })
  );

  const llmScored = await scoreWithGroq(topic, toDeepen, GROQ_API_KEY);

  const finalResults = llmScored
    .map((r) => ({
      ...r,
      finalScore: Math.round(0.55 * r.semanticScore + 0.25 * r.heuristicScore + 0.20 * r.commentQuality),
    }))
    .sort((a, b) => b.finalScore - a.finalScore);

  return {
    topic,
    results: finalResults,
    consideredButNotDeepened: rest.length,
    generatedAt: new Date().toISOString(),
  };
}

function buildCandidate(v) {
  const stats = v.statistics || {};
  const views = Number(stats.viewCount || 0);
  const likes = Number(stats.likeCount || 0);
  const comments = Number(stats.commentCount || 0);
  const publishedAt = new Date(v.snippet.publishedAt);
  const ageDays = Math.max(1, (Date.now() - publishedAt.getTime()) / 86400000);

  const viewVelocity = views / ageDays;
  const velocityScore = Math.min(100, Math.log10(viewVelocity + 1) * 22);

  const engagementRatio = views > 0 ? likes / views : 0;
  const engagementScore = Math.min(100, engagementRatio * 4000);

  const heuristicScore = Math.round(0.6 * velocityScore + 0.4 * engagementScore);

  return {
    id: v.id,
    title: v.snippet.title,
    channelTitle: v.snippet.channelTitle,
    description: (v.snippet.description || "").slice(0, 160),
    publishedAt: v.snippet.publishedAt,
    thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    views,
    likes,
    commentCount: comments,
    duration: v.contentDetails?.duration || null,
    heuristicScore,
  };
}

async function fetchTopComments(videoId, apiKey) {
  const params = new URLSearchParams({
    part: "snippet",
    videoId,
    maxResults: String(COMMENTS_PER_VIDEO),
    order: "relevance",
    textFormat: "plainText",
    key: apiKey,
  });
  try {
    const res = await fetch(`${YT_BASE}/commentThreads?${params}`);
    const data = await res.json();
    if (data.error) return []; // comments disabled or quota edge case — fail soft
    return (data.items || []).map(
      (i) => i.snippet.topLevelComment.snippet.textDisplay
    );
  } catch {
    return [];
  }
}

// Real content matching: pull the actual spoken transcript instead of
// relying on title/description alone, which can be misleading. Fails
// soft (empty string) for videos with no captions — very common, so
// this must never break the search.
async function fetchTranscriptSnippet(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const fullText = segments.map((s) => s.text).join(" ");
    return fullText.slice(0, TRANSCRIPT_CHAR_BUDGET);
  } catch {
    return "";
  }
}

async function scoreWithGroq(topic, candidates, apiKey) {
  const compactList = candidates.map((c, idx) => ({
    idx,
    title: c.title,
    channel: c.channelTitle,
    description: c.description,
    transcriptExcerpt: c.transcriptSnippet || "(no captions available)",
    comments: c.topComments.slice(0, 5),
  }));

  const systemPrompt = `You are a strict content-relevance evaluator for a learning tool.
Given a learning TOPIC and a list of candidate YouTube videos (title, channel, description,
an excerpt of the actual spoken transcript, and sample comments), score EACH video on two
independent 0-100 scales:

1. "semanticScore": how directly and thoroughly does this video actually teach or explain the
   TOPIC? Weight the transcript excerpt most heavily — it reflects what is actually said, while
   titles and descriptions can be misleading or clickbait. If the transcript excerpt is
   "(no captions available)", rely on title/description/comments instead, and be more conservative.
2. "commentQuality": based on the sample comments, do viewers indicate they learned something /
   found it clear and accurate? Confused, misled, or "clickbait" complaints should lower this
   score. If comments are empty or uninformative, return 50 (neutral).

Also write a one-sentence "reason" (max 20 words) explaining the semanticScore.

Return ONLY a JSON array, no prose, no markdown fences, in this exact shape:
[{"idx":0,"semanticScore":87,"commentQuality":72,"reason":"..."}]`;

  const userPrompt = `TOPIC: ${topic}\n\nCANDIDATES:\n${JSON.stringify(compactList, null, 2)}`;

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 2000,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Groq error: ${data.error.message}`);

  let parsed;
  try {
    const raw = data.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse Groq relevance response");
  }

  return parsed.map((p) => {
    const original = candidates[p.idx];
    return {
      ...original,
      semanticScore: clamp(p.semanticScore),
      commentQuality: clamp(p.commentQuality),
      reason: p.reason || "",
    };
  });
}

function clamp(n) {
  n = Number(n) || 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

# Relevo — YouTube learning relevance finder (Vercel version)

One platform, one dashboard. No Cloudflare, no separate GitHub Pages step.

```
relevo-vercel/
├── api/
│   └── search.js       ← the relevance-scoring function (holds your API keys)
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── manifest.json
│   ├── service-worker.js
│   └── icons/
└── vercel.json
```

## 1. Get your API keys (same as before)

- **YouTube Data API v3** key — Google Cloud Console → enable "YouTube Data API v3" → Credentials → Create API key.
- **Groq API key** — console.groq.com.

You already have both from the earlier setup — same keys work here.

## 2. Push this folder to GitHub

```
cd relevo-vercel
git init
git add .
git commit -m "Relevo on Vercel"
git remote add origin https://github.com/<you>/relevo.git
git push -u origin main
```

(If you still have the old `relevo` repo from the Cloudflare attempt, you can
either overwrite it with this content or create a fresh repo — either is fine.)

## 3. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → sign up/log in with GitHub (free).
2. **Add New → Project** → select your `relevo` repo → **Import**.
3. Before clicking Deploy, expand **Environment Variables** and add:
   - `YOUTUBE_API_KEY` → your key
   - `GROQ_API_KEY` → your key
4. Click **Deploy**.

Vercel automatically detects `api/search.js` as a serverless function and
`public/` as the static site — no configuration needed beyond the env vars.

## 4. That's it

You'll get a URL like `https://relevo-yourname.vercel.app`. Visit it, search
a topic, and it should work — same origin for frontend and API means no CORS
issues, and no separate worker URL to keep in sync.

## Why this avoids the earlier problem

The Cloudflare Workers issue you hit was `*.workers.dev` domains being
blocked at a DNS level (your ISP or a bundled security tool, most likely) —
independent of anything in the code. `*.vercel.app` is an extremely widely
used domain (huge share of the web's frontend deploys run on it), which
makes a wholesale block far less likely. If you ever DO hit a similar issue
again, the fastest test is: **try loading `https://vercel.com` itself** — if
that's blocked too, the issue is bigger than any one platform (e.g. a proxy
or firewall blocking most external sites), and worth investigating on its
own.

## Everything else — unchanged

The scoring pipeline, UI, comment analysis, and PWA install behavior are
identical to before:
1. YouTube `search.list` → ~20 candidates
2. YouTube `videos.list` → stats for all of them
3. Heuristic score (view velocity + engagement ratio) ranks them
4. Top 12 get comments pulled
5. One batched Groq call scores semantic relevance + comment quality
6. Final score = 55% semantic + 25% momentum + 20% comment quality

See the "Extending this" ideas from the original README (transcript
matching, per-user history via Vercel KV, skill-level filtering, and the
training-program playlist idea) — all still apply here.

## Update — caching, transcript matching, and safer errors

Three additions on top of the base version:

### 1. Caching via Redis (through Vercel's Storage marketplace)
Vercel's own KV product was retired and folded into Marketplace database
integrations — still free at this scale.

1. In your Vercel project dashboard → **Storage** tab → **Create Database**.
2. Choose a Redis provider from the marketplace list and follow the prompts
   to create the database and connect it to this project.
3. Vercel automatically injects a `REDIS_URL` environment variable (a standard
   `redis://` or `rediss://` connection string) — no copying keys by hand.
4. Redeploy (Deployments → latest → ⋯ → Redeploy) so the function picks it up.

The code connects via `ioredis` using that connection string directly. If the
variable is missing or the connection fails for any reason, caching is simply
skipped for that request — search still works, just without the speed/quota
benefit of a cache hit.

Once this is set up, identical searches within a 6-hour window return instantly
with zero YouTube or Groq quota spent — this is what actually protects you from
repeating today's rate-limit outage.

### 2. Safer error handling
If anything fails server-side (a provider outage, a bad key, a rate limit),
the browser now only ever sees: *"Search is temporarily unavailable. Please
try again shortly."* The real error — provider name, message, stack trace —
goes only to your Vercel function logs (Deployments → latest → Functions),
never to the person searching.

### 3. Real transcript matching
Each shortlisted video now has its actual spoken transcript (first ~500
characters) fetched and handed to Groq alongside the title/description/comments,
with instructions to weight it most heavily. This is the single biggest quality
upgrade possible for this tool — it catches videos whose titles oversell what
they actually cover, and rewards videos that quietly deliver. Videos without
captions fall back gracefully to the old title/description-based judgment — this
never breaks a search.

**New dependency note**: this update adds `@upstash/redis` and `youtube-transcript`
to `package.json`. Vercel installs these automatically on your next deploy —
no action needed beyond pushing the updated files (plus the two environment
variables from step 1 above).

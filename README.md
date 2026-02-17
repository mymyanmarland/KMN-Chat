# Ko Paing Edge Terminal Chat

Production-style serverless chatbot on **Cloudflare Workers** using **OpenRouter**.

## 1) Setup

```bash
cd /data/data/com.termux/files/home/.openclaw/workspace/kopaing-edge-terminal-chat
npm install
npx wrangler login
npx wrangler secret put OPEN_ROUTER_API_KEY
```

Optional secrets/vars:

```bash
npx wrangler secret put SITE_URL
npx wrangler secret put SITE_NAME
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

Edit `wrangler.toml` for optional `ALLOWED_ORIGIN`.

## 2) Local dev

```bash
npm run dev
```

## 3) Deploy

```bash
npm run deploy
```

After deploy, Worker URL looks like:

`https://kopaing-edge-terminal-chat.<your-subdomain>.workers.dev`

Open it in browser and chat.

## 4) Supabase persistence (Builder)

1. In Supabase SQL Editor, run `supabase.sql` from this repo.
2. Set worker secrets:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

3. Redeploy Worker.
4. Open `/builder` and click **Save Bot**.

## Notes
- API key stays server-side only.
- `/api/models` fetches available models with fallback cache behavior.
- `/api/chat` streams output token-by-token (SSE passthrough).
- Builder persistence endpoints:
  - `GET /api/builder/state?bot=<name>`
  - `POST /api/builder/state`

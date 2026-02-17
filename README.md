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

## Notes
- API key stays server-side only.
- `/api/models` fetches available models with fallback cache behavior.
- `/api/chat` streams output token-by-token (SSE passthrough).

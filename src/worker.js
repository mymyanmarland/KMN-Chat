const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS_CACHE_TTL_MS = 300_000;
const MAX_PROMPT_CHARS = 8000;

let modelsCache = { at: 0, data: null };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });

    if (url.pathname === "/") return htmlResponse(INDEX_HTML, request, env);
    if (url.pathname === "/api/health") return json({ ok: true, service: "kopaing-edge-terminal-chat" }, 200, corsHeaders(request, env));
    if (url.pathname === "/api/models" && request.method === "GET") return handleModels(request, env);
    if (url.pathname === "/api/chat" && request.method === "POST") return handleChat(request, env);

    return json({ error: "Not found" }, 404, corsHeaders(request, env));
  },
};

async function handleModels(request, env) {
  if (!env.OPEN_ROUTER_API_KEY) {
    return json({ error: "OPEN_ROUTER_API_KEY missing", code: "CONFIG_ERROR" }, 500, corsHeaders(request, env));
  }

  const ttl = Number(env.MODELS_CACHE_TTL_MS || DEFAULT_MODELS_CACHE_TTL_MS);
  const now = Date.now();

  if (modelsCache.data && now - modelsCache.at < ttl) {
    return json({ models: modelsCache.data, cached: true }, 200, corsHeaders(request, env));
  }

  try {
    const res = await fetch(`${env.OPENROUTER_BASE_URL || DEFAULT_BASE}/models`, {
      headers: openRouterHeaders(env),
    });

    if (!res.ok) {
      const fallback = fallbackModels();
      return json({ models: fallback, fallback: true }, 200, corsHeaders(request, env));
    }

    const data = await res.json();
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({ id: m?.id, name: m?.name || m?.id }))
      .filter((m) => m.id);

    if (!models.length) {
      const fallback = fallbackModels();
      return json({ models: fallback, fallback: true }, 200, corsHeaders(request, env));
    }

    modelsCache = { at: now, data: models };
    return json({ models, cached: false }, 200, corsHeaders(request, env));
  } catch (e) {
    console.error("models_error", e?.message || e);
    return json({ models: fallbackModels(), fallback: true, degraded: true }, 200, corsHeaders(request, env));
  }
}

async function handleChat(request, env) {
  if (!env.OPEN_ROUTER_API_KEY) {
    return json({ error: "OPEN_ROUTER_API_KEY missing", code: "CONFIG_ERROR" }, 500, corsHeaders(request, env));
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, corsHeaders(request, env));
  }

  const model = String(body?.model || "").trim();
  const prompt = String(body?.prompt || "").trim();

  if (!model) return json({ error: "model is required" }, 400, corsHeaders(request, env));
  if (!prompt) return json({ error: "prompt is required" }, 400, corsHeaders(request, env));
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} chars` }, 400, corsHeaders(request, env));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("upstream_timeout"), 30000);

  try {
    const upstream = await fetch(`${env.OPENROUTER_BASE_URL || DEFAULT_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        ...openRouterHeaders(env),
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: "system",
            content: "You are Ko Paing style assistant: concise, practical, safe."
          },
          { role: "user", content: prompt }
        ]
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => "");
      console.error("chat_upstream_error", upstream.status, txt.slice(0, 300));
      return json({ error: "upstream error", status: upstream.status }, upstream.status || 502, corsHeaders(request, env));
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...corsHeaders(request, env),
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const timeout = String(e?.message || e).includes("upstream_timeout");
    return json({ error: timeout ? "upstream timeout" : "network failure" }, timeout ? 504 : 502, corsHeaders(request, env));
  }
}

function openRouterHeaders(env) {
  const h = { Authorization: `Bearer ${env.OPEN_ROUTER_API_KEY}` };
  if (env.SITE_URL) h["HTTP-Referer"] = env.SITE_URL;
  if (env.SITE_NAME) h["X-Title"] = env.SITE_NAME;
  return h;
}

function fallbackModels() {
  return [
    { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
    { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
    { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" }
  ];
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "*";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const value = allowed === "*" ? "*" : (origin === allowed ? allowed : "null");
  return {
    "access-control-allow-origin": value,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function htmlResponse(html, request, env) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Ko Paing // Edge Terminal</title>
  <style>
    :root {
      --bg:#030603; --panel:#081008; --text:#7CFF7C; --muted:#46a546; --accent:#00ff66; --err:#ff4d4d;
      --font: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;display:flex;flex-direction:column}
    body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.08;background:repeating-linear-gradient(0deg,#0f0 0 1px,transparent 1px 3px)}
    header{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px;border-bottom:1px solid #154215;background:var(--panel)}
    #terminal{flex:1;overflow:auto;padding:12px;white-space:pre-wrap;word-break:break-word}
    .line{margin:0 0 10px}.u{color:#9cd7ff}.a{color:var(--text)}.e{color:var(--err)}
    .row{display:flex;gap:8px;padding:10px;border-top:1px solid #154215;background:var(--panel)}
    select,textarea,button{background:#000;border:1px solid #1b501b;color:var(--text);font-family:var(--font)}
    textarea{flex:1;min-height:68px;padding:8px} button,select{padding:8px}
    @media (max-width:700px){.row{flex-direction:column}}
  </style>
</head>
<body>
  <header>
    <strong>[ Ko Paing Edge Terminal ]</strong>
    <span id="status" style="color:var(--muted)">loading models...</span>
    <select id="model"></select>
    <button id="reload">Reload</button>
    <button id="clear">Clear</button>
  </header>
  <main id="terminal" role="log" aria-live="polite"></main>
  <div class="row">
    <textarea id="prompt" placeholder="Type prompt... Enter=send, Shift+Enter=newline"></textarea>
    <button id="send">Send</button>
  </div>
<script>
const $ = (id) => document.getElementById(id);
const term=$("terminal"), statusEl=$("status"), modelEl=$("model"), promptEl=$("prompt"), sendBtn=$("send");
function line(cls, txt){const p=document.createElement("p");p.className=`line ${cls}`;p.textContent=txt;term.appendChild(p);term.scrollTop=term.scrollHeight;return p;}
function setStatus(t){statusEl.textContent=t}

async function loadModels(){
  setStatus("loading models...");
  try{
    const res=await fetch('/api/models'); const data=await res.json();
    if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
    modelEl.innerHTML='';
    (data.models||[]).forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=`${m.name} [${m.id}]`;modelEl.appendChild(o);});
    setStatus(data.fallback?"models loaded (fallback)":"models loaded");
  }catch(e){ setStatus('model load error'); line('e',`[ERROR] ${e.message}`); }
}

async function send(){
  const prompt=promptEl.value.trim(); const model=modelEl.value;
  if(!prompt) return;
  if(!model){ line('e','[ERROR] no model selected'); return; }
  line('u',`> ${prompt}`); promptEl.value='';
  const out=line('a','');
  sendBtn.disabled=true;

  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,prompt})});
    if(!res.ok||!res.body){
      const err=await res.json().catch(()=>({})); throw new Error(err.error||`HTTP ${res.status}`);
    }

    const reader=res.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      const events=buf.split('\n\n'); buf=events.pop()||'';
      for(const ev of events){
        const l=ev.split('\n').find(x=>x.startsWith('data: ')); if(!l) continue;
        const d=l.slice(6).trim(); if(d==='[DONE]') continue;
        try{const j=JSON.parse(d); const token=j?.choices?.[0]?.delta?.content||''; if(token) out.textContent+=token;}catch{}
      }
      term.scrollTop=term.scrollHeight;
    }
    setStatus('ready');
  }catch(e){ line('e',`[ERROR] ${e.message}`); setStatus('request failed'); }
  finally{ sendBtn.disabled=false; }
}

$('reload').addEventListener('click', loadModels);
$('clear').addEventListener('click', ()=>term.innerHTML='');
sendBtn.addEventListener('click', send);
promptEl.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
loadModels(); promptEl.focus();
</script>
</body></html>`;

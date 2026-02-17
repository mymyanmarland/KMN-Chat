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
  <title>KMN Chat</title>
  <style>
    :root{--bg:#0f0c08;--panel:#17120c;--line:#6e5a3a;--gold:#d9b46b;--ivory:#f3e6c9;--accent:#f0c674;--err:#ff7a7a;--info:#9bc8ff}
    *{box-sizing:border-box}
    body{margin:0;background:radial-gradient(circle at top,#241a10,#0f0c08 55%);color:var(--ivory);font-family:Georgia,"Times New Roman",serif;letter-spacing:.2px}
    .wrap{max-width:960px;margin:22px auto;padding:14px;border:2px solid var(--line);background:linear-gradient(180deg,rgba(255,220,160,.04),rgba(0,0,0,.08));box-shadow:0 0 0 1px rgba(217,180,107,.2) inset}
    h3{margin:0 0 10px;text-align:center;color:var(--gold);font-weight:700;letter-spacing:1.2px;text-transform:uppercase}
    #status{margin:0 0 10px;padding:6px 8px;border:1px solid var(--line);background:#120e09;color:var(--accent)}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    select,textarea,button{background:#120e09;color:var(--ivory);border:1px solid var(--line);font-family:Georgia,"Times New Roman",serif}
    select,button{padding:8px 10px}
    button{cursor:pointer}
    button:hover{background:#1e1710;border-color:var(--gold)}
    textarea{width:100%;min-height:90px;padding:10px;line-height:1.45}
    #terminal{white-space:pre-wrap;word-break:break-word;min-height:50vh;border:1px solid var(--line);padding:12px;background:repeating-linear-gradient(180deg,#130f0a,#130f0a 30px,#151009 30px,#151009 31px)}
    .u{color:var(--info)}
    .e{color:var(--err)}
  </style>
</head>
<body>
  <div class="wrap">
    <h3>KMN Chat · Art Deco Console</h3>
    <div id="status">loading models...</div>
    <div class="row">
      <select id="model"></select>
      <button id="reload" type="button">Reload Models</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div id="terminal" role="log" aria-live="polite"></div>
    <div class="row" style="margin-top:10px">
      <textarea id="prompt" placeholder="Type prompt... Enter=send, Shift+Enter=newline"></textarea>
    </div>
    <div class="row">
      <button id="send" type="button">Send</button>
    </div>
  </div>
<script>
(function(){
  function $(id){ return document.getElementById(id); }
  var term=$("terminal"), statusEl=$("status"), modelEl=$("model"), promptEl=$("prompt"), sendBtn=$("send");

  function line(cls, txt){
    var p=document.createElement('div');
    p.className=cls||'';
    p.textContent=txt;
    term.appendChild(p);
    term.scrollTop=term.scrollHeight;
    return p;
  }
  function setStatus(t){ statusEl.textContent=t; }

  async function loadModels(){
    setStatus('loading models...');
    try{
      var res=await fetch('/api/models');
      var data=await res.json();
      if(!res.ok) throw new Error(data.error||('HTTP '+res.status));
      modelEl.innerHTML='';
      (data.models||[]).forEach(function(m){
        var o=document.createElement('option');
        o.value=m.id;
        o.textContent=(m.name||m.id)+' ['+m.id+']';
        modelEl.appendChild(o);
      });
      setStatus('ready');
    }catch(e){
      setStatus('model load error');
      line('e','[ERROR] '+e.message);
    }
  }

  async function send(){
    var prompt=(promptEl.value||'').trim();
    var model=(modelEl.value||'').trim();
    if(!prompt) return;
    if(!model){ line('e','[ERROR] no model selected'); return; }

    line('u','> '+prompt);
    promptEl.value='';
    var out=line('', '');
    sendBtn.disabled=true;

    try{
      var res=await fetch('/api/chat',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({model:model,prompt:prompt})
      });

      if(!res.ok || !res.body){
        var err=await res.json().catch(function(){return {};});
        throw new Error(err.error||('HTTP '+res.status));
      }

      var reader=res.body.getReader();
      var dec=new TextDecoder();
      var buf='';
      while(true){
        var r=await reader.read();
        if(r.done) break;
        buf+=dec.decode(r.value,{stream:true});
        var events=buf.split('\\n\\n');
        buf=events.pop()||'';
        for(var i=0;i<events.length;i++){
          var ev=events[i];
          var lines=ev.split('\\n');
          var dataLine='';
          for(var j=0;j<lines.length;j++){
            if(lines[j].indexOf('data: ')===0){ dataLine=lines[j].slice(6).trim(); break; }
          }
          if(!dataLine || dataLine==='[DONE]') continue;
          try{
            var json=JSON.parse(dataLine);
            var token='';
            if(json && json.choices && json.choices[0] && json.choices[0].delta && typeof json.choices[0].delta.content==='string'){
              token=json.choices[0].delta.content;
            }
            if(token) out.textContent+=token;
          }catch(_e){}
        }
        term.scrollTop=term.scrollHeight;
      }
      setStatus('ready');
    }catch(e){
      line('e','[ERROR] '+e.message);
      setStatus('request failed');
    }finally{
      sendBtn.disabled=false;
    }
  }

  $('reload').addEventListener('click', loadModels);
  $('clear').addEventListener('click', function(){ term.innerHTML=''; });
  sendBtn.addEventListener('click', send);
  promptEl.addEventListener('keydown', function(e){
    var isEnter = (e.key==='Enter' || e.keyCode===13 || e.code==='NumpadEnter');
    if(isEnter && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
  });

  loadModels();
  promptEl.focus();
})();
</script>
</body>
</html>`;

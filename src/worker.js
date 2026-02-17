const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS_CACHE_TTL_MS = 300_000;
const MAX_PROMPT_CHARS = 8000;

let modelsCache = { at: 0, data: null };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });

    if (url.pathname === "/") return htmlResponse(INDEX_HTML, request, env);
    if (url.pathname === "/builder") return htmlResponse(BUILDER_HTML, request, env);
    if (url.pathname === "/api/health") return json({ ok: true, service: "kopaing-edge-terminal-chat" }, 200, corsHeaders(request, env));
    if (url.pathname === "/api/models" && request.method === "GET") return handleModels(request, env);
    if (url.pathname === "/api/chat" && request.method === "POST") return handleChat(request, env);
    if (url.pathname === "/api/builder/state" && request.method === "GET") return handleBuilderStateGet(request, env);
    if (url.pathname === "/api/builder/state" && request.method === "POST") return handleBuilderStatePost(request, env);
    if (url.pathname === "/api/memory" && request.method === "GET") return handleMemoryGet(request, env);
    if (url.pathname === "/api/memory" && request.method === "POST") return handleMemoryPost(request, env);
    if (url.pathname === "/api/analytics/event" && request.method === "POST") return handleAnalyticsEventPost(request, env);
    if (url.pathname === "/api/analytics/summary" && request.method === "GET") return handleAnalyticsSummaryGet(request, env);
    if (url.pathname === "/api/automation/trigger" && request.method === "POST") return handleAutomationTrigger(request, env);
    if (url.pathname === "/widget.js" && request.method === "GET") {
      return new Response(WIDGET_JS, { headers: { "content-type": "application/javascript; charset=utf-8", ...corsHeaders(request, env) } });
    }

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
  const persona = String(body?.persona || "default").trim();

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
            content: personaPrompt(persona)
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

async function handleBuilderStateGet(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  }

  const url = new URL(request.url);
  const bot = (url.searchParams.get("bot") || "default").trim();

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/builder_states?bot=eq.${encodeURIComponent(bot)}&select=bot,state_json,updated_at&limit=1`, {
      headers: supabaseHeaders(env),
    });
    const arr = await res.json();
    if (!res.ok) return json({ ok: false, error: arr }, 500, corsHeaders(request, env));
    return json({ ok: true, state: Array.isArray(arr) && arr[0] ? arr[0].state_json : null }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleBuilderStatePost(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400, corsHeaders(request, env));
  }

  const bot = String(body?.bot || "default").trim();
  const state = body?.state;
  if (!bot || !state) return json({ ok: false, error: "bot/state required" }, 400, corsHeaders(request, env));

  try {
    const payload = [{ bot, state_json: state, updated_at: new Date().toISOString() }];
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/builder_states?on_conflict=bot`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: data }, 500, corsHeaders(request, env));
    return json({ ok: true, data }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleMemoryGet(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  const url = new URL(request.url);
  const userId = (url.searchParams.get("userId") || "guest").trim();
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_memory?user_id=eq.${encodeURIComponent(userId)}&select=user_id,memory_json,updated_at&limit=1`, { headers: supabaseHeaders(env) });
    const arr = await res.json();
    if (!res.ok) return json({ ok: false, error: arr }, 500, corsHeaders(request, env));
    return json({ ok: true, memory: Array.isArray(arr) && arr[0] ? arr[0].memory_json : {} }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleMemoryPost(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, corsHeaders(request, env)); }
  const userId = String(body?.userId || "guest").trim();
  const memory = body?.memory || {};
  try {
    const payload = [{ user_id: userId, memory_json: memory, updated_at: new Date().toISOString() }];
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/user_memory?on_conflict=user_id`, {
      method: "POST",
      headers: { ...supabaseHeaders(env), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: data }, 500, corsHeaders(request, env));
    return json({ ok: true, data }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleAnalyticsEventPost(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, corsHeaders(request, env)); }
  const payload = [{
    event_type: String(body?.eventType || 'message').slice(0, 64),
    user_id: String(body?.userId || 'guest').slice(0, 128),
    session_id: String(body?.sessionId || 'session').slice(0, 128),
    node_id: String(body?.nodeId || '').slice(0, 128),
    meta_json: body?.meta || {},
    created_at: new Date().toISOString()
  }];
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/analytics_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return json({ ok: false, error: await res.text() }, 500, corsHeaders(request, env));
    return json({ ok: true }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleAnalyticsSummaryGet(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, code: "SUPABASE_NOT_CONFIGURED" }, 200, corsHeaders(request, env));
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/analytics_events?select=event_type,user_id,node_id,created_at&order=created_at.desc&limit=1000`, { headers: supabaseHeaders(env) });
    const rows = await res.json();
    if (!res.ok) return json({ ok: false, error: rows }, 500, corsHeaders(request, env));
    const events = Array.isArray(rows) ? rows : [];
    const messages = events.filter(r => r.event_type === 'message').length;
    const users = new Set(events.map(r => r.user_id)).size;
    const dropoff = events.filter(r => r.event_type === 'dropoff').length;
    const byNode = {};
    for (const e of events) {
      const k = e.node_id || 'unknown';
      byNode[k] = (byNode[k] || 0) + 1;
    }
    return json({ ok: true, summary: { messages, users, dropoff, byNode } }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

async function handleAutomationTrigger(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400, corsHeaders(request, env)); }
  const text = String(body?.text || '').trim();
  const model = String(body?.model || 'openai/gpt-4o-mini').trim();
  const persona = String(body?.persona || 'support').trim();
  const userId = String(body?.userId || 'automation').trim();
  if (!text) return json({ ok: false, error: 'text required' }, 400, corsHeaders(request, env));
  if (!env.OPEN_ROUTER_API_KEY) return json({ ok: false, error: 'OPEN_ROUTER_API_KEY missing' }, 500, corsHeaders(request, env));

  try {
    const upstream = await fetch(`${env.OPENROUTER_BASE_URL || DEFAULT_BASE}/chat/completions`, {
      method: 'POST',
      headers: { ...openRouterHeaders(env), 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: personaPrompt(persona) },
          { role: 'user', content: text }
        ]
      })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json({ ok: false, error: data }, upstream.status || 500, corsHeaders(request, env));
    const answer = data?.choices?.[0]?.message?.content || '';

    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/analytics_events`, {
        method: 'POST',
        headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
        body: JSON.stringify([{ event_type: 'automation', user_id: userId, session_id: 'automation', node_id: 'webhook', meta_json: { textLen: text.length, model, persona }, created_at: new Date().toISOString() }])
      }).catch(() => {});
    }

    return json({ ok: true, output: answer }, 200, corsHeaders(request, env));
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(request, env));
  }
}

function openRouterHeaders(env) {
  const h = { Authorization: `Bearer ${env.OPEN_ROUTER_API_KEY}` };
  if (env.SITE_URL) h["HTTP-Referer"] = env.SITE_URL;
  if (env.SITE_NAME) h["X-Title"] = env.SITE_NAME;
  return h;
}

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    "content-type": "application/json",
  };
}

function fallbackModels() {
  return [
    { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
    { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
    { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" }
  ];
}

function personaPrompt(persona) {
  const p = (persona || 'default').toLowerCase();
  if (p === 'sales') return 'You are a sales assistant. Be persuasive, concise, and CTA-driven while staying honest.';
  if (p === 'tutor') return 'You are a tutor. Explain step-by-step, ask check questions, and adapt to learner level.';
  if (p === 'support') return 'You are a customer support agent. Be calm, precise, and solution-first.';
  return 'You are Ko Paing style assistant: concise, practical, safe.';
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
    :root{--bg:#0b1220;--bg2:#111a2e;--glass:rgba(255,255,255,.10);--glass-strong:rgba(255,255,255,.16);--line:rgba(255,255,255,.22);--text:#eef4ff;--muted:#b9c7e6;--accent:#7dd3fc;--accent2:#a78bfa;--err:#ff9aa6;--info:#9fe7ff}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.2px;background:radial-gradient(1200px 600px at 10% -10%,#233a66 0%,transparent 45%),radial-gradient(900px 500px at 90% 0%,#3d2a69 0%,transparent 40%),linear-gradient(135deg,var(--bg),var(--bg2));}
    .wrap{max-width:980px;margin:20px auto;padding:14px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,var(--glass),rgba(255,255,255,.06));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 12px 40px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.16)}
    h3{margin:0 0 10px;text-align:center;color:var(--text);font-weight:800;letter-spacing:.6px}
    #status{margin:0 0 10px;padding:9px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.08);color:var(--muted)}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    select,textarea,button{background:rgba(15,23,42,.55);color:var(--text);border:1px solid var(--line);border-radius:12px;font-family:inherit}
    select,button{padding:10px 12px}
    button{cursor:pointer;transition:.18s transform,.18s background,.18s border-color}
    button:hover{transform:translateY(-1px);background:rgba(125,211,252,.16);border-color:var(--accent)}
    textarea{width:100%;min-height:110px;padding:12px;line-height:1.55}
    #terminal{white-space:pre-wrap;word-break:break-word;min-height:52vh;border:1px solid var(--line);border-radius:14px;padding:12px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03))}
    .u{color:var(--info)}
    .e{color:var(--err)}
  </style>
</head>
<body>
  <div class="wrap">
    <h3>KMN Chat · Glass Console</h3>
    <div id="status">loading models...</div>
    <div class="row">
      <select id="model"></select>
      <select id="persona">
        <option value="default">Persona: Default</option>
        <option value="sales">Persona: Sales</option>
        <option value="tutor">Persona: Tutor</option>
        <option value="support">Persona: Support</option>
      </select>
      <button id="reload" type="button">Reload Models</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div id="terminal" role="log" aria-live="polite"></div>
    <div class="row" style="margin-top:10px">
      <textarea id="prompt" placeholder="Type prompt... Enter=send, Shift+Enter=newline"></textarea>
    </div>
    <div class="row">
      <button id="send" type="button">Send</button>
      <button id="mic" type="button">🎙️ Voice Input</button>
      <button id="speak" type="button">🔊 Speak Last Reply</button>
    </div>
  </div>
<script>
(function(){
  function $(id){ return document.getElementById(id); }
  var term=$("terminal"), statusEl=$("status"), modelEl=$("model"), personaEl=$("persona"), promptEl=$("prompt"), sendBtn=$("send"), micBtn=$("mic"), speakBtn=$("speak");
  var lastReply='';

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
      var persona=(personaEl && personaEl.value) ? personaEl.value : 'default';
      var res=await fetch('/api/chat',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({model:model,prompt:prompt,persona:persona})
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
      lastReply = out.textContent || '';
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
  if(micBtn){
    micBtn.addEventListener('click', function(){
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if(!SR){ alert('Speech recognition not supported on this browser'); return; }
      var rec = new SR();
      rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
      setStatus('listening...');
      rec.onresult = function(ev){
        var t = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
        if(t){ promptEl.value = (promptEl.value ? (promptEl.value+' ') : '') + t; }
        setStatus('ready');
      };
      rec.onerror = function(){ setStatus('voice error'); };
      rec.onend = function(){ if(statusEl.textContent==='listening...') setStatus('ready'); };
      rec.start();
    });
  }
  if(speakBtn){
    speakBtn.addEventListener('click', function(){
      if(!lastReply){ alert('No reply yet'); return; }
      if(!window.speechSynthesis){ alert('TTS not supported'); return; }
      var u = new SpeechSynthesisUtterance(lastReply);
      u.rate = 1; u.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  }
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

const BUILDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>KMN Chat Builder</title>
  <style>
    :root{--bg:#111;--card:#1a1a1a;--line:#333;--text:#f2e4c8;--gold:#d8b46a;--muted:#b6a27a;--ok:#84d39a;--err:#ff8f8f}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}
    .top{padding:12px;border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    h1{font-size:18px;margin:0;color:var(--gold)}
    .grid{display:grid;grid-template-columns:280px 1fr 320px;gap:12px;padding:12px}
    .card{background:var(--card);border:1px solid var(--line);padding:10px;border-radius:10px}
    .title{font-weight:700;margin-bottom:8px;color:var(--gold)}
    input,select,textarea,button{width:100%;background:#121212;color:var(--text);border:1px solid #3b3b3b;border-radius:8px;padding:8px;margin-top:6px}
    button{cursor:pointer}
    .row{display:flex;gap:8px}.row>*{flex:1}
    #nodes{list-style:none;padding:0;margin:0;max-height:52vh;overflow:auto}
    #nodes li{padding:8px;border:1px solid #3d3d3d;border-radius:8px;margin-bottom:6px;cursor:move;background:#151515}
    #canvas{min-height:52vh;max-height:52vh;overflow:auto;border:1px dashed #50432a;padding:8px;border-radius:8px}
    .tag{display:inline-block;padding:2px 8px;border:1px solid #5c4c2f;border-radius:999px;font-size:12px;color:var(--muted)}
    #log{min-height:180px;max-height:180px;overflow:auto;white-space:pre-wrap;border:1px solid #3b3b3b;padding:8px;border-radius:8px;background:#101010}
    .ok{color:var(--ok)}.err{color:var(--err)}
    @media (max-width:1100px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="top">
    <h1>KMN Chat Builder · Art Deco Admin</h1>
    <span class="tag">Flow Builder</span>
    <span class="tag">AI + KB + Analytics</span>
    <div style="margin-left:auto;display:flex;gap:8px">
      <select id="lang" style="width:auto"><option value="en">English</option><option value="my">မြန်မာ</option></select>
      <button id="saveBtn" style="width:auto">Save Bot</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="title">Admin Dashboard</div>
      <label>Bot Name<input id="botName" placeholder="Sales Assistant" /></label>
      <label>Template<select id="templateSel"><option value="blank">Blank</option><option value="faq">FAQ Bot</option><option value="lead">Lead Capture</option></select></label>
      <button id="applyTemplate">Apply Template</button>
      <hr style="border-color:#2d2d2d" />
      <div class="title">Node Toolbox</div>
      <select id="nodeType">
        <option value="text">Text</option>
        <option value="buttons">Buttons</option>
        <option value="quick_replies">Quick Replies</option>
        <option value="carousel">Carousel</option>
        <option value="condition">Condition</option>
        <option value="ai">AI Response</option>
      </select>
      <button id="addNode">Add Node</button>
      <ul id="nodes"></ul>
    </div>

    <div class="card">
      <div class="title">Visual Conversation Flow (Drag & Drop)</div>
      <div id="canvas"></div>
      <div class="row" style="margin-top:8px">
        <button id="testRun">Run Test</button>
        <button id="clearHistory">Clear History</button>
      </div>
      <div class="title" style="margin-top:10px">Testing Playground</div>
      <div class="row">
        <input id="testInput" placeholder="User input" />
        <button id="sendTest" style="max-width:130px">Send</button>
      </div>
      <div id="log"></div>
    </div>

    <div class="card">
      <div class="title">AI + KB + Widget</div>
      <label>Model<select id="modelSelect"></select></label>
      <label>Knowledge Base Upload<input type="file" id="kbFile" multiple /></label>
      <textarea id="kbPreview" placeholder="KB preview" style="min-height:90px"></textarea>
      <label>Widget Primary Color<input id="wColor" value="#d8b46a" /></label>
      <label>Avatar URL<input id="wAvatar" placeholder="https://..." /></label>
      <label>Position<select id="wPos"><option>bottom-right</option><option>bottom-left</option></select></label>
      <button id="genEmbed">Generate Embed Code</button>
      <textarea id="embedOut" style="min-height:100px"></textarea>
      <div class="title" style="margin-top:8px">Variables & User Context</div>
      <textarea id="vars" placeholder='{"name":"User"}' style="min-height:80px"></textarea>
      <div class="title" style="margin-top:8px">Analytics</div>
      <div id="stats">messages: 0 · users: 0 · drop-off: 0</div>
      <div class="title" style="margin-top:8px">Conversation History</div>
      <textarea id="history" style="min-height:100px"></textarea>
    </div>
  </div>

<script>
(function(){
  var SKEY='kmn_builder_state_v1';
  var AKEY='kmn_builder_analytics_v1';
  function $(id){return document.getElementById(id)}
  var state={botName:'KMN Bot',nodes:[],vars:{},kb:'',history:[]};
  var dragIndex=-1;

  function uid(){return 'n'+Math.random().toString(36).slice(2,8)}
  function currentBot(){ return ($('botName').value||state.botName||'KMN Bot').trim() || 'KMN Bot'; }
  function saveLocal(){ localStorage.setItem(SKEY, JSON.stringify(state)); }
  async function saveRemote(){
    try{
      var res = await fetch('/api/builder/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bot:currentBot(),state:state})});
      var data = await res.json().catch(function(){return {};});
      return !!(res.ok && data && data.ok);
    }catch(e){ return false; }
  }
  async function save(){
    saveLocal();
    return await saveRemote();
  }
  function loadLocal(){
    try{ var raw=localStorage.getItem(SKEY); if(raw) state=JSON.parse(raw); }catch(e){}
    if(!state.nodes||!state.nodes.length){ state.nodes=[{id:uid(),type:'text',content:'Welcome! How can I help?'}]; }
  }
  async function loadRemote(){
    try{
      var res = await fetch('/api/builder/state?bot='+encodeURIComponent(currentBot()));
      var data = await res.json().catch(function(){return {};});
      if(res.ok && data && data.ok && data.state){ state = data.state; return true; }
    }catch(e){}
    return false;
  }
  function analytics(){
    var a={messages:0,users:1,dropoff:0};
    try{ a=JSON.parse(localStorage.getItem(AKEY)||'{"messages":0,"users":1,"dropoff":0}'); }catch(e){}
    return a;
  }
  function setAnalytics(a){ localStorage.setItem(AKEY, JSON.stringify(a)); $('stats').textContent='messages: '+a.messages+' · users: '+a.users+' · drop-off: '+a.dropoff; }
  async function postEvent(eventType, nodeId, meta){
    try{ await fetch('/api/analytics/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventType:eventType,userId:'builder-admin',sessionId:'builder',nodeId:nodeId||'',meta:meta||{}})}); }catch(e){}
  }
  async function refreshAnalytics(){
    try{
      var r=await fetch('/api/analytics/summary');
      var j=await r.json().catch(function(){return {};});
      if(r.ok && j && j.ok && j.summary){
        $('stats').textContent='messages: '+j.summary.messages+' · users: '+j.summary.users+' · drop-off: '+j.summary.dropoff;
        return;
      }
    }catch(e){}
    setAnalytics(analytics());
  }

  function renderNodes(){
    var ul=$('nodes'); ul.innerHTML='';
    state.nodes.forEach(function(n,i){
      var li=document.createElement('li'); li.draggable=true; li.dataset.i=i;
      li.textContent=(i+1)+'. ['+n.type+'] '+(n.content||n.label||'');
      li.addEventListener('dragstart',function(){dragIndex=i});
      li.addEventListener('dragover',function(e){e.preventDefault()});
      li.addEventListener('drop',function(e){e.preventDefault(); var to=i; if(dragIndex<0||dragIndex===to) return; var moved=state.nodes.splice(dragIndex,1)[0]; state.nodes.splice(to,0,moved); dragIndex=-1; save(); renderNodes(); renderCanvas();});
      li.addEventListener('click',function(){editNode(i)});
      ul.appendChild(li);
    });
  }

  function renderCanvas(){
    var c=$('canvas'); c.innerHTML='';
    state.nodes.forEach(function(n,i){
      var box=document.createElement('div'); box.className='card'; box.style.margin='0 0 8px 0'; box.style.padding='8px';
      box.innerHTML='<b>'+(i+1)+'. '+n.type+'</b><div>'+escapeHtml(n.content||n.label||'')+'</div>';
      c.appendChild(box);
    });
  }

  function editNode(i){
    var n=state.nodes[i];
    var content=prompt('Edit node content', n.content||'');
    if(content===null) return;
    n.content=content;
    if(n.type==='condition'){
      n.conditionVar=prompt('Condition variable name', n.conditionVar||'intent')||'intent';
      n.conditionValue=prompt('Condition expected value', n.conditionValue||'yes')||'yes';
      n.nextNodeId=prompt('Next node id if matched', n.nextNodeId||'')||'';
    }
    save(); renderNodes(); renderCanvas();
  }

  function addNode(){
    var t=$('nodeType').value;
    var n={id:uid(),type:t,content:''};
    if(t==='buttons'||t==='quick_replies') n.content='Option 1 | Option 2';
    if(t==='carousel') n.content='Card1 | Card2 | Card3';
    if(t==='ai') n.content='AI dynamic response';
    if(t==='condition'){ n.content='Branch condition'; n.conditionVar='intent'; n.conditionValue='yes'; }
    state.nodes.push(n); save(); renderNodes(); renderCanvas();
  }

  function log(msg, cls){ var d=document.createElement('div'); d.className=cls||''; d.textContent=msg; $('log').appendChild(d); $('log').scrollTop=$('log').scrollHeight; }

  async function loadModels(){
    try{
      var res=await fetch('/api/models'); var data=await res.json();
      var sel=$('modelSelect'); sel.innerHTML='';
      (data.models||[]).slice(0,80).forEach(function(m){ var o=document.createElement('option'); o.value=m.id; o.textContent=m.id; sel.appendChild(o); });
    }catch(e){ log('Model load failed: '+e.message,'err'); }
  }

  async function aiReply(userText){
    var model=$('modelSelect').value;
    var res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:model,prompt:userText})});
    if(!res.ok||!res.body){ throw new Error('AI request failed'); }
    var reader=res.body.getReader(); var dec=new TextDecoder(); var buf=''; var out='';
    while(true){
      var r=await reader.read(); if(r.done) break;
      buf+=dec.decode(r.value,{stream:true});
      var events=buf.split('\\n\\n'); buf=events.pop()||'';
      for(var i=0;i<events.length;i++){
        var ev=events[i]; var lines=ev.split('\\n'); var dataLine='';
        for(var j=0;j<lines.length;j++){ if(lines[j].indexOf('data: ')===0){ dataLine=lines[j].slice(6).trim(); break; } }
        if(!dataLine || dataLine==='[DONE]') continue;
        try{ var x=JSON.parse(dataLine); var t=''; if(x&&x.choices&&x.choices[0]&&x.choices[0].delta&&typeof x.choices[0].delta.content==='string') t=x.choices[0].delta.content; if(t) out+=t; }catch(_e){}
      }
    }
    return out;
  }

  function runFlow(input){
    var vars={};
    try{ vars=JSON.parse($('vars').value||'{}'); }catch(e){}
    var out='';
    for(var i=0;i<state.nodes.length;i++){
      var n=state.nodes[i];
      if(n.type==='condition'){
        if(String(vars[n.conditionVar]||input).toLowerCase()!==String(n.conditionValue||'').toLowerCase()) continue;
      }
      out += '['+n.type+'] '+(n.content||'')+'\\n';
    }
    return out.trim();
  }

  function escapeHtml(s){return String(s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]})}

  $('addNode').addEventListener('click', addNode);
  $('saveBtn').addEventListener('click', async function(){ state.botName=$('botName').value||'KMN Bot'; var ok=await save(); log(ok?('Saved bot: '+state.botName+' (Supabase)'):('Saved locally (Supabase not ready)'), ok?'ok':'err'); });
  $('testRun').addEventListener('click', async function(){ var o=runFlow($('testInput').value||''); log('FLOW:\\n'+o,'ok'); var a=analytics(); a.messages+=1; setAnalytics(a); await postEvent('message','flow-test',{len:o.length}); state.history.push('FLOW>> '+o); $('history').value=state.history.join('\\n'); save(); refreshAnalytics(); });
  $('sendTest').addEventListener('click', async function(){
    try{
      var text=$('testInput').value||''; if(!text) return;
      log('USER: '+text,'');
      var flow=runFlow(text); if(flow) log('BOT(flow): '+flow,'ok');
      var ai=await aiReply(text+'\\nContext:\\n'+flow+'\\nKB:\\n'+(state.kb||''));
      log('BOT(ai): '+ai,'ok');
      var a=analytics(); a.messages+=2; setAnalytics(a);
      await postEvent('message','send-test',{textLen:text.length});
      state.history.push('U: '+text); state.history.push('B: '+ai); $('history').value=state.history.join('\\n'); save(); refreshAnalytics();
    }catch(e){ log('Error: '+e.message,'err'); var a=analytics(); a.dropoff+=1; setAnalytics(a); await postEvent('dropoff','send-test',{error:String(e&&e.message||e)}); refreshAnalytics(); }
  });

  $('clearHistory').addEventListener('click', function(){ state.history=[]; $('history').value=''; save(); log('history cleared','ok'); });
  $('kbFile').addEventListener('change', function(e){
    var files=e.target.files||[]; if(!files.length) return;
    var remain=files.length; var merged=[];
    for(var i=0;i<files.length;i++){
      (function(f){ var r=new FileReader(); r.onload=function(){ merged.push('## '+f.name+'\\n'+String(r.result||'')); remain--; if(remain===0){ state.kb=merged.join('\\n\\n'); $('kbPreview').value=state.kb.slice(0,4000); save(); log('KB uploaded: '+files.length+' files','ok'); } }; r.readAsText(f); })(files[i]);
    }
  });

  $('genEmbed').addEventListener('click', function(){
    var cfg={color:$('wColor').value,avatar:$('wAvatar').value,position:$('wPos').value,bot:state.botName};
    var code='<script src="https://kmnchat.mymyanmarland.workers.dev/widget.js" data-bot="'+cfg.bot+'" data-color="'+cfg.color+'" data-avatar="'+cfg.avatar+'" data-position="'+cfg.position+'"><\\/script>';
    $('embedOut').value=code;
  });

  $('applyTemplate').addEventListener('click', function(){
    var t=$('templateSel').value;
    if(t==='faq') state.nodes=[{id:uid(),type:'text',content:'Hello! Ask me anything about pricing or hours.'},{id:uid(),type:'quick_replies',content:'Pricing | Hours | Contact'},{id:uid(),type:'ai',content:'AI fallback'}];
    else if(t==='lead') state.nodes=[{id:uid(),type:'text',content:'Hi! Can I get your name?'},{id:uid(),type:'buttons',content:'Yes | Later'},{id:uid(),type:'condition',content:'if yes go next',conditionVar:'intent',conditionValue:'yes'}];
    else state.nodes=[{id:uid(),type:'text',content:'Welcome! How can I help?'}];
    save(); renderNodes(); renderCanvas(); log('Template applied: '+t,'ok');
  });

  $('lang').addEventListener('change', function(){
    var my=this.value==='my';
    document.title=my?'KMN ချတ်တည်ဆောက်မှု':'KMN Chat Builder';
    $('saveBtn').textContent=my?'သိမ်းမယ်':'Save Bot';
    $('addNode').textContent=my?'Node ထည့်မယ်':'Add Node';
    $('testRun').textContent=my?'စမ်းမယ်':'Run Test';
    $('sendTest').textContent=my?'ပို့မယ်':'Send';
  });

  (async function init(){
    loadLocal();
    $('botName').value=state.botName||'KMN Bot';
    var remoteLoaded = await loadRemote();
    if(remoteLoaded){ log('Loaded bot state from Supabase','ok'); }
    $('botName').value=state.botName||$('botName').value||'KMN Bot';
    $('kbPreview').value=state.kb||'';
    $('history').value=(state.history||[]).join('\\n');
    $('vars').value=JSON.stringify(state.vars||{name:'Guest'},null,2);
    await refreshAnalytics();
    renderNodes();
    renderCanvas();
    loadModels();
  })();
})();
</script>
</body>
</html>`;

const WIDGET_JS = `(function(){
  var s=document.currentScript||{};
  var host=(s.src||'').split('/widget.js')[0]||location.origin;
  var color=s.getAttribute('data-color')||'#d8b46a';
  var pos=s.getAttribute('data-position')||'bottom-right';
  var bot=s.getAttribute('data-bot')||'KMN Bot';
  var userId=localStorage.getItem('kmn_widget_user')||('u_'+Math.random().toString(36).slice(2,10));
  localStorage.setItem('kmn_widget_user',userId);

  var wrap=document.createElement('div');
  wrap.style.position='fixed'; wrap.style.zIndex='999999'; wrap.style[pos.indexOf('left')>-1?'left':'right']='16px'; wrap.style.bottom='16px';
  var btn=document.createElement('button');
  btn.textContent='💬 '+bot; btn.style.background=color; btn.style.color='#111'; btn.style.border='0'; btn.style.padding='10px 12px'; btn.style.borderRadius='999px'; btn.style.cursor='pointer';
  var panel=document.createElement('div');
  panel.style.display='none'; panel.style.width='320px'; panel.style.height='420px'; panel.style.background='#111'; panel.style.color='#f3e6c9'; panel.style.border='1px solid #6e5a3a'; panel.style.borderRadius='12px'; panel.style.padding='8px'; panel.style.marginTop='8px';
  panel.innerHTML='<div style="font-weight:bold;color:'+color+';margin-bottom:6px">'+bot+'</div><div id="kmn_log" style="height:310px;overflow:auto;border:1px solid #333;padding:6px"></div><div style="display:flex;gap:6px;margin-top:6px"><input id="kmn_in" style="flex:1;background:#1a1a1a;color:#f3e6c9;border:1px solid #333;padding:8px" placeholder="Type..."/><button id="kmn_send" style="background:'+color+';border:0;padding:8px 10px">Send</button></div>';
  wrap.appendChild(btn); wrap.appendChild(panel); document.body.appendChild(wrap);

  function log(t,c){ var d=document.createElement('div'); d.textContent=t; if(c) d.style.color=c; var l=panel.querySelector('#kmn_log'); l.appendChild(d); l.scrollTop=l.scrollHeight; }

  async function loadMemory(){
    try{ var r=await fetch(host+'/api/memory?userId='+encodeURIComponent(userId)); var j=await r.json(); return j.memory||{}; }catch(e){ return {}; }
  }
  async function saveMemory(m){
    try{ await fetch(host+'/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:userId,memory:m})}); }catch(e){}
  }

  async function send(){
    var input=panel.querySelector('#kmn_in');
    var text=(input.value||'').trim(); if(!text) return; input.value=''; log('You: '+text,'#9bc8ff');
    var mem=await loadMemory();
    if(text.toLowerCase().indexOf('my name is')===0){ mem.name=text.slice(10).trim(); await saveMemory(mem); }
    var prompt='User memory: '+JSON.stringify(mem)+'\\nUser: '+text;
    var model='openai/gpt-4o-mini';
    var res=await fetch(host+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:model,prompt:prompt})});
    if(!res.ok||!res.body){ log('Bot: error','#ff8f8f'); return; }
    var reader=res.body.getReader(), dec=new TextDecoder(), buf='', out='';
    while(true){ var rr=await reader.read(); if(rr.done) break; buf+=dec.decode(rr.value,{stream:true}); var evs=buf.split('\\n\\n'); buf=evs.pop()||''; for(var i=0;i<evs.length;i++){ var line=(evs[i].split('\\n').find(function(x){return x.indexOf('data: ')===0;})||'').slice(6).trim(); if(!line||line==='[DONE]') continue; try{ var j=JSON.parse(line); var t=(j&&j.choices&&j.choices[0]&&j.choices[0].delta&&typeof j.choices[0].delta.content==='string')?j.choices[0].delta.content:''; if(t) out+=t; }catch(e){} } }
    log('Bot: '+out,'#f3e6c9');
  }

  btn.onclick=function(){ panel.style.display=panel.style.display==='none'?'block':'none'; };
  panel.querySelector('#kmn_send').onclick=send;
  panel.querySelector('#kmn_in').addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); }});
})();`;

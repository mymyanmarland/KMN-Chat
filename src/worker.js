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
  $('testRun').addEventListener('click', function(){ var o=runFlow($('testInput').value||''); log('FLOW:\\n'+o,'ok'); var a=analytics(); a.messages+=1; setAnalytics(a); state.history.push('FLOW>> '+o); $('history').value=state.history.join('\\n'); save(); });
  $('sendTest').addEventListener('click', async function(){
    try{
      var text=$('testInput').value||''; if(!text) return;
      log('USER: '+text,'');
      var flow=runFlow(text); if(flow) log('BOT(flow): '+flow,'ok');
      var ai=await aiReply(text+'\\nContext:\\n'+flow+'\\nKB:\\n'+(state.kb||''));
      log('BOT(ai): '+ai,'ok');
      var a=analytics(); a.messages+=2; setAnalytics(a);
      state.history.push('U: '+text); state.history.push('B: '+ai); $('history').value=state.history.join('\\n'); save();
    }catch(e){ log('Error: '+e.message,'err'); var a=analytics(); a.dropoff+=1; setAnalytics(a); }
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
    setAnalytics(analytics());
    renderNodes();
    renderCanvas();
    loadModels();
  })();
})();
</script>
</body>
</html>`;

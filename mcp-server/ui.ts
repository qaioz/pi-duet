// The MCP App views (MCP Apps extension, "io.modelcontextprotocol/ui", spec 2026-01-26) that chat apps
// (claude.ai, Cowork, ChatGPT, VS Code…) draw inside the conversation:
//
//   ui://duet/room  from open_room. One view, three display modes:
//                   inline     a card: the room, who's in it, the last lines, requests (Ignore / Answer)
//                   pip        the dock: one strip that floats while you work (room · faces · last line · unread)
//                   fullscreen the room: the conversation, members by owner, "Ask my AI to draft"
//   ui://duet/send  from draft_reply. The reply card: the whole text, Edit / Don't send / Send. Nothing
//                   reaches the room without the Send click (send_draft, a tool only the view can call).
//
// The view keeps itself current by calling room_state every few seconds (no model turn). "Answer" and
// "Ask my AI to draft" use ui/message: they post a message in the chat as the user, which starts a turn.
// Everything is inline (the host's default CSP allows no outside requests); the look is chat-lab's ui2.
import { CLAUDE, MARK } from "./ui-icons.ts";

export const UI_MIME = "text/html;profile=mcp-app";
export const ROOM_URI = "ui://duet/room";
export const SEND_URI = "ui://duet/send";

const CSS = `
:root { --accent:#2f6bff; --label:rgb(22 26 40); --label-2:rgb(22 26 40/.62); --label-3:rgb(22 26 40/.42); --sep:rgb(22 26 40/.08);
  --fill:rgb(22 26 40/.05); --fill-2:rgb(22 26 40/.09); --bg:#f3f4f8; --surface:#fff; --ring:#fff; --ok:#1f8a4c; --online:#30c46c;
  --spring:cubic-bezier(.34,1.22,.64,1); color-scheme: light; }
:root[data-theme=dark] { --label:rgb(236 238 245); --label-2:rgb(236 238 245/.66); --label-3:rgb(236 238 245/.44); --sep:rgb(255 255 255/.09);
  --fill:rgb(255 255 255/.06); --fill-2:rgb(255 255 255/.11); --bg:#0e1016; --surface:#1c1f2b; --ring:#1c1f2b; --ok:#4ad38a; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--label); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; }
.tint, .gray { border: 0; border-radius: 999px; height: 34px; padding: 0 15px; font-weight: 600; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: transform .26s var(--spring), opacity .2s; }
.tint { background: var(--accent); color: #fff; } .gray { background: var(--fill-2); color: var(--label); }
.tint:active, .gray:active { transform: scale(.96); } .tint:disabled, .gray:disabled { opacity: .5; cursor: default; }
.icon { width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--fill-2); color: var(--label); display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; }
.icon svg { width: 15px; height: 15px; }
.av { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 600; font-size: 12px; flex: none; position: relative; background: linear-gradient(140deg,#5b8cff,#6d5cf6); }
.av.p1 { background: linear-gradient(140deg,#2bc48a,#16a37f); } .av.p2 { background: linear-gradient(140deg,#f59e5b,#e5603d); } .av.p3 { background: linear-gradient(140deg,#c06cf0,#8b5cf6); }
.av.bot { background: #fff; box-shadow: inset 0 0 0 1px rgb(0 0 0/.06); } .av.bot svg { width: 58%; height: 58%; }
.av .own { position: absolute; right: -3px; bottom: -3px; width: 13px; height: 13px; border-radius: 50%; font-size: 8px; display: grid; place-items: center; color: #fff; border: 2px solid var(--ring); background: linear-gradient(140deg,#5b8cff,#6d5cf6); }
.mark svg { width: 24px; height: 19px; display: block; }
.muted { color: var(--label-3); }
.cap { font-size: 12px; font-weight: 600; color: var(--label-3); letter-spacing: .02em; }
`;

// The bridge to the host: JSON-RPC 2.0 over postMessage (MCP Apps). Shared by both views.
const BRIDGE = `
const H = { id: 0, wait: new Map(), on: {} };
const post = (m) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
function rpc(method, params, ms = 30000) { const id = ++H.id; post({ id, method, params }); return new Promise((ok, no) => { const t = setTimeout(() => { H.wait.delete(id); no(new Error(method + " timed out")); }, ms); H.wait.set(id, { ok: (r) => { clearTimeout(t); ok(r); }, no: (e) => { clearTimeout(t); no(e); } }); }); }
window.addEventListener("message", (ev) => { const m = ev.data; if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && !m.method) { const w = H.wait.get(m.id); if (w) { H.wait.delete(m.id); m.error ? w.no(Object.assign(new Error(m.error.message || "error"), m.error)) : w.ok(m.result); } return; }
  if (m.method === "ui/resource-teardown") { if (H.on.teardown) H.on.teardown(); if (m.id !== undefined) post({ id: m.id, result: {} }); return; }
  if (m.method === "ui/notifications/host-context-changed") applyContext(m.params || {});
  const f = H.on[m.method]; if (f) f(m.params || {}); if (m.id !== undefined && !f) post({ id: m.id, result: {} }); });
let ctx = {};
function applyContext(c) { ctx = Object.assign(ctx, c); if (c.theme) document.documentElement.dataset.theme = c.theme;
  if (c.displayMode) { document.body.dataset.mode = c.displayMode; if (H.on.mode) H.on.mode(c.displayMode); } }
let lastH = 0; function size() { const h = Math.ceil(document.documentElement.scrollHeight); if (h !== lastH) { lastH = h; post({ method: "ui/notifications/size-changed", params: { width: Math.ceil(document.documentElement.scrollWidth), height: h } }); } }
new ResizeObserver(size).observe(document.documentElement);
async function connect(name) { try { const r = await rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name, version: "0.1.0" }, appCapabilities: { availableDisplayModes: ["inline", "pip", "fullscreen"] } }, 8000);
    applyContext(Object.assign({ displayMode: "inline" }, (r && r.hostContext) || {})); } catch (e) { applyContext({ displayMode: "inline" }); }
  post({ method: "ui/notifications/initialized", params: {} }); size(); }
const call = (name, args) => rpc("tools/call", { name, arguments: args || {} });
const say = (text) => rpc("ui/message", { role: "user", content: { type: "text", text } });
async function mode(m) { try { const r = await rpc("ui/request-display-mode", { mode: m }, 5000); if (r && r.mode) applyContext({ displayMode: r.mode }); return r && r.mode; } catch { return null; } }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + " min" : s < 86400 ? Math.floor(s / 3600) + " h" : new Date(ts).toLocaleDateString(); };
const CLAUDE = ${JSON.stringify(CLAUDE)}, MARK = ${JSON.stringify(MARK)};
const hue = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ["", "p1", "p2", "p3"][h % 4]; };
function av(m) { if (m.agent) return '<span class="av bot">' + CLAUDE + (m.ownerName ? '<span class="own">' + esc(m.ownerName[0].toUpperCase()) + "</span>" : "") + "</span>";
  return '<span class="av ' + hue(m.id) + '">' + esc((m.name || "?")[0].toUpperCase()) + "</span>"; }
`;

const ICON = {
	expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
	pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><rect x="12" y="12" width="7" height="6" rx="1.5"/></svg>',
	close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

export const ROOM_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}
body { padding: 2px; }
.hd { display: flex; align-items: center; gap: 10px; }
.hd .room { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.faces { display: flex; align-items: center; gap: 8px; }
.faces .g { display: flex; } .faces .g .av { width: 24px; height: 24px; font-size: 10px; margin-left: -7px; box-shadow: 0 0 0 2px var(--ring); }
.faces .g .av:first-child { margin-left: 0; } .faces .g .av .own { display: none; }
.sp { flex: 1; min-width: 0; }
.badge { min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; display: grid; place-items: center; }
.badge[hidden] { display: none; }
.vsep { width: 1px; height: 18px; background: var(--sep); flex: none; }
/* inline: a card */
.card { border-radius: 22px; background: var(--fill); border: 1px solid var(--sep); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.lines { display: flex; flex-direction: column; gap: 10px; }
.line { display: flex; gap: 10px; align-items: flex-start; }
.line .tx { min-width: 0; font-size: 14.5px; line-height: 1.45; overflow-wrap: anywhere; }
.line .tx small { display: block; font-size: 12px; font-weight: 600; color: var(--label-3); }
.line .tx small i { font-style: normal; font-weight: 500; }
.req { border-radius: 18px; background: var(--surface); border: 1px solid var(--sep); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.req .who { font-size: 13.5px; color: var(--label-2); display: flex; gap: 8px; align-items: center; } .req .who b { color: var(--label); }
.req .q { font-size: 15px; line-height: 1.45; overflow-wrap: anywhere; }
.acts { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.empty { font-size: 14px; color: var(--label-3); text-align: center; padding: 8px; }
.foot { display: flex; gap: 8px; justify-content: flex-end; }
/* pip: the dock */
.dock { display: none; align-items: center; gap: 10px; padding: 6px 6px 6px 10px; border-radius: 20px; background: var(--surface); border: 1px solid var(--sep); cursor: pointer; }
.dock .last { flex: 1; min-width: 0; font-size: 14px; color: var(--label-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .dock .last b { color: var(--label); }
/* fullscreen: the room */
.full { display: none; height: 100vh; grid-template-columns: minmax(0, 1fr) 260px; grid-template-rows: auto minmax(0, 1fr) auto; background: var(--bg); }
.full .top { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--sep); }
.full .top b { flex: 1; font-size: 17px; }
.full .feed { overflow-y: auto; padding: 16px 24px; } .full .feed .lines { max-width: 720px; margin: 0 auto; gap: 14px; }
.full .feed .line .av { width: 32px; height: 32px; font-size: 13px; } .full .feed .line .tx { font-size: 15px; }
.full .side { grid-row: 2 / 4; grid-column: 2; border-left: 1px solid var(--sep); padding: 14px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.mrow { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 10px; font-size: 14px; }
.mrow.agent { padding-left: 28px; } .mrow.agent .av { width: 24px; height: 24px; }
.mrow .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrow .tag { font-size: 11px; color: var(--label-3); }
.full .comp { grid-column: 1; display: flex; gap: 8px; padding: 10px 24px 18px; max-width: 768px; width: 100%; margin: 0 auto; }
.full .comp input { flex: 1; min-width: 0; height: 42px; border-radius: 21px; border: 0; background: var(--fill); color: var(--label); font: inherit; padding: 0 16px; outline: none; }
.full .reqs { display: flex; flex-direction: column; gap: 8px; max-width: 720px; margin: 0 auto 14px; }
body[data-mode=pip] .card, body[data-mode=fullscreen] .card { display: none; }
body[data-mode=pip] .dock { display: flex; }
body[data-mode=fullscreen] { padding: 0; } body[data-mode=fullscreen] .full { display: grid; }
@media (max-width: 640px) { .full { grid-template-columns: minmax(0,1fr); } .full .side { display: none; } .dock .last { display: none; } }
</style></head><body data-mode="inline">
<div class="card" id="card">
  <div class="hd"><span class="mark">${MARK}</span><span class="room" id="c-room">duet</span><span class="sp"></span><span class="faces" id="c-faces"></span>
    <button class="icon" id="c-pip" title="Keep it on top while you work">${ICON.pin}</button><button class="icon" id="c-full" title="Open the room">${ICON.expand}</button></div>
  <div id="c-reqs" style="display:flex;flex-direction:column;gap:8px"></div>
  <div class="lines" id="c-lines"><p class="empty">Opening the room…</p></div>
</div>
<div class="dock" id="dock" title="Open the room"><span class="mark">${MARK}</span><span class="room" style="font-weight:600;font-size:14px" id="d-room"></span><span class="vsep"></span>
  <span class="faces" id="d-faces"></span><span class="vsep"></span><span class="last" id="d-last"></span><span class="badge" id="d-n" hidden></span>
  <button class="icon" id="d-full" title="Open the room">${ICON.expand}</button></div>
<div class="full" id="full">
  <div class="top"><span class="mark">${MARK}</span><b id="f-room"></b><button class="icon" id="f-close" title="Back to the chat">${ICON.close}</button></div>
  <div class="feed" id="f-feed"><div class="reqs" id="f-reqs"></div><div class="lines" id="f-lines"></div></div>
  <aside class="side" id="f-side"></aside>
  <div class="comp"><input id="f-in" placeholder="What should your AI say in the room?"><button class="tint" id="f-draft">Ask my AI to draft</button></div>
</div>
<script>${BRIDGE}
let S = null, seen = 0, busy = {}, timer = 0;
const $ = (s) => document.querySelector(s);
const people = () => (S ? S.groups : []);
function faces() { return people().map((g) => '<span class="g">' + [g.person, ...g.agents].filter(Boolean).map(av).join("") + "</span>").join(""); }
function lineHtml(l) { return '<div class="line' + (l.mine ? " mine" : "") + '">' + av(l) + '<div class="tx"><small>' + esc(l.name) + (l.mine ? " <i>· this chat</i>" : "") + (l.to ? " → " + esc(l.to) : "") + " · " + ago(l.ts) + "</small>" + esc(l.text) + "</div></div>"; }
function reqHtml(r) { return '<div class="req"><span class="who">' + av(r) + "<span><b>" + esc(r.name) + "</b> asks your AI · " + ago(r.ts) + '</span></span><div class="q">' + esc(r.text) + '</div><div class="acts"><button class="gray" data-ignore="' + esc(r.reqId) + '">Ignore</button><button class="tint" data-answer="' + esc(r.reqId) + '">Answer</button></div></div>'; }
function render() {
  if (!S) return;
  const last = S.lines[S.lines.length - 1];
  for (const id of ["c-room", "d-room", "f-room"]) $("#" + id).textContent = "# " + S.room;
  $("#c-faces").innerHTML = $("#d-faces").innerHTML = faces();
  const reqs = S.requests.map(reqHtml).join("");
  $("#c-reqs").innerHTML = reqs; $("#f-reqs").innerHTML = reqs;
  $("#c-lines").innerHTML = S.lines.slice(-4).map(lineHtml).join("") || '<p class="empty">No messages yet. Say hi in the room.</p>';
  $("#f-lines").innerHTML = S.lines.map(lineHtml).join("") || '<p class="empty">No messages yet.</p>';
  $("#d-last").innerHTML = last ? "<b>" + esc(last.name) + ":</b> " + esc(last.text) : "No messages yet";
  const unread = S.lines.filter((l) => l.ts > seen && !l.mine).length + S.requests.length;
  const n = $("#d-n"); n.hidden = !unread || document.body.dataset.mode === "fullscreen"; n.textContent = unread;
  $("#f-side").innerHTML = '<span class="cap" style="padding:4px 6px 8px">IN THE ROOM</span>' + people().map((g) =>
    (g.person ? '<div class="mrow">' + av(g.person) + '<span class="nm">' + esc(g.person.name) + (g.person.owner ? ' <span class="tag">you</span>' : "") + "</span></div>" : "") +
    g.agents.map((a) => '<div class="mrow agent">' + av(a) + '<span class="nm">' + esc(a.name) + "</span>" + (a.me ? '<span class="tag">this chat</span>' : "") + "</div>").join("")).join("");
  if (document.body.dataset.mode === "fullscreen") { seen = Date.now(); const f = $("#f-feed"); f.scrollTop = f.scrollHeight; }
  for (const b of document.querySelectorAll("[data-ignore]")) b.onclick = () => act(b.dataset.ignore, "ignore");
  for (const b of document.querySelectorAll("[data-answer]")) b.onclick = () => act(b.dataset.answer, "answer");
  size();
}
async function refresh() { try { const r = await call("room_state", {}); if (r && r.structuredContent) { S = r.structuredContent; render(); } } catch (e) {} }
function poll() { clearInterval(timer); timer = setInterval(refresh, document.hidden ? 15000 : 3000); }
async function act(id, what) {
  if (busy[id]) return; busy[id] = 1; const r = S.requests.find((x) => x.reqId === id);
  S.requests = S.requests.filter((x) => x.reqId !== id); render();
  try { await call("handle_request", { id, action: what }); } catch {}
  if (what === "answer" && r) { if (document.body.dataset.mode === "fullscreen") await mode("inline");
    await say("Request from " + r.name + " in the room #" + S.room + ': "' + r.text + '". Answer them with draft_reply (to: ' + r.name + "), so I can check it before it goes out.").catch(() => {}); }
}
H.on["ui/notifications/tool-result"] = (r) => { if (r && r.structuredContent && r.structuredContent.room) { S = r.structuredContent; render(); } };
H.on.mode = (m) => render();
H.on.teardown = () => clearInterval(timer);
$("#c-pip").onclick = () => mode("pip"); $("#c-full").onclick = $("#d-full").onclick = (e) => { e.stopPropagation(); mode("fullscreen"); };
$("#dock").onclick = () => mode("fullscreen"); $("#f-close").onclick = () => mode("inline");
$("#f-draft").onclick = async () => { const v = $("#f-in").value.trim(); $("#f-in").value = ""; await mode("inline");
  await say(v ? "Draft a message for the room #" + S.room + ": " + v + ". Use draft_reply so I can check it before it goes out." : "Draft an update for the room #" + S.room + " with draft_reply, so I can check it before it goes out.").catch(() => {}); };
$("#f-in").onkeydown = (e) => { if (e.key === "Enter") $("#f-draft").click(); };
document.addEventListener("visibilitychange", poll);
connect("duet room").then(() => { refresh(); poll(); });
</script></body></html>`;

export const SEND_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}
body { padding: 2px; }
.card { border-radius: 22px; background: var(--fill); border: 1px solid var(--sep); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.hd { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: var(--label-2); } .hd b { color: var(--label); }
.body { font-size: 15px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
textarea { width: 100%; min-height: 110px; resize: vertical; border: 0; border-radius: 12px; background: var(--fill-2); color: var(--label); font: inherit; padding: 10px 12px; outline: none; }
.acts { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.stamp { display: none; align-items: center; gap: 6px; font-size: 13px; color: var(--label-3); } .stamp svg { width: 14px; height: 14px; color: var(--ok); }
.done .acts { display: none; } .done .stamp { display: flex; } .done .body { color: var(--label-2); }
</style></head><body>
<div class="card" id="card">
  <span class="cap">REPLY TO THE ROOM</span>
  <div class="hd"><span class="mark">${MARK}</span><span id="to">Waiting for the draft…</span></div>
  <div class="body" id="body"></div>
  <div class="acts"><button class="gray" id="edit" disabled>Edit</button><button class="gray" id="no" disabled>Don't send</button><button class="tint" id="send" disabled>Send</button></div>
  <span class="stamp" id="stamp">${ICON.check}<span id="stamp-t"></span></span>
</div>
<script>${BRIDGE}
let D = null, editing = false;
const $ = (s) => document.querySelector(s);
function show(d) { D = d; $("#to").innerHTML = "Your AI → " + (d.to ? "<b>" + esc(d.to) + "</b> in " : "") + "<b>#" + esc(d.room) + "</b>";
  if (!editing) $("#body").textContent = d.text; for (const b of document.querySelectorAll("button")) b.disabled = false;
  if (d.status && d.status !== "draft") done(d.status === "sent" ? "Sent to #" + d.room : "Not sent"); size(); }
function done(t) { $("#card").classList.add("done"); $("#stamp-t").textContent = t; if (editing) { $("#body").textContent = D.text; editing = false; } size(); }
async function act(action) { const text = editing ? $("#body textarea").value.trim() : D.text;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try { const r = await call("send_draft", { draftId: D.draftId, action, text }); const s = (r && r.structuredContent) || {};
    if (s.status === "sent") { D.text = text; done("Sent to #" + D.room); } else if (s.status === "discarded") done("Not sent");
    else { for (const b of document.querySelectorAll("button")) b.disabled = false; $("#stamp-t").textContent = (r && r.content && r.content[0] && r.content[0].text) || "Not sent"; $("#card").classList.add("done"); } }
  catch (e) { for (const b of document.querySelectorAll("button")) b.disabled = false; alert("Not sent: " + e.message); } }
$("#edit").onclick = () => { if (editing) { D.text = $("#body textarea").value; $("#body").textContent = D.text; editing = false; $("#edit").textContent = "Edit"; }
  else { editing = true; $("#body").innerHTML = "<textarea></textarea>"; $("#body textarea").value = D.text; $("#body textarea").focus(); $("#edit").textContent = "Done"; } size(); };
$("#no").onclick = () => act("discard"); $("#send").onclick = () => act("send");
H.on["ui/notifications/tool-result"] = async (r) => { const d = r && r.structuredContent; if (!d || !d.draftId) return; show(d);
  try { const s = await call("send_draft", { draftId: d.draftId, action: "status" }); if (s && s.structuredContent) show(Object.assign({}, d, s.structuredContent)); } catch {} };
connect("duet reply");
</script></body></html>`;

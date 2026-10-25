/**
 * ILORA.ai Rent Collector page.
 *
 * This page is a real MCP client: it connects to the ILORA.ai server over
 * Streamable HTTP and runs initialize, tools/list, tools/call and resources/read
 * itself. Every JSON-RPC message is shown in the debug panel. The "brain" (the
 * model that picks a tool) runs server-side at /api/brain because it needs the Nebius
 * key; it never sees the MCP connection, only the tool list and results.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ownersAmount } from "./amount.js";

type Block = { text: string } | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } } | { toolResult: { toolUseId: string; status: "success" | "error"; content: { json: unknown }[] } };
type Message = { role: "user" | "assistant"; content: Block[] };
type BrainReply =
  | { stop: "tool_use"; message: Message; toolUse: { toolUseId: string; name: string; input: Record<string, unknown> }; brain: string; ms: number }
  | { stop: "end_turn"; message: Message; text: string; brain: string; ms: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MCP_URL = new URL("/mcp", location.href);
const SUGGESTIONS = [
  "What rent can I bill right now?",
  "Bill Harbor Light Pilates for the rent increase.",
  "Who still owes me?",
  "Harbor Light Pilates paid by check.",
  "Show me the lines for the first one.",
];

// ------------------------------------------------------------------ JSON-RPC wire log

function logWire(dir: "→" | "←", body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of msgs as Record<string, unknown>[]) {
    const li = document.createElement("li");
    const label = (m.method as string) ?? (m.note ? "note" : m.error ? "error" : "result");
    const extra = m.method === "tools/call" ? ` ${(m.params as { name: string }).name}` : "";
    li.innerHTML = `<details><summary><span class="dir">${dir}</span>${label}${extra}${m.id !== undefined ? ` · id ${m.id}` : ""}</summary><pre></pre></details>`;
    li.querySelector("pre")!.textContent = JSON.stringify(m, null, 2);
    $("wire").append(li);
    li.scrollIntoView({ block: "end" });
  }
}

const loggingFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") logWire("→", init.body);
  const res = await fetch(input, init);
  if ((init?.method ?? "GET") === "GET" && res.status === 405) {
    // The client asks for an optional server-to-client stream; a stateless server declines with 405, as the spec allows.
    logWire("←", JSON.stringify({ note: "GET /mcp → 405: stateless server, no server-initiated stream (expected)" }));
    return res;
  }
  const copy = res.clone();
  copy.text().then((t) => t && logWire("←", t));
  return res;
};

// ------------------------------------------------------------------ MCP connection

const client = new Client({ name: "ilora-building-analyst", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(MCP_URL, { fetch: loggingFetch });
let tools: Tool[] = [];
const messages: Message[] = [];

async function connect() {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  const info = client.getServerVersion();
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({ brain: "unknown", voice: "browser" }));
  $("session-info").textContent = `${info?.name} ${info?.version} · MCP ${transport.protocolVersion} · ${tools.length} tools · brain: ${cfg.brain} · voice: ${cfg.voice}`;
}

// ------------------------------------------------------------------ conversation

function addTurn(who: "user" | "analyst" | "error", text: string, meta?: string) {
  const div = document.createElement("div");
  div.className = `turn ${who}`;
  div.textContent = text;
  if (meta) {
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    div.append(m);
  }
  $("conversation").append(div);
  div.scrollIntoView({ block: "end" });
  if (who !== "user") $("no-screen-caption").textContent = text;
}

/** Tool results go back to the brain as structured data, or as the parsed error. */
function payloadOf(r: CallToolResult): unknown {
  if (!r.isError && r.structuredContent) return r.structuredContent;
  const t = r.content.find((c) => c.type === "text") as { text: string } | undefined;
  try {
    return JSON.parse(t?.text ?? "{}");
  } catch {
    return { error: { message: t?.text ?? "Unknown error" } };
  }
}

// ------------------------------------------------------------------ owner approval

type KnownBill = { tenant: string; property_name: string; unit: string; amount: number; line_item: string };
/** What each bill is, learned from the last draft or status result, so the approval card can say it plainly. */
const known = new Map<string, KnownBill>();
function remember(result: CallToolResult) {
  const bills = (result.structuredContent as { bills?: (KnownBill & { flag_id: string })[] } | undefined)?.bills;
  for (const b of bills ?? []) known.set(b.flag_id, b);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** A tool that is not read-only changes something outside this page, so the owner approves it first. */
const needsApproval = (name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint !== true;

async function approve(name: string, input: Record<string, unknown>): Promise<boolean> {
  const id = String(input.flag_id ?? "");
  // The model may pass the bill's id or just the tenant's name.
  const lookup = () => known.get(id) ?? [...known.values()].find((k) => id.toLowerCase().includes(k.tenant.toLowerCase().split(" ")[0]));
  if (!lookup()) {
    const draft = (await client.callTool({ name: "draft_rent_invoices", arguments: {} })) as CallToolResult;
    remember(draft);
    updateLedger("draft_rent_invoices", draft);
  }
  const b = lookup();
  const how = String(input.method ?? "check").toLowerCase().replace("_", " ");
  const what =
    name === "send_rent_invoice"
      ? b ? `Send ${b.tenant} a PayPal invoice for ${money(b.amount)}: ${b.line_item}, ${b.property_name} ${b.unit}.` : "Send a PayPal invoice."
      : b ? `Record ${input.amount ? money(Number(input.amount)) : "the full amount due"} received from ${b.tenant} by ${how}.` : "Record a payment.";

  const card = document.createElement("div");
  card.className = "approval";
  card.id = `approval-${Date.now()}`;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Approve this action");
  const p = document.createElement("p");
  p.textContent = what;
  const note = document.createElement("p");
  note.className = "approval-note";
  note.textContent = "PayPal sandbox. Nothing happens until you approve.";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "approve";
  yes.textContent = name === "send_rent_invoice" ? "Approve and send" : "Approve and record";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "decline";
  no.textContent = "Cancel";
  const row = document.createElement("div");
  row.className = "approval-actions";
  row.id = `${card.id}-actions`;
  row.append(yes, no);
  card.append(p, note, row);
  $("conversation").append(card);
  card.scrollIntoView({ block: "end" });
  yes.focus();
  const ok = await new Promise<boolean>((resolve) => {
    yes.onclick = () => resolve(true);
    no.onclick = () => resolve(false);
  });
  const done = document.createElement("span");
  done.className = "approval-note";
  done.textContent = ok ? "Approved." : "Cancelled. Nothing was sent.";
  row.replaceChildren(done);
  return ok;
}

let busy = false;
async function ask(text: string, mode: "ask" | "review" = "ask") {
  if (busy || !text.trim()) return;
  busy = true;
  $("talk").setAttribute("disabled", "");
  addTurn("user", text);
  // A review starts from a clean slate so every check runs fresh, then joins the conversation for follow-ups.
  const thread: Message[] = mode === "review" ? [] : messages;
  thread.push({ role: "user", content: [{ text }] });
  const used: string[] = [];
  try {
    for (let step = 0; step < (mode === "review" ? 16 : 5); step++) {
      const reply = (await fetch("/api/brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, messages: thread, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `brain HTTP ${r.status}`);
        return r.json();
      })) as BrainReply;
      thread.push(reply.message);
      if (reply.stop === "end_turn") {
        if (thread !== messages) messages.push(...thread);
        addTurn("analyst", reply.text, `${used.length ? `tools: ${used.join(", ")} · ` : ""}${reply.brain}`);
        speak(reply.text);
        return;
      }
      if (reply.toolUse.name === "record_rent_payment") {
        // Keep the conversation and the call in step: both carry only an amount the owner actually said.
        reply.toolUse.input = ownersAmount(reply.toolUse.input, text);
        for (const blk of reply.message.content) if ("toolUse" in blk && blk.toolUse.toolUseId === reply.toolUse.toolUseId) blk.toolUse.input = reply.toolUse.input;
      }
      if (needsApproval(reply.toolUse.name) && !(await approve(reply.toolUse.name, reply.toolUse.input))) {
        used.push(`${reply.toolUse.name} declined`);
        thread.push({
          role: "user",
          content: [{ toolResult: { toolUseId: reply.toolUse.toolUseId, status: "error", content: [{ json: { error: { code: "owner_declined", message: "The person you are talking to clicked Cancel. Tell them, speaking to them as you, that nothing was sent or recorded." } } }] } }],
        });
        continue;
      }
      const t0 = performance.now();
      const result = (await client.callTool({ name: reply.toolUse.name, arguments: reply.toolUse.input })) as CallToolResult;
      remember(result);
      used.push(`${reply.toolUse.name} ${Math.round(performance.now() - t0)} ms`);
      thread.push({
        role: "user",
        content: [{ toolResult: { toolUseId: reply.toolUse.toolUseId, status: result.isError ? "error" : "success", content: [{ json: payloadOf(result) }] } }],
      });
      if (!result.isError && !updateLedger(reply.toolUse.name, result)) await showVisual(reply.toolUse.name, result);
    }
    addTurn("error", "I couldn't finish that. Try asking again.");
  } catch (err) {
    addTurn("error", `Something went wrong: ${(err as Error).message}`);
  } finally {
    busy = false;
    $("talk").removeAttribute("disabled");
  }
}


// ------------------------------------------------------------------ collection ledger

type LedgerBill = KnownBill & { flag_id: string; invoice?: { status: string; amount: number; paid: number; due: number; tenant_link?: string } | null };
let ledgerRows: LedgerBill[] = [];
const STATUS: Record<string, string> = { SENT: "Invoice sent", UNPAID: "Invoice sent", PARTIALLY_PAID: "Part paid", PAID: "Paid", MARKED_AS_PAID: "Paid", DRAFT: "Draft" };

/** Keeps the right-hand panel in step with every PayPal tool result: what is owed, what was billed, what came in. */
function updateLedger(name: string, result: CallToolResult) {
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  if (!sc) return false;
  if (name === "draft_rent_invoices" || name === "rent_collection_status") ledgerRows = (sc.bills as LedgerBill[]) ?? [];
  else if (name === "send_rent_invoice" || name === "record_rent_payment") {
    const row = ledgerRows.find((r) => r.flag_id === sc.flag_id);
    if (row) row.invoice = sc.invoice as LedgerBill["invoice"];
  } else return false;
  renderLedger();
  return true;
}

function renderLedger() {
  const owed = ledgerRows.reduce((a, r) => a + r.amount, 0);
  const paid = ledgerRows.reduce((a, r) => a + (r.invoice?.paid ?? 0), 0);
  const wrap = document.createElement("div");
  wrap.id = "ledger";
  const head = document.createElement("div");
  head.id = "ledger-head";
  head.innerHTML = '<p class="ledger-kicker">Rent to collect</p><p class="ledger-total"></p><p class="ledger-sub"></p>';
  head.querySelector(".ledger-total")!.textContent = money(owed);
  head.querySelector(".ledger-sub")!.textContent = `${money(paid)} collected · ${money(owed - paid)} to go`;
  const bar = document.createElement("div");
  bar.id = "ledger-bar";
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${money(paid)} of ${money(owed)} collected`);
  const fill = document.createElement("span");
  fill.style.width = `${owed ? Math.round((paid / owed) * 100) : 0}%`;
  bar.append(fill);
  const list = document.createElement("ol");
  list.id = "ledger-rows";
  for (const r of ledgerRows) {
    const li = document.createElement("li");
    const status = r.invoice ? (STATUS[r.invoice.status] ?? r.invoice.status.toLowerCase()) : "Not billed";
    li.innerHTML = '<div class="row-main"><span class="row-tenant"></span><span class="row-amount"></span></div><div class="row-sub"><span class="row-where"></span><span class="row-status"></span></div>';
    li.querySelector(".row-tenant")!.textContent = r.tenant;
    li.querySelector(".row-amount")!.textContent = money(r.amount);
    li.querySelector(".row-where")!.textContent = `${r.property_name}, ${r.unit} · ${r.line_item}`;
    const st = li.querySelector(".row-status") as HTMLElement;
    st.textContent = status;
    st.dataset.state = r.invoice ? (r.invoice.due <= 0 ? "paid" : "sent") : "open";
    if (r.invoice?.tenant_link) {
      const a = document.createElement("a");
      a.href = r.invoice.tenant_link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Tenant's PayPal invoice";
      li.append(a);
    }
    list.append(li);
  }
  wrap.append(head, bar, list);
  frameCleanup?.();
  currentFrame = undefined;
  $("visual").replaceChildren(wrap);
}

// ------------------------------------------------------------------ MCP Apps host (inline Card / List)

let frameCleanup: (() => void) | undefined;
let currentFrame: HTMLIFrameElement | undefined;

/** Tell the current view its container changed (e.g. the screen was turned back on) so it re-measures. */
function notifyContainerChanged() {
  const w = $("visual").clientWidth;
  currentFrame?.contentWindow?.postMessage(
    { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", displayMode: "inline", containerDimensions: { width: w, maxHeight: 720 } } },
    "*",
  );
}

async function showVisual(toolName: string, result: CallToolResult) {
  const tool = tools.find((t) => t.name === toolName);
  const uri = (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (!uri) return;
  const res = await client.readResource({ uri });
  const html = (res.contents[0] as { text: string }).text;
  frameCleanup?.();
  const frame = document.createElement("iframe");
  frame.title = `${tool?.title ?? toolName} view`;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.height = "320px";
  frame.style.colorScheme = "dark"; // keep the frame's canvas transparent on the dark device screen
  frame.srcdoc = html;
  $("visual").replaceChildren(frame);
  currentFrame = frame;

  const theme = "dark"; // the simulated Echo Show screen is dark in both page themes
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data as { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown> };
    if (m?.jsonrpc !== "2.0") return;
    const reply = (r: unknown) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", id: m.id, result: r }, "*");
    switch (m.method) {
      case "ui/initialize":
        reply({
          protocolVersion: "2026-01-26",
          hostInfo: { name: "ilora-building-analyst", version: "0.1.0" },
          hostCapabilities: { message: {} },
          hostContext: { theme, displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", toolInfo: { tool } },
        });
        break;
      case "ui/notifications/initialized":
        frame.contentWindow?.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
        break;
      case "ui/notifications/size-changed": {
        // A view rendered while the screen is off measures 0; keep the last real height until it is visible again.
        const h = Number(m.params?.height ?? 0);
        if (h >= 40) frame.style.height = `${Math.min(Math.ceil(h), 720)}px`;
        break;
      }
      case "ui/message": {
        const text = ((m.params?.content as { text: string }[]) ?? [])[0]?.text;
        reply({});
        if (text) void ask(text);
        break;
      }
      default:
        if (m.id !== undefined) frame.contentWindow?.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not supported" } }, "*");
    }
  };
  window.addEventListener("message", onMessage);
  frameCleanup = () => window.removeEventListener("message", onMessage);
}

// ------------------------------------------------------------------ voice

// One audio element for the whole session. Browsers only let a page start sound right after a
// click or key press, and an answer arrives seconds later; so the element is unlocked on the
// press itself and then reused for every answer. Without this the play call is refused and the
// page used to fall back to the robotic built-in browser voice.
const player = new Audio();
const SILENCE = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => (unlocked = false));
}
addEventListener("pointerdown", unlockAudio, { capture: true });
addEventListener("keydown", unlockAudio, { capture: true });

async function speak(text: string) {
  player.pause();
  speechSynthesis.cancel();
  let r: Response | undefined;
  try {
    r = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {
    r = undefined;
  }
  if (r?.status === 200) {
    player.src = URL.createObjectURL(await r.blob());
    try {
      await player.play();
    } catch {
      // Still refused (no click yet this session): offer a button rather than a different voice.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiet";
      btn.textContent = "Play answer";
      btn.onclick = () => { btn.remove(); void player.play(); };
      $("conversation").lastElementChild?.append(btn);
    }
    return;
  }
  // The server has no voice switched on (status 204), so use the browser's own voice.
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

type Rec = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
const SR = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

function setupTalk() {
  const btn = $("talk");
  if (!SR) {
    btn.textContent = "Voice input needs Chrome or Edge";
    btn.setAttribute("disabled", "");
    return;
  }
  let rec: Rec | undefined;
  let heard = "";
  const start = () => {
    if (busy || rec) return;
    heard = "";
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => (heard = Array.from(e.results).map((r) => r[0].transcript).join(" "));
    rec.onerror = (e) => addTurn("error", `Microphone: ${e.error}`);
    rec.onend = () => {
      btn.dataset.state = "";
      btn.textContent = "Hold to talk";
      rec = undefined;
      if (heard) void ask(heard);
    };
    btn.dataset.state = "listening";
    btn.textContent = "Listening…";
    rec.start();
  };
  const stop = () => rec?.stop();
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); start(); }
  });
  btn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") stop();
  });
}

// ------------------------------------------------------------------ chrome

function setup() {
  for (const q of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.onclick = () => ask(q);
    $("suggestions").append(b);
  }
  $("review").addEventListener("click", () => ask("Review my whole portfolio and tell me what to act on first.", "review"));
  $("collect").addEventListener("click", () => ask("What rent can I bill right now?"));
  $<HTMLFormElement>("type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("typed");
    void ask(input.value);
    input.value = "";
  });
  $<HTMLInputElement>("screen-toggle").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    $("device-screen").classList.toggle("voice-only", !on);
    $("no-screen").hidden = on;
    if (on) setTimeout(notifyContainerChanged, 60);
  });
  const dark = $<HTMLInputElement>("theme-toggle");
  dark.checked = matchMedia("(prefers-color-scheme: dark)").matches;
  const applyTheme = () => (document.documentElement.dataset.theme = dark.checked ? "dark" : "light");
  dark.addEventListener("change", applyTheme);
  applyTheme();
  $("debug-toggle").addEventListener("click", () => {
    const d = $("debug");
    d.hidden = !d.hidden;
    $("stage").classList.toggle("with-debug", !d.hidden);
    $("debug-toggle").setAttribute("aria-expanded", String(!d.hidden));
    $("debug-toggle").textContent = d.hidden ? "Show JSON-RPC" : "Hide JSON-RPC";
    setTimeout(notifyContainerChanged, 60); // the layout changes width
  });
  $("visual").innerHTML = '<p class="placeholder">Answers with numbers appear here.</p>';
  setupTalk();
}

setup();
connect().catch((err) => addTurn("error", `Could not reach the MCP server: ${(err as Error).message}`));

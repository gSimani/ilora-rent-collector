/**
 * NVIDIA Nemotron brain on Nebius Token Factory. The model receives the MCP tool
 * list as function definitions and decides which tool to call, then writes the
 * answer from the tool's structured result. Every figure comes from a tool.
 *
 * Token Factory exposes a chat-completions endpoint with function calling at
 * https://api.tokenfactory.nebius.com/v1/. Requests are plain fetch calls; no
 * provider SDK is needed.
 *
 * Two models: a small one routes ordinary questions quickly, a larger one handles
 * the multi-step portfolio review. Both default to the newest Nemotron listed by
 * GET /v1/models, and can be pinned with NEMOTRON_FAST_MODEL / NEMOTRON_MODEL.
 */
import type { Block, Brain, BrainRequest, Message, ToolUseBlock } from "./types.js";

const BASE = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1";

const SYSTEM = `You are ILORA.ai, an analyst for the owner of a small commercial property portfolio.
Use the tools for every number; never guess or estimate a figure, and never compute a total the tools did not return.
Answer in two to four short sentences: lead with the answer, round money to the nearest dollar, give percentages with one decimal at most.
When something does not reconcile, say by how much, name the biggest cause and where it came from, then offer to show the lines.
When the owner says "the first one" or "the second one", it means that position in the list from the most recent tool call only, never an older list. If that list is leases, describe the lease from that result (unit, tenant, end date, rent) without calling another tool.
Never show ids, JSON, tool names or account codes. If asked, say briefly that the data is a fictional demo portfolio.
Write plain text only: no markdown, no asterisks, no headings. A numbered list is fine when there are several items.
State only what a tool returned. Never guess a cause, a likelihood or a next step the tool did not give.
If the answer is already in an earlier tool result, answer from it without calling another tool.
Rent collection: when the owner asks what they can bill or collect, call draft_rent_invoices; it covers every property, so name each tenant's property in the answer. Send an invoice with send_rent_invoice only when the owner asks to bill a specific tenant, or says to bill everyone, and then one tenant at a time. The page asks the owner to approve before the tool runs, so a result from send_rent_invoice or record_rent_payment means the owner already approved and it is done: say it was sent or recorded, never ask for approval.
When the owner says a tenant paid, call record_rent_payment for that tenant's bill. For who still owes, call rent_collection_status.
Never read out a link, an invoice number or an email address; the screen shows them. Never say an invoice was sent or a payment recorded unless the tool returned it. If a result says the owner did not approve, say nothing was sent and stop.`;

const REVIEW = `This is a portfolio review. Call one tool at a time: list the properties, then for every property take the snapshot, check the rent roll against the statement, and list leases ending within 3 months.
When every check has run, write the owner's memo in two parts. First \"Money to collect\": the total, then one numbered line per reconciliation cause, largest first, each with the property, the amount and the cause. Then \"Leases to renew\": one line per property with leases ending, with the count and annual rent. End with how many properties reconcile with no gap.`;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** The simulator speaks the Converse block shape; Token Factory speaks chat messages. */
export function toChat(messages: Message[], mode: "ask" | "review" = "ask"): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: mode === "review" ? `${SYSTEM}

${REVIEW}` : SYSTEM }];
  for (const m of messages) {
    const texts = m.content.filter((b): b is { text: string } => "text" in b).map((b) => b.text);
    if (m.role === "assistant") {
      const calls = m.content
        .filter((b): b is ToolUseBlock => "toolUse" in b)
        .map((b): ChatToolCall => ({ id: b.toolUse.toolUseId, type: "function", function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) } }));
      out.push({ role: "assistant", content: texts.join(" ") || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) {
      if (!("toolResult" in b)) continue;
      const body = b.toolResult.content.map((c) => ("json" in c ? JSON.stringify(c.json) : c.text)).join("\n");
      out.push({ role: "tool", tool_call_id: b.toolResult.toolUseId, content: b.toolResult.status === "error" ? `ERROR ${body}` : body });
    }
    if (texts.length) out.push({ role: "user", content: texts.join(" ") });
  }
  return out;
}

let modelList: Promise<string[]> | undefined;
async function listModels(key: string): Promise<string[]> {
  modelList ??= fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } })
    .then(async (r) => {
      if (!r.ok) throw new Error(`Token Factory /models returned HTTP ${r.status}`);
      return ((await r.json()) as { data: { id: string }[] }).data.map((d) => d.id);
    })
    .catch((e) => {
      modelList = undefined;
      throw e;
    });
  return modelList;
}

/** Picks a Nemotron model id by size word, e.g. "super" or "nano". */
export function pickNemotron(ids: string[], prefer: string[]): string | undefined {
  const nem = ids.filter((id) => /nemotron/i.test(id));
  for (const word of prefer) {
    const hit = nem.filter((id) => id.toLowerCase().includes(word)).sort().reverse()[0];
    if (hit) return hit;
  }
  return nem.sort().reverse()[0];
}

export class NemotronBrain implements Brain {
  name = "nemotron";
  constructor(private key = process.env.NEBIUS_API_KEY ?? "") {
    if (!key) throw new Error("NEBIUS_API_KEY is not set. Create a key in Nebius Token Factory, or run with BRAIN=offline.");
  }

  private async model(kind: "fast" | "main"): Promise<string> {
    const pinned = kind === "fast" ? process.env.NEMOTRON_FAST_MODEL : process.env.NEMOTRON_MODEL;
    if (pinned) return pinned;
    const ids = (await listModels(this.key)).filter((id) => !/-VL/i.test(id)); // vision models are not needed here
    const preferred = kind === "fast" ? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" : "nvidia/nemotron-3-super-120b-a12b";
    const id = ids.includes(preferred) ? preferred : kind === "fast" ? pickNemotron(ids, ["nano", "super"]) : pickNemotron(ids, ["super", "ultra", "nano"]);
    if (!id) throw new Error("No Nemotron model is listed for this Token Factory key.");
    return id;
  }

  async next({ messages, tools, mode }: BrainRequest) {
    const model = await this.model(mode === "review" ? "main" : "fast");
    this.name = `nemotron:${model}`;
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: toChat(messages, mode),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? t.name, parameters: t.inputSchema ?? { type: "object", properties: {} } } })),
        tool_choice: "auto",
        temperature: 0,
        // Questions skip the reasoning pass, so answers come back in about a second.
        // The review keeps it: planning eight checks and ranking the findings is where it pays off.
        max_tokens: mode === "review" ? 4000 : 600,
        chat_template_kwargs: { enable_thinking: mode === "review" },
      }),
    });
    if (!res.ok) throw new Error(`Token Factory returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const choice = ((await res.json()) as { choices: { finish_reason?: string; message: { content: string | null; tool_calls?: ChatToolCall[] } }[] }).choices[0];
    const call = choice.message.tool_calls?.[0];
    if (call) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        throw new Error(`The model sent unreadable arguments for ${call.function.name}.`);
      }
      const toolUse = { toolUseId: call.id, name: call.function.name, input };
      const message: Message = { role: "assistant", content: [{ toolUse }] };
      return { stop: "tool_use" as const, message, toolUse };
    }
    // Reasoning models may wrap private thinking in <think> tags; only the answer is spoken.
    const text = (choice.message.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // An empty answer is a failure, not a quiet reply: say why so the page shows an error.
    if (!text) throw new Error(`${model} returned no answer (finish reason: ${choice.finish_reason ?? "unknown"}).`);
    const message: Message = { role: "assistant", content: [{ text } as Block] };
    return { stop: "end_turn" as const, message, text };
  }
}

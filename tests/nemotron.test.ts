import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { NemotronBrain, pickNemotron, toChat, unbackedWriteClaim, writeIntent } from "../src/assistant/nemotron.js";
import type { Message } from "../src/assistant/types.js";

describe("Nemotron brain wiring", () => {
  it("turns a tool round trip into chat messages with matching ids", () => {
    const messages: Message[] = [
      { role: "user", content: [{ text: "How is Coral Wren Plaza doing?" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "call_1", name: "get_property_snapshot", input: { property: "coral-wren-plaza" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "call_1", status: "success", content: [{ json: { occupancy_pct: 92.1 } }] } }] },
    ];
    const chat = toChat(messages);
    expect(chat[0].role).toBe("system");
    expect(chat[1]).toEqual({ role: "user", content: "How is Coral Wren Plaza doing?" });
    expect(chat[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", function: { name: "get_property_snapshot", arguments: '{"property":"coral-wren-plaza"}' } }] });
    expect(chat[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"occupancy_pct":92.1}' });
  });

  it("marks tool errors so the model does not read them as data", () => {
    const chat = toChat([{ role: "user", content: [{ toolResult: { toolUseId: "c", status: "error", content: [{ json: { error: { code: "unknown_property" } } }] } }] }]);
    expect(chat[1]).toMatchObject({ role: "tool", content: expect.stringMatching(/^ERROR /) });
  });

  it("prefers the requested Nemotron size and ignores other models", () => {
    const ids = ["meta-llama/Llama-3.3-70B", "nvidia/Nemotron-3-Nano-30B", "nvidia/Nemotron-3-Super-120B"];
    expect(pickNemotron(ids, ["super"])).toBe("nvidia/Nemotron-3-Super-120B");
    expect(pickNemotron(ids, ["nano"])).toBe("nvidia/Nemotron-3-Nano-30B");
    expect(pickNemotron(["meta-llama/Llama-3.3-70B"], ["super"])).toBeUndefined();
  });
});

import { OfflinePlanner } from "../src/assistant/planner.js";
import { listProperties } from "../src/domain.js";
import { payload, startServer } from "./helpers.js";

describe("portfolio review", () => {
  it("runs every check on every property, then ranks the findings by dollars", async () => {
    const brain = new OfflinePlanner(listProperties());
    const srv = await startServer();
    const tools = (await srv.client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    try {
    const messages: Message[] = [{ role: "user", content: [{ text: "Review my whole portfolio." }] }];
    const used: string[] = [];
    for (let step = 0; step < 16; step++) {
      const r = await brain.next({ messages, tools, mode: "review" });
      messages.push(r.message);
      if (r.stop === "end_turn") {
        expect(used).toHaveLength(7);
        const lines = r.text.split("\n");
        expect(lines[0]).toBe("Money to collect: $18,690 across 3 items, largest first.");
        expect(lines[1]).toMatch(/^1\. Coral Wren Plaza: \$9,000 from Suite 104/);
        expect(lines[2]).toMatch(/^2\. Tamarind Grove Apartments: \$5,190 from Unit B-12/);
        expect(lines[3]).toMatch(/^3\. Coral Wren Plaza: \$4,500 from a CAM reconciliation/);
        expect(lines[4]).toBe("Leases to renew:");
        expect(lines[5]).toMatch(/3 leases end within three months, \$108,000 a year/);
        return;
      }
      used.push(r.toolUse.name);
      const result = (await srv.client.callTool({ name: r.toolUse.name, arguments: r.toolUse.input })) as { isError?: boolean; structuredContent?: unknown; content?: unknown };
      messages.push({ role: "user", content: [{ toolResult: { toolUseId: r.toolUse.toolUseId, status: result.isError ? "error" : "success", content: [{ json: payload(result) }] } }] });
    }
    throw new Error("review did not finish in 16 steps");
    } finally {
      await srv.close();
    }
  });
});

describe("a claim that money moved needs a tool call behind it", () => {
  const owner = (text: string): Message[] => [{ role: "user", content: [{ text }] }];
  const reply = (content: string | null, tool?: string) => ({
    ok: true,
    json: async () => ({ choices: [{ finish_reason: "stop", message: { content, tool_calls: tool ? [{ id: "c1", type: "function", function: { name: tool, arguments: '{"flag_id":"Harbor Light Pilates"}' } }] : undefined } }] }),
  });

  it("flags 'recorded' with no write tool, but not a refusal, a status answer or a real call", () => {
    expect(unbackedWriteClaim(owner("Harbor Light Pilates paid by check."), "Recorded payment for Harbor Light Pilates.")).toBe(true);
    expect(unbackedWriteClaim(owner("Harbor Light Pilates paid by check."), "Okay, nothing was recorded.")).toBe(false);
    expect(unbackedWriteClaim(owner("Who still owes me?"), "An invoice was sent to Harbor Light Pilates.")).toBe(false);
    const ran: Message[] = [
      ...owner("Bill Harbor Light Pilates."),
      { role: "assistant", content: [{ toolUse: { toolUseId: "c1", name: "send_rent_invoice", input: {} } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "c1", status: "success", content: [{ json: {} }] } }] },
    ];
    expect(unbackedWriteClaim(ran, "Sent the $9,000 invoice.")).toBe(false);
  });

  it("reads which write the owner asked for, and not a question about what to bill", () => {
    expect(writeIntent("Harbor Light Pilates paid by check.")).toBe("record_rent_payment");
    expect(writeIntent("Bill Harbor Light Pilates for the rent increase.")).toBe("send_rent_invoice");
    expect(writeIntent("What rent can I bill right now?")).toBeUndefined();
  });

  it("retries once, naming the tool, when the model claims or spells out a call instead of making it", async () => {
    process.env.NEMOTRON_FAST_MODEL = "nvidia/test-nano";
    for (const first of ["Recorded payment for Harbor Light Pilates.", 'record_rent_payment with flag_id "Harbor Light Pilates"']) {
      const fetch = vi.fn().mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(null, "record_rent_payment"));
      vi.stubGlobal("fetch", fetch);
      const tools = [{ name: "record_rent_payment", inputSchema: {} }];
      const out = await new NemotronBrain("k").next({ messages: owner("Harbor Light Pilates paid by check."), tools });
      expect(out.stop).toBe("tool_use");
      expect(JSON.parse(fetch.mock.calls[1][1].body).tool_choice).toEqual({ type: "function", function: { name: "record_rent_payment" } });
      vi.unstubAllGlobals();
    }
  });

  it("says nothing was done when the model claims it twice without acting", async () => {
    process.env.NEMOTRON_FAST_MODEL = "nvidia/test-nano";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("Recorded payment for Harbor Light Pilates.")));
    const out = await new NemotronBrain("k").next({ messages: owner("Harbor Light Pilates paid by check."), tools: [] });
    expect(out).toMatchObject({ stop: "end_turn", text: expect.stringMatching(/^I haven't recorded or sent anything/) });
    vi.unstubAllGlobals();
  });
});

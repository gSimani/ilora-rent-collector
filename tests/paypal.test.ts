/**
 * PayPal invoicing, against an in-memory fake of the Invoicing v2 endpoints the
 * code uses. The fake keeps invoices the way PayPal does (reference, status,
 * amounts), so the tools are tested end to end over a real MCP client without
 * network access. One sandbox round trip is recorded in the README.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { collectibleBills, findBill, invoiceBody, PayPal } from "../src/paypal.js";
import { createServer } from "../src/server.js";
import { errorOf, sc } from "./helpers.js";

type Inv = { id: string; status: string; reference: string; amount: number; paid: number; payments: { payment_id: string; type: string }[] };

function fakePayPal() {
  const store = new Map<string, Inv>();
  const calls: string[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const view = (i: Inv) => ({
    id: i.id,
    status: i.status,
    detail: { reference: i.reference, invoice_date: "2026-10-24" },
    amount: { value: i.amount.toFixed(2) },
    due_amount: { value: (i.amount - i.paid).toFixed(2) },
    payments: { paid_amount: { value: i.paid.toFixed(2) }, transactions: i.payments },
  });
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body).startsWith("{") ? String(init.body) : "{}") : {};
    if (path === "/v1/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
    if (path === "/v2/invoicing/invoices" && method === "GET") return json({ items: [...store.values()].reverse().map(view), total_pages: 1 });
    if (path === "/v2/invoicing/invoices" && method === "POST") {
      const id = `INV2-${++n}`;
      store.set(id, { id, status: "DRAFT", reference: body.detail.reference, amount: Number(body.items[0].unit_amount.value), paid: 0, payments: [] });
      return json({ id }, 201);
    }
    const m = path.match(/^\/v2\/invoicing\/invoices\/([^/]+)(?:\/(\w+))?(?:\/([^/]+))?$/);
    const inv = m && store.get(m[1]);
    if (!inv) return json({ message: "Resource not found" }, 404);
    if (m![2] === "send") {
      inv.status = "SENT";
      return json({ href: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` });
    }
    if (m![2] === "payments" && method === "POST") {
      inv.paid += Number(body.amount.value);
      inv.payments.push({ payment_id: `EXTR-${inv.payments.length + 1}`, type: "EXTERNAL" });
      inv.status = inv.paid >= inv.amount ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
      return json({ payment_id: "x" });
    }
    if (m![2] === "payments" && method === "DELETE") {
      inv.payments = inv.payments.filter((p) => p.payment_id !== m![3]);
      inv.paid = 0;
      inv.status = "SENT";
      return new Response(null, { status: 204 });
    }
    if (m![2] === "cancel") {
      inv.status = "CANCELLED";
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      store.delete(inv.id);
      return new Response(null, { status: 204 });
    }
    return json(view(inv));
  }) as typeof fetch;
  return { pp: new PayPal("id", "secret", undefined, http), store, calls };
}

async function connect(pp: PayPal) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(pp).connect(a);
  const client = new Client({ name: "paypal-tests", version: "1.0.0" });
  await client.connect(b);
  return client;
}

describe("what can be billed", () => {
  it("bills only amounts a tenant owes, largest first", () => {
    const bills = collectibleBills();
    expect(bills.map((b) => [b.flag_id, b.amount])).toEqual([
      ["coral-wren-plaza:unbilled_rent_step:104", 9000],
      ["tamarind-grove:occupied_no_rent:B-12", 5190],
    ]);
    // The $4,500 CAM reconciliation posted to base rent is a bookkeeping fix, not a bill.
    expect(bills.some((b) => b.flag_id.includes("misposted_cam"))).toBe(false);
  });

  it("builds an invoice that carries the flag id, the months and the amount", () => {
    const body = invoiceBody(findBill("coral-wren-plaza:unbilled_rent_step:104")!);
    expect(body.detail.reference).toBe("coral-wren-plaza:unbilled_rent_step:104");
    expect(body.items[0].name).toBe("Rent increase not billed, Mar 2026 to Aug 2026 (6 months)");
    expect(body.items[0].unit_amount).toEqual({ currency_code: "USD", value: "9000.00" });
    expect(body.primary_recipients[0].billing_info.email_address).toMatch(/@.*example\.com$/);
  });

  it("refuses any PayPal host other than the sandbox", () => {
    expect(() => new PayPal("id", "secret", "https://api-m.paypal.com")).toThrow(/sandbox/);
  });
});

describe("the PayPal tools over MCP", () => {
  it("marks the two collection tools as side effects and the rest as read-only", async () => {
    const client = await connect(fakePayPal().pp);
    const { tools } = await client.listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(["record_rent_payment", "send_rent_invoice"]);
  });

  it("drafts, sends once, records a check and reports the totals", async () => {
    const { pp, store } = fakePayPal();
    const client = await connect(pp);

    const draft = sc(await client.callTool({ name: "draft_rent_invoices", arguments: {} }));
    expect(draft.total_owed).toBe(14190);
    expect(draft.not_yet_invoiced).toBe(14190);
    expect(store.size).toBe(0); // drafting sends nothing

    const id = "coral-wren-plaza:unbilled_rent_step:104";
    const sent = sc(await client.callTool({ name: "send_rent_invoice", arguments: { flag_id: id } }));
    expect(sent.already_sent).toBe(false);
    expect(sent.invoice).toMatchObject({ status: "SENT", amount: 9000, due: 9000 });
    expect(sent.invoice.tenant_link).toContain("sandbox.paypal.com");

    const again = sc(await client.callTool({ name: "send_rent_invoice", arguments: { flag_id: id } }));
    expect(again.already_sent).toBe(true);
    expect(store.size).toBe(1); // never billed twice

    const part = sc(await client.callTool({ name: "record_rent_payment", arguments: { flag_id: id, amount: 4000 } }));
    expect(part.invoice).toMatchObject({ status: "PARTIALLY_PAID", paid: 4000, due: 5000 });

    const status = sc(await client.callTool({ name: "rent_collection_status", arguments: {} }));
    expect(status).toMatchObject({ billed: 9000, collected: 4000, still_due: 5000, not_yet_invoiced: 5190 });

    const rest = sc(await client.callTool({ name: "record_rent_payment", arguments: { flag_id: id } }));
    expect(rest.recorded).toBe(5000);
    expect(rest.invoice.status).toBe("MARKED_AS_PAID");

    const done = await client.callTool({ name: "record_rent_payment", arguments: { flag_id: id } });
    expect(errorOf(done).code).toBe("already_paid");
  });

  it("bills and records by the tenant's name, not only by id", async () => {
    const client = await connect(fakePayPal().pp);
    const sent = sc(await client.callTool({ name: "send_rent_invoice", arguments: { flag_id: "Jaramillo household" } }));
    expect(sent).toMatchObject({ flag_id: "tamarind-grove:occupied_no_rent:B-12", tenant: "Jaramillo household", already_sent: false });
    const early = await client.callTool({ name: "record_rent_payment", arguments: { flag_id: "Harbor Light" } });
    expect(errorOf(early).code).toBe("not_invoiced"); // resolved by name, but no invoice was sent yet
    expect(findBill("Suite 104")?.tenant).toBe("Harbor Light Pilates");
    expect(findBill("someone else")).toBeUndefined();
  });

  it("will not record a payment before an invoice exists", async () => {
    const client = await connect(fakePayPal().pp);
    const r = await client.callTool({ name: "record_rent_payment", arguments: { flag_id: "tamarind-grove:occupied_no_rent:B-12" } });
    expect(errorOf(r).code).toBe("not_invoiced");
  });

  it("names the bills when asked to send one that does not exist", async () => {
    const client = await connect(fakePayPal().pp);
    const r = await client.callTool({ name: "send_rent_invoice", arguments: { flag_id: "coral-wren-plaza:misposted_cam_reconciliation:all" } });
    expect(errorOf(r).code).toBe("unknown_bill");
    expect(errorOf(r).bills).toHaveLength(2);
  });

  it("says PayPal is not connected instead of pretending to send", async () => {
    const client = await connect(new PayPal("", ""));
    const r = await client.callTool({ name: "send_rent_invoice", arguments: { flag_id: "tamarind-grove:occupied_no_rent:B-12" } });
    expect(errorOf(r).code).toBe("paypal_not_connected");
    const d = sc(await client.callTool({ name: "draft_rent_invoices", arguments: {} }));
    expect(d.paypal_connected).toBe(false);
    expect(d.bills).toHaveLength(2);
  });

  it("reset undoes recorded payments and cancels every sent invoice", async () => {
    const { pp, store } = fakePayPal();
    const b = findBill("tamarind-grove:occupied_no_rent:B-12")!;
    const inv = await pp.send(b);
    await pp.recordPayment(inv.invoice_id, 5190, "CHECK");
    expect(await pp.reset()).toBe(1);
    expect([...store.values()].map((i) => [i.status, i.paid])).toEqual([["CANCELLED", 0]]);
  });
});

describe("a rent collection conversation with the offline brain", () => {
  it("drafts, bills the first tenant after approval, takes a check and reports who still owes", async () => {
    const { OfflinePlanner } = await import("../src/assistant/planner.js");
    const { listProperties } = await import("../src/domain.js");
    const client = await connect(fakePayPal().pp);
    const { tools } = await client.listTools();
    const brain = new OfflinePlanner(listProperties());
    const messages: any[] = [];
    const approvals: string[] = [];
    async function say(text: string) {
      messages.push({ role: "user", content: [{ text }] });
      for (let i = 0; i < 5; i++) {
        const out: any = await brain.next({ messages, tools: tools as any });
        messages.push(out.message);
        if (out.stop === "end_turn") return out.text as string;
        if (tools.find((t) => t.name === out.toolUse.name)?.annotations?.readOnlyHint !== true) approvals.push(out.toolUse.name);
        const r: any = await client.callTool({ name: out.toolUse.name, arguments: out.toolUse.input });
        const json = r.isError ? JSON.parse(r.content[0].text) : r.structuredContent;
        messages.push({ role: "user", content: [{ toolResult: { toolUseId: out.toolUse.toolUseId, status: r.isError ? "error" : "success", content: [{ json }] } }] });
      }
      throw new Error("no answer");
    }
    expect(await say("What rent can I bill right now?")).toMatch(/^You can bill \$14,190 to 2 tenants\. First, Harbor Light Pilates/);
    expect(await say("Bill the first one.")).toBe("Sent. Harbor Light Pilates has a PayPal invoice for $9,000, due in 10 days.");
    expect(await say("Harbor Light Pilates paid by check.")).toBe("Recorded $9,000 from Harbor Light Pilates. The invoice is paid in full.");
    expect(await say("Who still owes me?")).toBe("You have billed $9,000 and collected $9,000, so $0 is still due. $5,190 has not been invoiced yet.");
    expect(approvals).toEqual(["send_rent_invoice", "record_rent_payment"]);
  });
});

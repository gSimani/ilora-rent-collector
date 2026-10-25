/**
 * Offline planner: a small, deterministic stand-in for the Nemotron brain so the
 * simulator and tests run with no AWS account. It reads the same tool list and
 * calls the same MCP tools; only the language understanding is rule-based.
 * The simulator labels which brain answered every turn.
 */
import { collectibleBills } from "../paypal.js";
import type { Block, Brain, BrainRequest, Message, McpTool, ToolResultBlock } from "./types.js";

const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
// Ordinal words only: "the second one" must not match the bare word "one".
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, "number one": 1, second: 2, "2nd": 2, "number two": 2, third: 3, "3rd": 3, "number three": 3, fourth: 4, fifth: 5, last: -1 };
const spokenDate = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const monthOnly = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

/** Spoken phrase for a reconciliation cause, from its rule and data. `lead` reads after "mostly from". */
function causePhrase(c: { rule: string; unit: string; months: string[] }, lead: boolean): string {
  const where = /^\d/.test(c.unit) ? `Suite ${c.unit}` : `Unit ${c.unit}`;
  switch (c.rule) {
    case "unbilled_rent_step":
      return lead ? `${where}, whose lease shows a rent step in ${monthOnly(c.months[0])} that wasn't billed` : `is ${where}'s ${monthOnly(c.months[0])} rent step, not billed`;
    case "misposted_cam_reconciliation":
      return lead ? `a CAM reconciliation for ${where} posted to base rent` : `is a CAM reconciliation for ${where} posted to base rent instead of CAM recoveries`;
    case "occupied_no_rent":
      return lead ? `${where}, which shows occupied but has no rent posted for ${c.months.length} months` : `is ${where}, occupied with no rent posted`;
    default:
      return lead ? `${where}` : `is from ${where}`;
  }
}

type ToolCallRecord ={ name: string; input: Record<string, unknown>; result: Record<string, unknown> | undefined; isError: boolean };

/** Every tool call in the conversation, oldest first, with its result. */
function history(messages: Message[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  const byId = new Map<string, ToolCallRecord>();
  for (const m of messages)
    for (const b of m.content) {
      if ("toolUse" in b) {
        const rec = { name: b.toolUse.name, input: b.toolUse.input, result: undefined, isError: false };
        byId.set(b.toolUse.toolUseId, rec);
        calls.push(rec);
      } else if ("toolResult" in b) {
        const rec = byId.get(b.toolResult.toolUseId);
        if (!rec) continue;
        const json = b.toolResult.content.find((c): c is { json: unknown } => "json" in c);
        rec.result = json?.json as Record<string, unknown>;
        rec.isError = b.toolResult.status === "error";
      }
    }
  return calls;
}

const lastUserText = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].content.find((b): b is { text: string } => "text" in b);
    if (messages[i].role === "user" && t) return t.text;
  }
  return "";
};

function ordinal(text: string): number | undefined {
  for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`, "i").test(text)) return n;
  return undefined;
}

function monthsAhead(text: string): number | undefined {
  const t = text.toLowerCase();
  const d = t.match(/(\d+)\s*days?/);
  if (d) return Math.max(1, Math.round(Number(d[1]) / 30));
  const m = t.match(/(\d+|one|two|three|six|nine|twelve|eighteen|twenty[- ]four)\s*months?/);
  if (m) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, six: 6, nine: 9, twelve: 12, eighteen: 18, "twenty four": 24, "twenty-four": 24 };
    return Number(m[1]) || words[m[1]];
  }
  if (/\bquarter\b/.test(t)) return 3;
  if (/\b(year|twelve months)\b/.test(t)) return 12; // "this year", "next year": a 12-month window
  return undefined;
}

/**
 * The owner's memo from a finished review. Money that was earned but not
 * collected comes first, largest first; leases ending soon follow as a separate
 * list, because they are a risk to plan for, not a loss that already happened.
 */
export function reviewMemo(calls: ToolCallRecord[]): string {
  const gaps: { amount: number; line: string }[] = [];
  const ending: { amount: number; line: string }[] = [];
  let clean = 0;
  for (const c of calls) {
    const r = c.result;
    if (!r || c.isError) continue;
    if (c.name === "check_rent_roll_vs_statement") {
      const k = r as { name: string; matches: boolean; causes: { rule: string; unit: string; amount: number; months: string[] }[] };
      if (k.matches) clean++;
      for (const x of k.causes ?? []) gaps.push({ amount: x.amount, line: `${k.name}: ${money(x.amount)} from ${causePhrase(x, true)}.` });
    }
    if (c.name === "list_expiring_leases") {
      const e = r as { name: string; count: number; total_annual_rent: number; share_of_income_pct: number };
      if (e.count) ending.push({ amount: e.total_annual_rent, line: `${e.name}: ${e.count} ${e.count === 1 ? "lease ends" : "leases end"} within three months, ${money(e.total_annual_rent)} a year, ${e.share_of_income_pct}% of rent roll income.` });
    }
  }
  if (!gaps.length && !ending.length) return "Every property reconciles and no leases end in the next three months.";
  const total = gaps.reduce((t, g) => t + g.amount, 0);
  const out: string[] = [];
  if (gaps.length) {
    gaps.sort((a, b) => b.amount - a.amount);
    out.push(`Money to collect: ${money(total)} across ${gaps.length} ${gaps.length === 1 ? "item" : "items"}, largest first.`);
    gaps.forEach((g, i) => out.push(`${i + 1}. ${g.line}`));
  }
  if (ending.length) {
    ending.sort((a, b) => b.amount - a.amount);
    out.push("Leases to renew:");
    ending.forEach((g) => out.push(`- ${g.line}`));
  }
  if (clean) out.push(`${clean} ${clean === 1 ? "property reconciles" : "properties reconcile"} with no gap.`);
  return out.join("\n");
}

export class OfflinePlanner implements Brain {
  name = "offline-planner";
  constructor(private propertyNames: { property_id: string; name: string }[] = []) {}

  private property(text: string, calls: ToolCallRecord[]): string | undefined {
    const t = text.toLowerCase();
    for (const p of this.propertyNames) {
      const words = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !["apartments", "plaza", "grove", "commons", "court"].includes(w));
      if (words.some((w) => t.includes(w)) || t.includes(p.name.toLowerCase())) return p.property_id;
    }
    for (let i = calls.length - 1; i >= 0; i--) {
      const id = (calls[i].result?.property_id ?? calls[i].input.property) as string | undefined;
      if (id) return id;
    }
    return undefined;
  }

  async next({ messages, tools, mode }: BrainRequest) {
    const calls = history(messages);
    if (mode === "review") return this.review(calls);
    const last = messages[messages.length - 1];
    const has = (n: string) => tools.some((t: McpTool) => t.name === n);

    // A tool just returned: speak the answer.
    const tr = last.content.find((b): b is ToolResultBlock => "toolResult" in b);
    if (tr) {
      const call = calls[calls.length - 1];
      return this.say(this.answer(call, lastUserText(messages)));
    }

    const text = lastUserText(messages);
    const t = text.toLowerCase();
    const prop = this.property(text, calls);
    const prev = calls[calls.length - 1];
    const n = ordinal(t);

    // Follow-ups that refer to an item in the previous answer.
    if (n && prev?.result && /\b(one|it|that|them|lines|about|more|show)\b/.test(t)) {
      const list = (prev.result.causes ?? prev.result.leases ?? prev.result.bills) as Record<string, unknown>[] | undefined;
      if (list?.length) {
        const item = n === -1 ? list[list.length - 1] : list[n - 1];
        if (!item) return this.say(`There are only ${list.length} in that list.`);
        if (prev.name === "check_rent_roll_vs_statement" && has("explain_flag")) return this.use("explain_flag", { flag_id: item.flag_id as string });
        if (prev.name === "draft_rent_invoices" && /\b(bill|send|invoice)\b/.test(t)) return this.use("send_rent_invoice", { flag_id: item.flag_id as string });
        if (prev.name === "draft_rent_invoices" || prev.name === "rent_collection_status") return this.use("explain_flag", { flag_id: item.flag_id as string });
        if (prev.name === "list_expiring_leases") {
          const l = item as { label: string; expiration_date: string; days_until_expiration: number; monthly_rent: number; annual_rent: number; share_of_income_pct: number };
          return this.say(`${l.label}. The lease ends ${spokenDate(l.expiration_date)}, ${l.days_until_expiration} days after the latest rent roll. Rent is ${money(l.monthly_rent)} a month, ${money(l.annual_rent)} a year, ${l.share_of_income_pct}% of rent roll income.`);
        }
      }
    }
    if (/\b(show|see).*(lines|source)|\bwhy\b/.test(t) && prev?.name === "check_rent_roll_vs_statement") {
      const first = (prev.result?.causes as { flag_id: string }[] | undefined)?.[0];
      if (first) return this.use("explain_flag", { flag_id: first.flag_id });
    }

    // Rent collection.
    const bill = collectibleBills().find((b) => t.includes(b.tenant.toLowerCase().split(" ")[0]));
    if (/\b(paid|payment|check came|received)\b/.test(t) && bill && has("record_rent_payment")) {
      const amount = t.match(/\$?\s*([\d,]+(?:\.\d\d)?)\b/);
      const method = /\bcash\b/.test(t) ? "CASH" : /\b(transfer|wire|ach)\b/.test(t) ? "BANK_TRANSFER" : "CHECK";
      const n = amount ? Number(amount[1].replace(/,/g, "")) : 0;
      return this.use("record_rent_payment", n >= 1 ? { flag_id: bill.flag_id, amount: n, method } : { flag_id: bill.flag_id, method });
    }
    if (/\b(still owe|who owes|owes me|outstanding|been paid|collected)\b/.test(t) && has("rent_collection_status")) return this.use("rent_collection_status", {});
    if (/\b(bill|invoice|send)\b/.test(t) && bill && has("send_rent_invoice")) return this.use("send_rent_invoice", { flag_id: bill.flag_id });
    if (/\b(bill|invoice|collect)\b/.test(t) && has("draft_rent_invoices")) return this.use("draft_rent_invoices", {});

    if (/\b(what|which) (properties|buildings)|\bmy properties\b|\blist (my )?properties\b/.test(t)) return this.use("list_properties", {});
    if (!prop) return this.use("list_properties", {});
    if (/\b(match|reconcile|add up|tie out|line up|short|statement|income statement|check out|discrepanc)/.test(t)) return this.use("check_rent_roll_vs_statement", { property: prop });
    if (/\b(expir|ending|end soon|renew|roll ?over|move.?outs?|moving out|leaving|vacating|leases? (end|up))/.test(t)) {
      const m = monthsAhead(t);
      return this.use("list_expiring_leases", m ? { property: prop, months_ahead: m } : { property: prop });
    }
    return this.use("get_property_snapshot", { property: prop });
  }

  /**
   * Portfolio review: list the properties, then for each one take the snapshot,
   * reconcile the rent roll and look for leases ending within three months.
   * When every check has run, write the owner's memo, largest dollar issue first.
   */
  private review(calls: ToolCallRecord[]) {
    const done = (name: string, id?: string) => calls.some((c) => c.name === name && !c.isError && (!id || c.input.property === id));
    if (!done("list_properties")) return this.use("list_properties", {});
    const props = (calls.find((c) => c.name === "list_properties")?.result?.properties ?? []) as { property_id: string; name: string }[];
    for (const p of props) {
      if (!done("get_property_snapshot", p.property_id)) return this.use("get_property_snapshot", { property: p.property_id });
      if (!done("check_rent_roll_vs_statement", p.property_id)) return this.use("check_rent_roll_vs_statement", { property: p.property_id });
      if (!done("list_expiring_leases", p.property_id)) return this.use("list_expiring_leases", { property: p.property_id, months_ahead: 3 });
    }
    return this.say(reviewMemo(calls));
  }

  private use(name: string, input: Record<string, unknown>) {
    const toolUse = { toolUseId: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name, input };
    const message: Message = { role: "assistant", content: [{ toolUse }] };
    return Promise.resolve({ stop: "tool_use" as const, message, toolUse });
  }

  private say(text: string) {
    const message: Message = { role: "assistant", content: [{ text } as Block] };
    return Promise.resolve({ stop: "end_turn" as const, message, text });
  }

  /** Turns a structured tool result into a short spoken answer. */
  private answer(call: ToolCallRecord, question: string): string {
    const r = call.result ?? {};
    if (call.isError) {
      const e = (r.error ?? {}) as { code?: string; did_you_mean?: { name: string }[] };
      if (e.code === "unknown_property") return `I couldn't find that property. Did you mean ${(e.did_you_mean ?? []).map((p) => p.name).join(" or ")}?`;
      if (e.code === "owner_declined") return "Okay. Nothing was sent.";
      if (e.code && ["paypal_not_connected", "not_invoiced", "already_paid", "paypal_error", "paypal_unreachable"].includes(e.code)) return String((e as { message?: string }).message ?? "PayPal did not complete that.");
      return "I couldn't find that item. Want me to run the check again?";
    }
    switch (call.name) {
      case "list_properties": {
        const ps = r.properties as { name: string; city: string }[];
        return `You have ${ps.length} properties: ${ps.map((p) => `${p.name} in ${p.city}`).join(", and ")}.`;
      }
      case "get_property_snapshot": {
        const s = r as { name: string; occupancy_pct: number; noi_t12: number; open_flags: number; top_flag: { label: string } | null };
        if (/occupan/i.test(question) && !/noi|income|doing/i.test(question)) return `${s.name} is ${s.occupancy_pct}% occupied.`;
        return `${s.name} is ${s.occupancy_pct}% occupied, with net operating income of ${money(s.noi_t12)} over the last 12 months. ${
          s.open_flags ? `There ${s.open_flags === 1 ? "is one item" : `are ${s.open_flags} items`} to check, starting with ${s.top_flag?.label}.` : "Everything checks out."
        }`;
      }
      case "check_rent_roll_vs_statement": {
        const c = r as { name: string; matches: boolean; rent_roll_total: number; statement_total: number; gap: number; causes: { rule: string; unit: string; amount: number; months: string[] }[] };
        if (c.matches) return `Yes. Rental income on the statement matches the rent roll at ${money(c.rent_roll_total)}.`;
        const [top, ...rest] = c.causes;
        const others = rest.map((x) => `${money(x.amount)} ${causePhrase(x, false)}`).join(", and ");
        return `Not quite. Rental income is ${money(c.gap)} short of the rent roll, mostly from ${causePhrase(top, true)}, ${money(top.amount)}.${
          others ? ` The other ${others}.` : ""
        } Want me to show the lines?`;
      }
      case "list_expiring_leases": {
        const e = r as { count: number; months_ahead: number; total_annual_rent: number; share_of_income_pct: number; leases: { label: string; expiration_date: string }[] };
        if (!e.count) return `No leases end in the next ${e.months_ahead} months.`;
        const names = e.leases.slice(0, 3).map((l, i) => `${["first", "second", "third"][i]}, ${l.label}, on ${spokenDate(l.expiration_date)}`);
        return `${e.count} ${e.count === 1 ? "lease ends" : "leases end"} in the next ${e.months_ahead} months, worth ${money(e.total_annual_rent)} a year, ${e.share_of_income_pct}% of income: ${names.join("; ")}${e.count > 3 ? `, and ${e.count - 3} more` : ""}.`;
      }
      case "explain_flag": {
        const f = r as { reason: string; suggested_fix: string; sources: { document: string; page: number; line?: number; period?: string }[] };
        // Prefer a dated statement line (where the money actually posted), then any line, then the document.
        const s = f.sources.find((x) => x.period) ?? f.sources.find((x) => x.line) ?? f.sources[0];
        return `${f.reason} The first line is on page ${s.page}${s.line ? `, line ${s.line}` : ""} of the ${s.document}. ${f.suggested_fix}`;
      }
      case "draft_rent_invoices": {
        const d = r as { total_owed: number; not_yet_invoiced: number; bills: { tenant: string; amount: number; line_item: string; property_name: string; invoice: { status: string } | null }[] };
        if (!d.bills.length) return "No tenant owes rent that was not billed.";
        const lines = d.bills.map((b, i) => `${["First", "Second", "Third"][i] ?? `Number ${i + 1}`}, ${b.tenant} at ${b.property_name}, ${money(b.amount)}: ${b.line_item.toLowerCase()}${b.invoice ? `, already invoiced (${b.invoice.status.toLowerCase().replace(/_/g, " ")})` : ""}.`);
        return `You can bill ${money(d.total_owed)} to ${d.bills.length} ${d.bills.length === 1 ? "tenant" : "tenants"}. ${lines.join(" ")}${d.not_yet_invoiced ? " Want me to send the first invoice?" : ""}`;
      }
      case "send_rent_invoice": {
        const x = r as { tenant: string; already_sent: boolean; invoice: { amount: number; status: string } };
        return x.already_sent
          ? `${x.tenant} already has a PayPal invoice for ${money(x.invoice.amount)}, so I did not send another. Its status is ${x.invoice.status.toLowerCase().replace(/_/g, " ")}.`
          : `Sent. ${x.tenant} has a PayPal invoice for ${money(x.invoice.amount)}, due in 10 days.`;
      }
      case "rent_collection_status": {
        const c = r as { billed: number; collected: number; still_due: number; not_yet_invoiced: number; bills: { tenant: string; invoice: { due: number; status: string } | null }[] };
        const owing = c.bills.filter((b) => b.invoice && b.invoice.due > 0).map((b) => `${b.tenant} owes ${money(b.invoice!.due)}`);
        return `You have billed ${money(c.billed)} and collected ${money(c.collected)}, so ${money(c.still_due)} is still due.${owing.length ? ` ${owing.join("; ")}.` : ""}${c.not_yet_invoiced ? ` ${money(c.not_yet_invoiced)} has not been invoiced yet.` : ""}`;
      }
      case "record_rent_payment": {
        const x = r as { tenant: string; recorded: number; invoice: { due: number } };
        return `Recorded ${money(x.recorded)} from ${x.tenant}. ${x.invoice.due > 0 ? `${money(x.invoice.due)} is still due.` : "The invoice is paid in full."}`;
      }
      default:
        return "Done.";
    }
  }
}

/**
 * ILORA.ai MCP server for the Building Analyst.
 *
 * Five intent-shaped tools. Each returns complete structured data (outputSchema +
 * structuredContent) and never scripts prose: the model writes the reply.
 * Failures return isError with a structured error that names alternatives.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  allFlagIds,
  expiringLeases,
  findFlag,
  listProperties,
  reconcile,
  resolveProperty,
  snapshot,
} from "./domain.js";
import { registerUiResources, UI } from "./ui.js";
import { collectibleBills, findBill, PayPal, PayPalError, type Bill, type InvoiceStatus } from "./paypal.js";

export const SERVER_INFO = { name: "ilora-building-analyst", title: "ILORA.ai property checks", version: "0.1.0" };

const DATA_NOTE = "Demo data: fictional properties and tenants.";

// ------------------------------------------------------------------ shared schemas

const source = z.object({
  document: z.string().describe("Source document title"),
  page: z.number().int().describe("Page number in the source document"),
  line: z.number().int().optional().describe("Line number on that page"),
  label: z.string().describe("What this line says, in plain words"),
  amount: z.number().optional().describe("Dollar amount on the line"),
  period: z.string().optional().describe("Month the line belongs to, YYYY-MM"),
});

const propertyArg = z
  .string()
  .min(1)
  .describe("Property id from list_properties, or the property's name as the customer said it, e.g. 'Coral Wren Plaza'.");

function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

/**
 * Errors carry their JSON in the text content only. The SDK client validates
 * structuredContent against the tool's outputSchema even when isError is set,
 * so putting an error object there makes a strict client throw instead of
 * reading the error.
 */
function fail(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...extra } }) }] };
}

function unknownProperty(query: string, candidates: { property_id: string; name: string }[]): CallToolResult {
  return fail("unknown_property", `No property matches "${query}". Ask which of these the customer means.`, { did_you_mean: candidates });
}

// ------------------------------------------------------------------ server

const invoiceShape = z.object({
  status: z.string().describe("PayPal invoice status, e.g. SENT, PAID, MARKED_AS_PAID, PARTIALLY_PAID"),
  amount: z.number(),
  paid: z.number(),
  due: z.number(),
  invoice_date: z.string().optional(),
  tenant_link: z.string().optional().describe("The page where the tenant pays"),
});

const billShape = z.object({
  flag_id: z.string(),
  property_id: z.string(),
  property_name: z.string(),
  unit: z.string(),
  tenant: z.string(),
  tenant_email: z.string(),
  amount: z.number(),
  months: z.array(z.string()),
  line_item: z.string(),
  reason: z.string(),
  invoice: invoiceShape.nullable().describe("The PayPal invoice for this amount, or null if none was sent"),
});

/** The model never sees PayPal's invoice number, so it cannot read one aloud; the screen shows the tenant link instead. */
const strip = ({ flag_id: _f, invoice_id: _i, ...rest }: InvoiceStatus) => rest;

function payPalFailure(err: unknown): CallToolResult {
  if (err instanceof PayPalError) return fail("paypal_error", `PayPal did not accept the request: ${err.issue}`, { http_status: err.status });
  return fail("paypal_unreachable", `PayPal could not be reached: ${(err as Error).message}`);
}

/** Bills for one property (or all), each joined to its live PayPal invoice. */
async function billsWithInvoices(pp: PayPal, propertyId?: string) {
  const live = pp.configured ? (await pp.invoices()).filter((i) => i.status !== "CANCELLED") : [];
  return collectibleBills(propertyId).map((b: Bill) => {
    const inv = live.find((i) => i.flag_id === b.flag_id);
    return { ...b, invoice: inv ? strip(inv) : null };
  });
}


let shared: PayPal | undefined;
/** One client per process, so its access token is reused across stateless requests. */
const sharedPayPal = () => (shared ??= new PayPal());

export function createServer(paypal: PayPal = sharedPayPal()): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "Answers questions about a commercial property's rent roll, operating statement and lease expirations, explains any figure that does not reconcile with the source page and line, and bills the rent tenants owe through PayPal invoices once the owner approves. All money is US dollars. The data is a fictional demo portfolio; PayPal runs in sandbox.",
  });

  registerUiResources(server);

  // 1. list_properties
  server.registerTool(
    "list_properties",
    {
      title: "List properties",
      description:
        "Call when the customer asks which properties they have, or when you need a property id and the customer has not named one clearly. Returns id, name, type and city for every property in the account. Does not return any financial figures.",
      inputSchema: {},
      outputSchema: {
        properties: z.array(
          z.object({ property_id: z.string(), name: z.string(), property_type: z.string(), city: z.string(), state: z.string() }),
        ),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok({ properties: listProperties(), note: DATA_NOTE }),
  );

  // 2. get_property_snapshot
  server.registerTool(
    "get_property_snapshot",
    {
      title: "Property snapshot",
      description:
        "Call when the customer asks how a property is doing, or asks for its occupancy, net operating income (NOI), rent or number of issues. Returns occupancy, rent scheduled on the rent roll and rental income on the operating statement for the trailing 12 months, NOI, and how many verification flags are open with the most important one. Does not list the flags in detail (use check_rent_roll_vs_statement or explain_flag) or list leases (use list_expiring_leases).",
      inputSchema: { property: propertyArg },
      outputSchema: {
        property_id: z.string(),
        name: z.string(),
        property_type: z.string(),
        city: z.string(),
        state: z.string(),
        as_of_date: z.string().describe("Date of the latest rent roll, YYYY-MM-DD"),
        period: z.object({ start: z.string(), end: z.string(), label: z.string() }),
        occupancy_pct: z.number(),
        occupancy_basis: z.string(),
        scheduled_rent_t12: z.number().describe("Rent the leases call for over the period, from the rent roll"),
        rental_income_t12: z.number().describe("Rental income posted on the operating statement over the period"),
        rent_gap_t12: z.number().describe("scheduled_rent_t12 minus rental_income_t12"),
        total_revenue_t12: z.number(),
        operating_expenses_t12: z.number(),
        noi_t12: z.number().describe("Net operating income: total revenue minus operating expenses"),
        open_flags: z.number().int(),
        top_flag: z.object({ flag_id: z.string(), label: z.string() }).nullable(),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ property }) => {
      const r = resolveProperty(property);
      if (!r.ok) return unknownProperty(r.query, r.candidates);
      return ok({ ...snapshot(r.data), note: DATA_NOTE });
    },
  );

  // 3. check_rent_roll_vs_statement
  server.registerTool(
    "check_rent_roll_vs_statement",
    {
      title: "Check rent roll against income statement",
      description:
        "Call when the customer asks whether their rent roll matches their income or operating statement, why rental income is short, or whether the numbers check out. Compares rent scheduled on the rent roll and leases with rental income posted on the operating statement for the trailing 12 months, and returns both totals, the gap, and every cause ranked by dollar amount, each with a plain reason, a suggested fix, and the source document, page and line. Does not change any records.",
      inputSchema: { property: propertyArg },
      outputSchema: {
        property_id: z.string(),
        name: z.string(),
        period: z.object({ start: z.string(), end: z.string() }),
        matches: z.boolean().describe("True when the two totals agree to the dollar"),
        rent_roll_total: z.number(),
        statement_total: z.number(),
        gap: z.number().describe("rent_roll_total minus statement_total; positive means the statement is short"),
        unexplained: z.number().describe("Part of the gap no cause accounts for; 0 when fully explained"),
        causes: z.array(
          z.object({
            position: z.number().int(),
            flag_id: z.string().describe("Pass to explain_flag for the detail"),
            rule: z
              .enum(["unbilled_rent_step", "misposted_cam_reconciliation", "occupied_no_rent", "under_billed_rent", "over_billed_rent", "unmatched_posting"])
              .describe("Which check found it"),
            label: z.string(),
            unit: z.string(),
            tenant: z.string(),
            amount: z.number().describe("How much of the gap this cause explains"),
            share_of_gap_pct: z.number(),
            months: z.array(z.string()),
            reason: z.string(),
            suggested_fix: z.string(),
            sources: z.array(source),
          }),
        ),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.rentCheck }, "ui/resourceUri": UI.rentCheck },
    },
    async ({ property }) => {
      const r = resolveProperty(property);
      if (!r.ok) return unknownProperty(r.query, r.candidates);
      const rec = reconcile(r.data);
      const p = r.data.property;
      return ok({
        property_id: p.property_id,
        name: p.name,
        period: { start: p.period_start, end: p.period_end },
        matches: rec.gap === 0,
        rent_roll_total: rec.scheduled_rent,
        statement_total: rec.rental_income,
        gap: rec.gap,
        unexplained: rec.unexplained,
        causes: rec.causes.map((c, i) => ({
          position: i + 1,
          flag_id: c.flag_id,
          rule: c.rule,
          label: c.label,
          unit: c.unit,
          tenant: c.tenant,
          amount: c.amount,
          share_of_gap_pct: rec.gap ? Math.round((c.amount / rec.gap) * 1000) / 10 : 0,
          months: c.months,
          reason: c.reason,
          suggested_fix: c.suggested_fix,
          sources: c.sources,
        })),
        note: DATA_NOTE,
      });
    },
  );

  // 4. list_expiring_leases
  server.registerTool(
    "list_expiring_leases",
    {
      title: "Leases expiring soon",
      description:
        "Call when the customer asks which leases expire or end soon, or what rent is at risk from move-outs. Returns every occupied lease ending within the next months_ahead months of the latest rent roll date, soonest first, with tenant, unit, end date, rent and share of rent roll income, plus totals. Each lease has a position (1, 2, 3...) and a stable item_id so the customer can say 'the second one'. Does not include vacant units or renewal terms.",
      inputSchema: {
        property: propertyArg,
        months_ahead: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(12)
          .describe("How many months ahead to look, from the latest rent roll date. 'Next 90 days' is 3."),
      },
      outputSchema: {
        property_id: z.string(),
        name: z.string(),
        window_start: z.string(),
        window_end: z.string(),
        months_ahead: z.number().int(),
        count: z.number().int(),
        total_annual_rent: z.number(),
        share_of_income_pct: z.number(),
        leases: z.array(
          z.object({
            position: z.number().int(),
            item_id: z.string(),
            label: z.string(),
            tenant: z.string(),
            unit: z.string(),
            expiration_date: z.string(),
            days_until_expiration: z.number().int(),
            monthly_rent: z.number(),
            annual_rent: z.number(),
            share_of_income_pct: z.number(),
            source,
          }),
        ),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.leaseList }, "ui/resourceUri": UI.leaseList },
    },
    async ({ property, months_ahead }) => {
      const r = resolveProperty(property);
      if (!r.ok) return unknownProperty(r.query, r.candidates);
      const e = expiringLeases(r.data, months_ahead ?? 12);
      return ok({ property_id: r.data.property.property_id, name: r.data.property.name, ...e, note: DATA_NOTE });
    },
  );

  // 5. explain_flag
  server.registerTool(
    "explain_flag",
    {
      title: "Explain a verification flag",
      description:
        "Call when the customer asks why something is flagged, asks to see the lines behind a mismatch, or picks one cause from a previous answer ('tell me about the first one'). Takes a flag_id returned by get_property_snapshot or check_rent_roll_vs_statement. Returns the rule that fired, the figures, every source citation (document, page, line) and a suggested fix. Does not resolve or dismiss the flag.",
      inputSchema: { flag_id: z.string().min(1).describe("A flag_id from an earlier result") },
      outputSchema: {
        flag_id: z.string(),
        property_id: z.string(),
        property_name: z.string(),
        rule: z.string(),
        label: z.string(),
        severity: z.enum(["high", "medium", "info"]),
        amount: z.number(),
        reason: z.string(),
        suggested_fix: z.string(),
        figures: z.array(z.object({ label: z.string(), value: z.number(), unit: z.enum(["USD", "percent", "count"]) })),
        sources: z.array(source),
        note: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ flag_id }) => {
      const hit = findFlag(flag_id);
      if (!hit) {
        return fail("unknown_flag", `No open flag has id "${flag_id}". Use one of the open flags below, or run check_rent_roll_vs_statement first.`, {
          open_flags: allFlagIds(),
        });
      }
      return ok({
        ...hit.flag,
        property_id: hit.property.property_id,
        property_name: hit.property.name,
        note: DATA_NOTE,
      });
    },
  );

  // 6. draft_rent_invoices
  server.registerTool(
    "draft_rent_invoices",
    {
      title: "Draft rent invoices",
      description:
        "Call when the owner asks what rent they can bill or collect, or wants invoices prepared. Returns every amount a tenant owes from the rent roll check, largest first, with the invoice line it would carry and whether a PayPal invoice was already sent. Covers every property in the portfolio. Sends nothing. A CAM charge posted to the wrong account is a bookkeeping fix and is not included.",
      inputSchema: {},
      outputSchema: { bills: z.array(billShape), total_owed: z.number(), not_yet_invoiced: z.number(), paypal_connected: z.boolean(), note: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const bills = await billsWithInvoices(paypal);
        const total = bills.reduce((a, b) => a + b.amount, 0);
        const open = bills.filter((b) => !b.invoice).reduce((a, b) => a + b.amount, 0);
        return ok({ bills, total_owed: total, not_yet_invoiced: open, paypal_connected: paypal.configured, note: DATA_NOTE });
      } catch (err) {
        return payPalFailure(err);
      }
    },
  );

  // 7. send_rent_invoice
  server.registerTool(
    "send_rent_invoice",
    {
      title: "Send rent invoice",
      description:
        "Call when the owner asks to bill a tenant; pass the flag_id from draft_rent_invoices or simply the tenant's name. Creates a PayPal invoice for that tenant and sends it. The page asks the owner to approve before this runs. Calling it again for the same amount returns the invoice already sent; it never bills a tenant twice.",
      inputSchema: { flag_id: z.string().min(1).describe("flag_id of a bill from draft_rent_invoices, or the tenant's name, e.g. 'Harbor Light Pilates'") },
      outputSchema: { flag_id: z.string(), tenant: z.string(), property_name: z.string(), unit: z.string(), already_sent: z.boolean(), invoice: invoiceShape, note: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ flag_id }) => {
      const bill = findBill(flag_id);
      if (!bill) {
        return fail("unknown_bill", `Nothing to bill for "${flag_id}". Use one of these.`, {
          bills: collectibleBills().map((b) => ({ flag_id: b.flag_id, tenant: b.tenant, amount: b.amount })),
        });
      }
      if (!paypal.configured) return fail("paypal_not_connected", "PayPal is not connected on this server, so no invoice was sent.");
      try {
        const { already_sent, ...inv } = await paypal.send(bill);
        return ok({ flag_id: bill.flag_id, tenant: bill.tenant, property_name: bill.property_name, unit: bill.unit, already_sent, invoice: strip(inv), note: already_sent ? `Already sent earlier; not sent again. ${DATA_NOTE}` : `Sent to the tenant after the owner approved. Due in 10 days. ${DATA_NOTE} PayPal sandbox.` });
      } catch (err) {
        return payPalFailure(err);
      }
    },
  );

  // 8. rent_collection_status
  server.registerTool(
    "rent_collection_status",
    {
      title: "Rent collection status",
      description:
        "Call when the owner asks what was billed, what has been paid, or who still owes. Returns each amount owed with its PayPal invoice status, plus totals billed, collected and still due. Covers every property in the portfolio.",
      inputSchema: {},
      outputSchema: { bills: z.array(billShape), billed: z.number(), collected: z.number(), still_due: z.number(), not_yet_invoiced: z.number(), note: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!paypal.configured) return fail("paypal_not_connected", "PayPal is not connected on this server, so there is no invoice status to read.");
      try {
        const bills = await billsWithInvoices(paypal);
        const sum = (f: (b: (typeof bills)[number]) => number) => bills.reduce((a, b) => a + f(b), 0);
        return ok({
          bills,
          billed: sum((b) => b.invoice?.amount ?? 0),
          collected: sum((b) => b.invoice?.paid ?? 0),
          still_due: sum((b) => b.invoice?.due ?? 0),
          not_yet_invoiced: sum((b) => (b.invoice ? 0 : b.amount)),
          note: `${DATA_NOTE} PayPal sandbox.`,
        });
      } catch (err) {
        return payPalFailure(err);
      }
    },
  );

  // 9. record_rent_payment
  server.registerTool(
    "record_rent_payment",
    {
      title: "Record rent payment",
      description:
        "Call when the owner says a tenant paid an invoiced amount outside PayPal, for example by check. Marks the PayPal invoice paid for that amount. The page asks the owner to approve before this runs.",
      inputSchema: {
        flag_id: z.string().min(1).describe("flag_id of a bill that has a sent invoice, or the tenant's name"),
        amount: z.number().positive().optional().describe("Dollars received; defaults to the full amount due"),
        method: z.enum(["CHECK", "BANK_TRANSFER", "CASH"]).optional().describe("How the tenant paid; defaults to CHECK"),
      },
      outputSchema: { flag_id: z.string(), tenant: z.string(), recorded: z.number(), invoice: invoiceShape, note: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ flag_id, amount, method }) => {
      const bill = findBill(flag_id);
      if (!bill) return fail("unknown_bill", `Nothing was billed for "${flag_id}".`);
      if (!paypal.configured) return fail("paypal_not_connected", "PayPal is not connected on this server, so no payment was recorded.");
      try {
        const inv = await paypal.invoiceFor(bill.flag_id);
        if (!inv) return fail("not_invoiced", `${bill.tenant} has not been sent an invoice for this amount yet. Send it first.`);
        if (inv.due <= 0) return fail("already_paid", `${bill.tenant}'s invoice is already paid in full.`, { invoice: strip(inv) });
        const pay = Math.min(amount ?? inv.due, inv.due);
        const after = (await paypal.recordPayment(inv.invoice_id, pay, method ?? "CHECK")) ?? inv;
        return ok({ flag_id: bill.flag_id, tenant: bill.tenant, recorded: pay, invoice: strip(after), note: `Recorded after the owner approved. ${DATA_NOTE} PayPal sandbox.` });
      } catch (err) {
        return payPalFailure(err);
      }
    },
  );


  return server;
}

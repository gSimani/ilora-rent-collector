/**
 * PayPal Invoicing v2 for rent the checks found but nobody billed.
 *
 * Only sandbox is allowed: the demo tenants are fictional and their email
 * addresses are on example.com. Every invoice carries the ILORA flag id in
 * detail.reference, so PayPal itself is the record of what was billed and paid;
 * the server keeps no state and a Lambda cold start loses nothing.
 */
import { reconcile, unitWord, type Cause } from "./domain.js";
import { loadAll, type PropertyData } from "./data.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";

/** Rules where the tenant owes the amount. A CAM charge posted to the wrong account is a bookkeeping fix, not a bill. */
export const COLLECTIBLE = new Set(["unbilled_rent_step", "occupied_no_rent", "under_billed_rent"]);

/** Fictional billing contacts for the fictional tenants. */
const CONTACTS: Record<string, string> = {
  "Harbor Light Pilates": "billing@harborlightpilates.example.com",
  "Jaramillo household": "jaramillo.b12@example.com",
};

export type Bill = {
  flag_id: string;
  property_id: string;
  property_name: string;
  unit: string;
  tenant: string;
  tenant_email: string;
  amount: number;
  months: string[];
  line_item: string;
  reason: string;
};

const money = (n: number) => n.toFixed(2);
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function billOf(d: PropertyData, c: Cause): Bill {
  const span = c.months.length > 1 ? `${monthName(c.months[0])} to ${monthName(c.months[c.months.length - 1])}` : monthName(c.months[0]);
  const what = c.rule === "unbilled_rent_step" ? "Rent increase not billed" : c.rule === "occupied_no_rent" ? "Rent not billed" : "Rent under-billed";
  return {
    flag_id: c.flag_id,
    property_id: d.property.property_id,
    property_name: d.property.name,
    unit: `${unitWord(d)} ${c.unit}`,
    tenant: c.tenant,
    tenant_email: CONTACTS[c.tenant] ?? `tenant.${c.unit.toLowerCase()}@example.com`,
    amount: c.amount,
    months: c.months,
    line_item: `${what}, ${span} (${c.months.length} month${c.months.length === 1 ? "" : "s"})`,
    reason: c.reason,
  };
}

/** Every amount a tenant owes, largest first. Pure: reads the documents, touches nothing. */
export function collectibleBills(propertyId?: string): Bill[] {
  const out: Bill[] = [];
  for (const d of loadAll().values()) {
    if (propertyId && d.property.property_id !== propertyId) continue;
    for (const c of reconcile(d).causes) if (COLLECTIBLE.has(c.rule) && c.amount > 0) out.push(billOf(d, c));
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/** A bill by its flag id, or by what the owner calls it: the tenant's name, or the suite or unit. */
export function findBill(query: string) {
  const bills = collectibleBills();
  const exact = bills.find((b) => b.flag_id === query);
  if (exact) return exact;
  const q = query.toLowerCase().replace(/[^a-z0-9 -]/g, " ").trim();
  if (!q) return undefined;
  const hits = bills.filter((b) => {
    const tenant = b.tenant.toLowerCase();
    const unit = b.unit.toLowerCase().split(" ").pop()!;
    return tenant.includes(q) || q.includes(tenant) || q.includes(tenant.split(" ")[0]) || q.split(" ").includes(unit);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/** The invoice body PayPal receives. Exported so tests can assert it without a network. */
export function invoiceBody(b: Bill) {
  const [given, ...rest] = b.tenant.split(" ");
  return {
    detail: {
      currency_code: "USD",
      reference: b.flag_id,
      note: `${b.property_name}, ${b.unit}. ${b.reason}`.slice(0, 4000),
      memo: "Created by the ILORA.ai Rent Collector from the lease, rent roll and ledger.",
      payment_term: { term_type: "NET_10" },
    },
    invoicer: { business_name: `${b.property_name} (ILORA.ai demo)` },
    primary_recipients: [
      {
        billing_info: {
          business_name: b.tenant,
          name: { given_name: given, surname: rest.join(" ") || given },
          email_address: b.tenant_email,
        },
      },
    ],
    items: [
      {
        name: b.line_item,
        description: `${b.property_name} ${b.unit}`,
        quantity: "1",
        unit_amount: { currency_code: "USD", value: money(b.amount) },
        unit_of_measure: "AMOUNT",
      },
    ],
  };
}

export type InvoiceStatus = {
  invoice_id: string;
  flag_id: string;
  status: string;
  amount: number;
  paid: number;
  due: number;
  invoice_date?: string;
  tenant_link?: string;
};

type Fetch = typeof fetch;

export class PayPalError extends Error {
  constructor(readonly status: number, readonly issue: string) {
    super(`PayPal ${status}: ${issue}`);
  }
}

export class PayPal {
  private token?: { value: string; until: number };
  constructor(
    private readonly id = process.env.PAYPAL_CLIENT_ID ?? "",
    private readonly secret = process.env.PAYPAL_CLIENT_SECRET ?? "",
    private readonly base = process.env.PAYPAL_BASE_URL ?? SANDBOX,
    private readonly http: Fetch = fetch,
  ) {
    if (this.base !== SANDBOX) throw new Error("Only the PayPal sandbox is allowed in this demo.");
  }

  get configured() {
    return Boolean(this.id && this.secret);
  }

  private async auth() {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await this.http(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${this.id}:${this.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(res.status, "could not get an access token; check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let issue = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; details?: { issue?: string; description?: string }[] };
        issue = [j.message, ...(j.details ?? []).map((x) => x.description ?? x.issue)].filter(Boolean).join(" ");
      } catch {
        /* keep the raw text */
      }
      throw new PayPalError(res.status, issue);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Every invoice that carries an ILORA flag id, newest first. */
  async invoices(): Promise<InvoiceStatus[]> {
    type Inv = {
      id: string;
      status: string;
      detail: { reference?: string; invoice_date?: string; metadata?: { recipient_view_url?: string } };
      amount?: { value: string };
      due_amount?: { value: string };
      payments?: { paid_amount?: { value: string } };
    };
    const out: InvoiceStatus[] = [];
    for (let page = 1; page <= 5; page++) {
      const j = await this.call<{ items?: Inv[]; total_pages?: number }>("GET", `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true&fields=all`);
      for (const i of j.items ?? []) {
        if (!i.detail?.reference?.includes(":")) continue;
        const amount = Number(i.amount?.value ?? 0);
        const paid = Number(i.payments?.paid_amount?.value ?? 0);
        out.push({
          invoice_id: i.id,
          flag_id: i.detail.reference,
          status: i.status,
          amount,
          paid,
          due: Number(i.due_amount?.value ?? Math.max(amount - paid, 0)),
          invoice_date: i.detail.invoice_date,
          tenant_link: i.detail.metadata?.recipient_view_url,
        });
      }
      if (!j.total_pages || page >= j.total_pages) break;
    }
    return out;
  }

  /** The live invoice for a flag, ignoring cancelled ones. */
  async invoiceFor(flagId: string) {
    return (await this.invoices()).find((i) => i.flag_id === flagId && i.status !== "CANCELLED");
  }

  /** Create and send. Returns the existing invoice instead of billing a tenant twice. */
  async send(b: Bill): Promise<InvoiceStatus & { already_sent: boolean }> {
    const existing = await this.invoiceFor(b.flag_id);
    if (existing && existing.status !== "DRAFT") return { ...existing, already_sent: true };
    const id = existing?.invoice_id ?? (await this.call<{ id: string }>("POST", "/v2/invoicing/invoices", invoiceBody(b))).id;
    const sent = await this.call<{ href?: string }>("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
    const now = (await this.invoices()).find((i) => i.invoice_id === id);
    const base = now ?? { invoice_id: id, flag_id: b.flag_id, status: "SENT", amount: b.amount, paid: 0, due: b.amount };
    return { ...base, tenant_link: base.tenant_link ?? sent.href, already_sent: false };
  }

  /** Record money the owner received outside PayPal, such as a check. */
  async recordPayment(invoiceId: string, amount: number, method: "CHECK" | "BANK_TRANSFER" | "CASH", date = new Date().toISOString().slice(0, 10)) {
    await this.call("POST", `/v2/invoicing/invoices/${invoiceId}/payments`, { method, payment_date: date, amount: { currency_code: "USD", value: money(amount) } });
    return (await this.invoices()).find((i) => i.invoice_id === invoiceId);
  }

  /** Demo reset: undo recorded payments, cancel every sent ILORA invoice and delete drafts. */
  async reset() {
    let n = 0;
    for (const i of await this.invoices()) {
      if (i.status === "CANCELLED") continue;
      if (i.status === "DRAFT") {
        await this.call("DELETE", `/v2/invoicing/invoices/${i.invoice_id}`);
      } else {
        const full = await this.call<{ payments?: { transactions?: { payment_id: string; type?: string }[] } }>("GET", `/v2/invoicing/invoices/${i.invoice_id}`);
        for (const t of full.payments?.transactions ?? []) {
          if (t.type === "EXTERNAL") await this.call("DELETE", `/v2/invoicing/invoices/${i.invoice_id}/payments/${t.payment_id}`);
        }
        await this.call("POST", `/v2/invoicing/invoices/${i.invoice_id}/cancel`, { send_to_recipient: false, send_to_invoicer: false });
      }
      n++;
    }
    return n;
  }
}

/**
 * Plain, readable checks over the demo dataset. Written fresh for this project;
 * it is a demonstration of the kind of cross-document check ILORA.ai runs, not
 * a copy of ILORA's production extraction or verification engine.
 */
import { loadAll, type LeaseAbstract, type PropertyData, type RentRollLine, type StatementLine } from "./data.js";

export const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export type SourceRef = {
  document: string;
  page: number;
  line?: number;
  label: string;
  amount?: number;
  period?: string;
};

export type Cause = {
  flag_id: string;
  rule: "unbilled_rent_step" | "misposted_cam_reconciliation" | "occupied_no_rent" | "under_billed_rent" | "over_billed_rent" | "unmatched_posting";
  label: string;
  unit: string;
  tenant: string;
  amount: number;
  months: string[];
  reason: string;
  suggested_fix: string;
  sources: SourceRef[];
};

export type Flag = {
  flag_id: string;
  rule: string;
  label: string;
  severity: "high" | "medium" | "info";
  amount: number;
  reason: string;
  suggested_fix: string;
  figures: { label: string; value: number; unit: "USD" | "percent" | "count" }[];
  sources: SourceRef[];
};

// ------------------------------------------------------------------ lookup

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type Resolve =
  | { ok: true; data: PropertyData }
  | { ok: false; query: string; candidates: { property_id: string; name: string }[] };

/** Accepts an id or a spoken name ("Coral Wren", "tamarind grove apartments"). */
export function resolveProperty(query: string): Resolve {
  const all = [...loadAll().values()];
  const q = norm(query);
  const exact = all.find((d) => d.property.property_id === query || norm(d.property.name) === q);
  if (exact) return { ok: true, data: exact };
  const words = q.split(" ").filter((w) => w.length > 2);
  const scored = all
    .map((d) => {
      const name = norm(`${d.property.name} ${d.property.property_id} ${d.property.city}`);
      return { d, score: words.filter((w) => name.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { ok: true, data: scored[0].d };
  const pool = scored.length ? scored.map((x) => x.d) : all;
  return { ok: false, query, candidates: pool.map((d) => ({ property_id: d.property.property_id, name: d.property.name })) };
}

export function listProperties() {
  return [...loadAll().values()].map(({ property: p }) => ({
    property_id: p.property_id,
    name: p.name,
    property_type: p.property_type,
    city: p.city,
    state: p.state,
  }));
}

// ------------------------------------------------------------------ helpers

export function periodMonths(d: PropertyData): string[] {
  const out: string[] = [];
  let [y, m] = d.property.period_start.slice(0, 7).split("-").map(Number);
  const end = d.property.period_end.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

const monthName = (ym: string) =>
  new Date(`${ym}-15T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function leaseFor(d: PropertyData, unit: string): LeaseAbstract | undefined {
  return d.leases.find((l) => l.suite_unit === unit);
}

function active(r: RentRollLine, ym: string): boolean {
  if (r.occupancy_status !== "occupied" || !r.lease_start) return false;
  return r.lease_start.slice(0, 7) <= ym && (!r.lease_end || r.lease_end.slice(0, 7) >= ym);
}

/** Scheduled monthly rent: the lease's rent schedule when we have the abstract, else the rent roll. */
export function scheduledRent(d: PropertyData, r: RentRollLine, ym: string): number {
  if (!active(r, ym)) return 0;
  const lease = leaseFor(d, r.unit_number);
  if (!lease) return r.contractual_rent;
  let rent = 0;
  for (const s of lease.rent_schedule) if (s.effective_date.slice(0, 7) <= ym) rent = s.base_rent_monthly;
  return rent;
}

const isRental = (d: PropertyData, l: StatementLine) => d.property.rental_account_codes.includes(l.account_code);
const isCamReconciliation = (l: StatementLine) => /cam\s+reconciliation/i.test(l.memo);
export const unitWord = (d: PropertyData) => (d.property.units_label === "suites" ? "Suite" : "Unit");
const stmtRef = (l: StatementLine): SourceRef => ({
  document: l.source_document,
  page: l.source_page,
  line: l.source_line,
  label: `${l.account_code} ${l.account_name}, ${monthName(l.period_date.slice(0, 7))}${l.memo ? `: ${l.memo}` : ""}`,
  amount: l.actual_value,
  period: l.period_date.slice(0, 7),
});
const rentRollRef = (r: RentRollLine): SourceRef => ({
  document: r.source_document,
  page: r.source_page,
  line: r.source_line,
  label: `Rent roll, ${r.unit_number} ${r.tenant_name || "vacant"}: $${r.contractual_rent.toLocaleString("en-US")} a month, ${r.occupancy_status}`,
  amount: r.contractual_rent,
});

// ------------------------------------------------------------------ reconciliation

export function reconcile(d: PropertyData) {
  const months = periodMonths(d);
  const rental = d.statement.filter((l) => isRental(d, l) && months.includes(l.period_date.slice(0, 7)));
  const scheduledTotal = d.rentRoll.reduce((a, r) => a + months.reduce((b, m) => b + scheduledRent(d, r, m), 0), 0);
  const postedTotal = rental.reduce((a, l) => a + l.actual_value, 0);
  const W = unitWord(d);
  const causes: Cause[] = [];

  // Rule: a CAM reconciliation posted into a rental-income account.
  for (const l of rental.filter(isCamReconciliation)) {
    const r = d.rentRoll.find((x) => x.unit_number === l.unit_number);
    causes.push({
      flag_id: `${d.property.property_id}:misposted_cam_reconciliation:${l.unit_number}`,
      rule: "misposted_cam_reconciliation",
      label: `${W} ${l.unit_number} CAM reconciliation posted to ${l.account_name}`,
      unit: l.unit_number,
      tenant: r?.tenant_name ?? "",
      amount: round2(-l.actual_value),
      months: [l.period_date.slice(0, 7)],
      reason: `A CAM reconciliation of $${Math.abs(l.actual_value).toLocaleString("en-US")} for ${W} ${l.unit_number} was posted to ${l.account_code} ${l.account_name}, so rental income looks lower than the rent roll.`,
      suggested_fix: `Reclass the entry from ${l.account_code} ${l.account_name} to CAM Recoveries.`,
      sources: [stmtRef(l)],
    });
  }

  // Per-unit rules: compare scheduled rent with rent posted for that unit, month by month.
  for (const r of d.rentRoll) {
    const short: { m: string; scheduled: number; posted: number; lines: StatementLine[] }[] = [];
    for (const m of months) {
      const lines = rental.filter((l) => l.unit_number === r.unit_number && l.period_date.startsWith(m) && !isCamReconciliation(l));
      const posted = lines.reduce((a, l) => a + l.actual_value, 0);
      const scheduled = scheduledRent(d, r, m);
      if (round2(scheduled - posted) !== 0) short.push({ m, scheduled, posted, lines });
    }
    if (!short.length) continue;
    const amount = round2(short.reduce((a, s) => a + s.scheduled - s.posted, 0));
    const lease = leaseFor(d, r.unit_number);
    const step = lease?.rent_schedule.slice(1).find((s) => s.effective_date.slice(0, 7) === short[0].m);
    const prior = step && lease ? lease.rent_schedule[lease.rent_schedule.indexOf(step) - 1] : undefined;
    const base = { unit: r.unit_number, tenant: r.tenant_name, amount, months: short.map((s) => s.m) };
    const linesRefs = short.flatMap((s) => s.lines.map(stmtRef));

    if (step && prior && short.every((s) => s.posted === prior.base_rent_monthly)) {
      const cite = lease!.source_citations.find((c) => c.field === "rent_schedule");
      causes.push({
        ...base,
        flag_id: `${d.property.property_id}:unbilled_rent_step:${r.unit_number}`,
        rule: "unbilled_rent_step",
        label: `${W} ${r.unit_number} rent step not billed`,
        reason: `The lease steps rent from $${prior.base_rent_monthly.toLocaleString("en-US")} to $${step.base_rent_monthly.toLocaleString("en-US")} a month starting ${monthName(step.effective_date.slice(0, 7))}, but ${short.length} months were still billed at the old rate.`,
        suggested_fix: `Bill ${r.tenant_name} the $${amount.toLocaleString("en-US")} catch-up and update the recurring charge to $${step.base_rent_monthly.toLocaleString("en-US")}.`,
        sources: [
          { document: lease!.source_document, page: cite?.page ?? 1, label: `Lease rent schedule: ${cite?.quote ?? ""}` },
          rentRollRef(r),
          ...linesRefs,
        ],
      });
    } else if (short.every((s) => s.posted === 0) && r.occupancy_status === "occupied") {
      causes.push({
        ...base,
        flag_id: `${d.property.property_id}:occupied_no_rent:${r.unit_number}`,
        rule: "occupied_no_rent",
        label: `${W} ${r.unit_number} occupied with no rent posted`,
        reason: `The rent roll shows ${W} ${r.unit_number} occupied at $${r.contractual_rent.toLocaleString("en-US")} a month, but no rent was posted for ${short.map((s) => monthName(s.m)).join(" and ")}.`,
        suggested_fix: `Check whether ${r.tenant_name || "the tenant"} paid; post the missing charges or mark the unit vacant on the rent roll.`,
        sources: [rentRollRef(r)],
      });
    } else {
      const over = amount < 0;
      causes.push({
        ...base,
        flag_id: `${d.property.property_id}:${over ? "over" : "under"}_billed_rent:${r.unit_number}`,
        rule: over ? "over_billed_rent" : "under_billed_rent",
        label: `${W} ${r.unit_number} rent ${over ? "over" : "under"}-billed`,
        reason: `Rent posted for ${W} ${r.unit_number} differs from the scheduled rent in ${short.length} month(s).`,
        suggested_fix: "Compare the tenant ledger with the lease and correct the recurring charge.",
        sources: [rentRollRef(r), ...linesRefs],
      });
    }
  }

  // Rule: rent posted to a unit that is not on the rent roll.
  const known = new Set(d.rentRoll.map((r) => r.unit_number));
  const orphans = rental.filter((l) => !isCamReconciliation(l) && !known.has(l.unit_number));
  if (orphans.length) {
    causes.push({
      flag_id: `${d.property.property_id}:unmatched_posting:all`,
      rule: "unmatched_posting",
      label: "Rent posted to no unit on the rent roll",
      unit: "",
      tenant: "",
      amount: round2(-orphans.reduce((a, l) => a + l.actual_value, 0)),
      months: [...new Set(orphans.map((l) => l.period_date.slice(0, 7)))],
      reason: "Some rental income lines name no unit on the rent roll.",
      suggested_fix: "Assign each line to a unit or move it to another income account.",
      sources: orphans.map(stmtRef),
    });
  }

  causes.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const gap = round2(scheduledTotal - postedTotal);
  const explained = round2(causes.reduce((a, c) => a + c.amount, 0));
  return {
    scheduled_rent: round2(scheduledTotal),
    rental_income: round2(postedTotal),
    gap,
    explained,
    unexplained: round2(gap - explained),
    causes,
  };
}

// ------------------------------------------------------------------ snapshot, leases, flags

export function statementTotals(d: PropertyData) {
  const months = periodMonths(d);
  const inPeriod = d.statement.filter((l) => months.includes(l.period_date.slice(0, 7)));
  const revenue = inPeriod.filter((l) => l.account_category === "revenue").reduce((a, l) => a + l.actual_value, 0);
  const expenses = inPeriod.filter((l) => l.account_category === "expense").reduce((a, l) => a + l.actual_value, 0);
  return { total_revenue: round2(revenue), operating_expenses: round2(expenses), noi: round2(revenue - expenses) };
}

export function occupancy(d: PropertyData) {
  const occ = d.rentRoll.filter((r) => r.occupancy_status === "occupied");
  if (d.property.occupancy_basis === "leased square feet") {
    const leased = occ.reduce((a, r) => a + r.square_feet, 0);
    const total = d.rentRoll.reduce((a, r) => a + r.square_feet, 0);
    return { occupancy_pct: pct(leased, total), basis: `${leased.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} square feet leased` };
  }
  return { occupancy_pct: pct(occ.length, d.rentRoll.length), basis: `${occ.length} of ${d.rentRoll.length} units occupied` };
}

function addMonths(iso: string, n: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  const day = dt.getUTCDate();
  dt.setUTCDate(1);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, last));
  return dt.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function expiringLeases(d: PropertyData, monthsAhead: number) {
  const from = d.property.as_of_date;
  const to = addMonths(from, monthsAhead);
  const annualTotal = d.rentRoll.reduce((a, r) => a + (r.occupancy_status === "occupied" ? r.contractual_rent * 12 : 0), 0);
  const W = unitWord(d);
  const items = d.rentRoll
    .filter((r) => r.occupancy_status === "occupied" && r.lease_end && r.lease_end > from && r.lease_end <= to)
    .sort((a, b) => a.lease_end.localeCompare(b.lease_end) || a.unit_number.localeCompare(b.unit_number))
    .map((r, i) => ({
      position: i + 1,
      item_id: `${d.property.property_id}:lease:${r.unit_number}`,
      label: `${W} ${r.unit_number}, ${r.tenant_name}`,
      tenant: r.tenant_name,
      unit: r.unit_number,
      expiration_date: r.lease_end,
      days_until_expiration: daysBetween(from, r.lease_end),
      monthly_rent: r.contractual_rent,
      annual_rent: r.contractual_rent * 12,
      share_of_income_pct: pct(r.contractual_rent * 12, annualTotal),
      source: rentRollRef(r),
    }));
  const annual = items.reduce((a, x) => a + x.annual_rent, 0);
  return {
    window_start: from,
    window_end: to,
    months_ahead: monthsAhead,
    count: items.length,
    total_annual_rent: annual,
    share_of_income_pct: pct(annual, annualTotal),
    leases: items,
  };
}

/** Open verification flags: every reconciliation cause, plus near-term rollover concentration. */
export function flags(d: PropertyData): Flag[] {
  const rec = reconcile(d);
  const severity = (amt: number): Flag["severity"] => (Math.abs(amt) >= 5000 ? "high" : "medium");
  const out: Flag[] = rec.causes.map((c) => ({
    flag_id: c.flag_id,
    rule: c.rule,
    label: c.label,
    severity: severity(c.amount),
    amount: c.amount,
    reason: c.reason,
    suggested_fix: c.suggested_fix,
    figures: [
      { label: "Effect on rental income", value: -c.amount, unit: "USD" },
      { label: "Months affected", value: c.months.length, unit: "count" },
    ],
    sources: c.sources,
  }));
  const soon = expiringLeases(d, 3);
  if (soon.count && soon.share_of_income_pct >= 5) {
    out.push({
      flag_id: `${d.property.property_id}:lease_rollover_90_days:all`,
      rule: "lease_rollover_90_days",
      label: `${soon.count} leases end within 90 days`,
      severity: "info",
      amount: soon.total_annual_rent,
      reason: `${soon.count} leases worth $${soon.total_annual_rent.toLocaleString("en-US")} a year, ${soon.share_of_income_pct}% of rent roll income, end by ${soon.window_end}.`,
      suggested_fix: "Start renewal conversations now and budget for turnover on any that leave.",
      figures: [
        { label: "Leases ending", value: soon.count, unit: "count" },
        { label: "Annual rent at risk", value: soon.total_annual_rent, unit: "USD" },
        { label: "Share of rent roll income", value: soon.share_of_income_pct, unit: "percent" },
      ],
      sources: soon.leases.map((l) => l.source),
    });
  }
  return out;
}

export function snapshot(d: PropertyData) {
  const rec = reconcile(d);
  const totals = statementTotals(d);
  const f = flags(d);
  const occ = occupancy(d);
  const p = d.property;
  return {
    property_id: p.property_id,
    name: p.name,
    property_type: p.property_type,
    city: p.city,
    state: p.state,
    as_of_date: p.as_of_date,
    period: { start: p.period_start, end: p.period_end, label: "trailing 12 months" },
    occupancy_pct: occ.occupancy_pct,
    occupancy_basis: occ.basis,
    scheduled_rent_t12: rec.scheduled_rent,
    rental_income_t12: rec.rental_income,
    rent_gap_t12: rec.gap,
    total_revenue_t12: totals.total_revenue,
    operating_expenses_t12: totals.operating_expenses,
    noi_t12: totals.noi,
    open_flags: f.length,
    top_flag: f[0] ? { flag_id: f[0].flag_id, label: f[0].label } : null,
  };
}

export function findFlag(flagId: string) {
  for (const d of loadAll().values()) {
    const f = flags(d).find((x) => x.flag_id === flagId);
    if (f) return { property: d.property, flag: f };
  }
  return undefined;
}

export function allFlagIds() {
  return [...loadAll().values()].flatMap((d) => flags(d).map((f) => ({ flag_id: f.flag_id, label: f.label, property_id: d.property.property_id })));
}

/**
 * Every tool over the real Streamable HTTP transport, with a real MCP client.
 * The SDK client validates each structuredContent against the tool's outputSchema,
 * so a schema drift fails these tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { errorOf, sc, startServer } from "./helpers.js";

let s: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => s.close());

describe("protocol", () => {
  it("negotiates MCP spec 2025-11-25 over Streamable HTTP", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(s.transport.protocolVersion).toBe("2025-11-25");
    expect(s.client.getServerVersion()?.name).toBe("ilora-building-analyst");
  });

  it("lists exactly the nine intent tools, each with input and output schemas", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_rent_roll_vs_statement", "draft_rent_invoices", "explain_flag", "get_property_snapshot", "list_expiring_leases", "list_properties", "record_rent_payment", "rent_collection_status", "send_rent_invoice"].sort(),
    );
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.description!.length, t.name).toBeGreaterThan(80);
      const writes = t.name === "send_rent_invoice" || t.name === "record_rent_payment";
      expect(t.annotations?.readOnlyHint, t.name).toBe(!writes);
    }
  });

  it("links the two visual tools to MCP Apps resources that exist", async () => {
    const { tools } = await s.client.listTools();
    const { resources } = await s.client.listResources();
    for (const name of ["check_rent_roll_vs_statement", "list_expiring_leases"]) {
      const uri = (tools.find((t) => t.name === name)!._meta as { ui: { resourceUri: string } }).ui.resourceUri;
      const r = resources.find((x) => x.uri === uri)!;
      expect(r.mimeType).toBe("text/html;profile=mcp-app");
      const read = await s.client.readResource({ uri });
      expect((read.contents[0] as { text: string }).text).toContain("ui/initialize");
    }
  });

  it("rejects GET on /mcp with 405 (stateless, no server stream)", async () => {
    const res = await fetch(`${s.base}/mcp`);
    expect(res.status).toBe(405);
  });
});

describe("list_properties", () => {
  it("returns both demo properties", async () => {
    const r = sc(await s.client.callTool({ name: "list_properties", arguments: {} }));
    expect(r.properties.map((p: { name: string }) => p.name).sort()).toEqual(["Coral Wren Plaza", "Tamarind Grove Apartments"]);
  });
});

describe("get_property_snapshot", () => {
  it("happy path by spoken name", async () => {
    const r = sc(await s.client.callTool({ name: "get_property_snapshot", arguments: { property: "coral wren" } }));
    expect(r).toMatchObject({ property_id: "coral-wren-plaza", occupancy_pct: 92.1, scheduled_rent_t12: 412000, rental_income_t12: 398500, open_flags: 2 });
  });
  it("unknown property returns a structured error with close matches", async () => {
    const r = await s.client.callTool({ name: "get_property_snapshot", arguments: { property: "7777 Glades" } });
    expect(r.isError).toBe(true);
    expect(errorOf(r).code).toBe("unknown_property");
    expect(errorOf(r).did_you_mean).toHaveLength(2);
  });
  it("missing argument is rejected by input validation", async () => {
    const r = await s.client.callTool({ name: "get_property_snapshot", arguments: {} });
    expect(r.isError).toBe(true);
  });
});

describe("check_rent_roll_vs_statement", () => {
  it("finds the $13,500 gap with two ranked, cited causes", async () => {
    const r = sc(await s.client.callTool({ name: "check_rent_roll_vs_statement", arguments: { property: "Coral Wren Plaza" } }));
    expect(r).toMatchObject({ matches: false, rent_roll_total: 412000, statement_total: 398500, gap: 13500, unexplained: 0 });
    expect(r.causes.map((c: { amount: number }) => c.amount)).toEqual([9000, 4500]);
    expect(r.causes[0].share_of_gap_pct).toBeCloseTo(66.7, 1);
    expect(r.causes[0].sources.some((x: { line?: number }) => x.line)).toBe(true);
  });
  it("unknown property is a structured error", async () => {
    const r = await s.client.callTool({ name: "check_rent_roll_vs_statement", arguments: { property: "nowhere" } });
    expect(r.isError).toBe(true);
  });
});

describe("list_expiring_leases", () => {
  it("defaults to 12 months", async () => {
    const r = sc(await s.client.callTool({ name: "list_expiring_leases", arguments: { property: "coral-wren-plaza" } }));
    expect(r.months_ahead).toBe(12);
    expect(r.leases.map((l: { unit: string }) => l.unit)).toEqual(["107", "102"]);
  });
  it("90 days at Tamarind: three leases, 9% of income, stable ids and positions", async () => {
    const r = sc(await s.client.callTool({ name: "list_expiring_leases", arguments: { property: "tamarind grove", months_ahead: 3 } }));
    expect(r.count).toBe(3);
    expect(r.share_of_income_pct).toBe(9);
    expect(r.leases.map((l: { position: number }) => l.position)).toEqual([1, 2, 3]);
    expect(r.leases[1].item_id).toBe("tamarind-grove:lease:B-23");
  });
  it("empty result is a valid answer, not an error", async () => {
    const r = await s.client.callTool({ name: "list_expiring_leases", arguments: { property: "coral-wren-plaza", months_ahead: 1 } });
    expect(r.isError).toBeFalsy();
    expect(sc(r)).toMatchObject({ count: 0, leases: [] });
  });
  it("out-of-range months_ahead is rejected", async () => {
    const r = await s.client.callTool({ name: "list_expiring_leases", arguments: { property: "coral-wren-plaza", months_ahead: 600 } });
    expect(r.isError).toBe(true);
  });
});

describe("explain_flag", () => {
  it("explains the Suite 104 step with the lease page and statement lines", async () => {
    const r = sc(await s.client.callTool({ name: "explain_flag", arguments: { flag_id: "coral-wren-plaza:unbilled_rent_step:104" } }));
    expect(r.rule).toBe("unbilled_rent_step");
    expect(r.amount).toBe(9000);
    expect(r.sources[0].document).toMatch(/Lease, Suite 104/);
    expect(r.sources.filter((x: { period?: string }) => x.period)).toHaveLength(6);
  });
  it("unknown flag lists the open flags instead of failing silently", async () => {
    const r = await s.client.callTool({ name: "explain_flag", arguments: { flag_id: "nope" } });
    expect(r.isError).toBe(true);
    expect(errorOf(r).open_flags.length).toBe(4);
  });
});

describe("latency", () => {
  it("every tool answers in under 500 ms", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["list_properties", {}],
      ["get_property_snapshot", { property: "tamarind-grove" }],
      ["check_rent_roll_vs_statement", { property: "tamarind-grove" }],
      ["list_expiring_leases", { property: "tamarind-grove" }],
      ["explain_flag", { flag_id: "tamarind-grove:occupied_no_rent:B-12" }],
    ];
    for (const [name, args] of calls) {
      const t = performance.now();
      await s.client.callTool({ name, arguments: args });
      expect(performance.now() - t, name).toBeLessThan(500);
    }
  });
});

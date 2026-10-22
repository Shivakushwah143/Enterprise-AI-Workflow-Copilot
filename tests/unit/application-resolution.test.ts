import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store, normalizeApplicationUrl, openDb, type Sql } from "@copilot/knowledge";
import type { Application, Skill } from "@copilot/shared";

let sql: Sql;
let store: Store;
let dir: string;
let tenantA: string;
let tenantB: string;

async function app(
  tenantId: string,
  name: string,
  baseUrl: string,
): Promise<Application> {
  return store.createApplication({ tenantId, name, baseUrl, kind: "browser" });
}

/** A workflow + active skill bound to `application`, as an approval produces. */
async function approveWorkflow(
  tenantId: string,
  application: Application,
  name: string,
): Promise<Skill> {
  const workflow = await store.createWorkflow({
    tenantId,
    applicationId: application.id,
    name,
    description: null,
    bundlePath: null,
    recordingId: null,
    steps: [
      {
        index: 0,
        intent: "Click New customer",
        action: "click",
        risk: "reversible",
        anchorKind: "structural",
        elementRole: "button",
        elementName: "New customer",
        selector: "#new-customer",
        ocrText: null,
        fieldLabel: null,
        paramName: null,
        isSecret: false,
        postconditions: [],
        confidence: "identified",
        uncertaintyNote: null,
      },
    ],
    uncertainty: [],
  });
  await store.setWorkflowStatus(tenantId, workflow.id, "approved");
  return store.createSkill({
    tenantId,
    workflowId: workflow.id,
    name,
    description: `${name} in ${application.name}`,
    requiredInputs: [],
    triggeredBy: ["customer"],
    verification: null,
    approvedBy: "admin@acme.test",
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "copilot-resolution-"));
  sql = await openDb({ dataDir: dir });
  store = new Store(sql);
  tenantA = (await store.ensureTenant("tenant-a", "Tenant A")).id;
  tenantB = (await store.ensureTenant("tenant-b", "Tenant B")).id;
});

afterAll(async () => {
  await sql.close();
  await rm(dir, { recursive: true, force: true });
});

describe("application URL normalization", () => {
  it("treats spelling and default-port differences as one identity", () => {
    for (const value of [
      "http://127.0.0.1:4300/",
      "HTTP://127.0.0.1:4300//",
      "http://127.0.0.1:4300/?tab=home#top",
    ]) {
      expect(normalizeApplicationUrl(value)).toBe("http://127.0.0.1:4300");
    }
    expect(normalizeApplicationUrl("http://example.test:80/app/")).toBe("http://example.test/app");
    expect(normalizeApplicationUrl("https://example.test:443")).toBe("https://example.test");
  });

  it("keeps distinct paths and ports distinct", () => {
    expect(normalizeApplicationUrl("http://example.test/crm")).not.toBe(
      normalizeApplicationUrl("http://example.test/stock"),
    );
    expect(normalizeApplicationUrl("http://example.test:4300")).not.toBe(
      normalizeApplicationUrl("http://example.test:4400"),
    );
  });

  it("has no identity for a non-http URL", () => {
    expect(normalizeApplicationUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeApplicationUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeApplicationUrl("not a url")).toBeNull();
  });
});

describe("application resolution", () => {
  it("resolves an exact URL match", async () => {
    const created = await app(tenantA, "Exact App", "http://127.0.0.1:4300");
    const resolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4300",
    );
    expect(resolution.status).toBe("resolved");
    expect(resolution.application?.id).toBe(created.id);
  });

  it("resolves the same application across its routes", async () => {
    const created = await app(tenantA, "Routed App", "http://127.0.0.1:4310");
    for (const url of [
      "http://127.0.0.1:4310/customers",
      "http://127.0.0.1:4310/customers/new?from=nav",
      "http://127.0.0.1:4310/",
    ]) {
      const resolution = await store.resolveApplicationForUrl(tenantA, url);
      expect(resolution.status, url).toBe("resolved");
      expect(resolution.application?.id, url).toBe(created.id);
    }
  });

  it("separates genuinely distinct apps on one origin by path", async () => {
    const crm = await app(tenantA, "Path CRM", "http://127.0.0.1:4320/crm");
    const stock = await app(tenantA, "Path Stock", "http://127.0.0.1:4320/stock");

    const crmResolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4320/crm/customer/7",
    );
    const stockResolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4320/stock/items",
    );
    expect(crmResolution.application?.id).toBe(crm.id);
    expect(stockResolution.application?.id).toBe(stock.id);
  });

  it("does not treat a lookalike path as a prefix match", async () => {
    await app(tenantA, "Crm Only", "http://127.0.0.1:4330/crm");
    const lookalike = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4330/crmx/dashboard",
    );
    // The origin matches nothing else here; a segment boundary is required.
    expect(lookalike.status).toBe("none");
  });

  it("prefers the most specific base path when several contain the URL", async () => {
    const root = await app(tenantA, "Root App", "http://127.0.0.1:4340");
    const admin = await app(tenantA, "Admin App", "http://127.0.0.1:4340/admin");

    const insideAdmin = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4340/admin/settings",
    );
    const elsewhere = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4340/dashboard",
    );
    expect(insideAdmin.application?.id).toBe(admin.id);
    expect(elsewhere.application?.id).toBe(root.id);
  });

  it("refuses to choose between duplicate rows, even when only one has skills", async () => {
    const older = await app(tenantA, "Duplicate CRM", "http://127.0.0.1:4350");
    const newer = await app(tenantA, "Duplicate CRM", "http://127.0.0.1:4350");
    const skill = await approveWorkflow(tenantA, newer, "Create customer");

    const resolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4350/customers",
    );
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.application).toBeNull();
    expect(resolution.candidates.map((c) => c.id).sort()).toEqual([older.id, newer.id].sort());
    // The skill stays attached to the row it was approved for.
    expect(skill.applicationId).toBe(newer.id);
  });

  it("reports an unknown application as none", async () => {
    const resolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4999/anything",
    );
    expect(resolution.status).toBe("none");
    expect(resolution.application).toBeNull();
  });

  it("never returns another tenant's application", async () => {
    const foreign = await app(tenantB, "Other Tenant CRM", "http://127.0.0.1:4360");

    const fromA = await store.resolveApplicationForUrl(tenantA, "http://127.0.0.1:4360/");
    expect(fromA.status).toBe("none");
    expect(fromA.candidates).toHaveLength(0);

    const fromB = await store.resolveApplicationForUrl(tenantB, "http://127.0.0.1:4360/");
    expect(fromB.application?.id).toBe(foreign.id);
  });

  it("refuses a non-http page instead of matching it loosely", async () => {
    const resolution = await store.resolveApplicationForUrl(tenantA, "chrome://extensions");
    expect(resolution.status).toBe("none");
  });
});

describe("registration identity", () => {
  it("does not create a duplicate row for an established identity", async () => {
    const first = await store.ensureApplication({
      tenantId: tenantA,
      name: "Idempotent App",
      baseUrl: "http://127.0.0.1:4370/",
    });
    const second = await store.ensureApplication({
      tenantId: tenantA,
      name: "Idempotent App",
      baseUrl: "http://127.0.0.1:4370",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);
    const rows = (await store.listApplications(tenantA)).filter(
      (a) => normalizeApplicationUrl(a.baseUrl) === "http://127.0.0.1:4370",
    );
    expect(rows).toHaveLength(1);
  });

  it("converges concurrent registrations of the same identity on one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.ensureApplication({
          tenantId: tenantA,
          name: "Concurrent App",
          baseUrl: "http://127.0.0.1:4380",
        }),
      ),
    );
    expect(new Set(results.map((r) => r.application.id)).size).toBe(1);
    const rows = (await store.listApplications(tenantA)).filter(
      (a) => normalizeApplicationUrl(a.baseUrl) === "http://127.0.0.1:4380",
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps existing approved workflows linked to their application", async () => {
    const application = await store.ensureApplication({
      tenantId: tenantA,
      name: "Linked App",
      baseUrl: "http://127.0.0.1:4390",
    });
    const skill = await approveWorkflow(tenantA, application.application, "Linked skill");

    const resolution = await store.resolveApplicationForUrl(
      tenantA,
      "http://127.0.0.1:4390/work",
    );
    expect(resolution.status).toBe("resolved");
    expect(resolution.application?.id).toBe(skill.applicationId);
    const reread = await store.getSkill(tenantA, skill.id);
    expect(reread?.applicationId).toBe(resolution.application?.id);
  });

  it("rejects a URL that cannot identify an application", async () => {
    await expect(
      store.ensureApplication({
        tenantId: tenantA,
        name: "Bad URL",
        baseUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/http/);
  });
});

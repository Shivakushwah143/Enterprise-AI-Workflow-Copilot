import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store, openDb, type Sql } from "@copilot/knowledge";

let sql: Sql;
let store: Store;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "copilot-tenancy-"));
  sql = await openDb({ dataDir: dir });
  store = new Store(sql);
});

afterAll(async () => {
  await sql.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tenant scoping", () => {
  it("creates the schema from a clean data directory", async () => {
    const rows = await sql.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toContain("tenants");
    expect(tables).toContain("workflows");
    expect(tables).toContain("executions");
  });

  it("does not return another tenant's applications", async () => {
    const a = await store.ensureTenant("tenant-a", "Tenant A");
    const b = await store.ensureTenant("tenant-b", "Tenant B");
    const application = await store.createApplication({
      tenantId: a.id,
      name: "Tenant A App",
      baseUrl: "http://127.0.0.1:4300",
    });

    expect((await store.listApplications(b.id)).length).toBe(0);
    expect(await store.getApplication(b.id, application.id)).toBeNull();
    expect((await store.listApplications(a.id)).length).toBe(1);
  });

  it("keeps workflows and skills invisible across tenants", async () => {
    const a = await store.ensureTenant("tenant-a", "Tenant A");
    const b = await store.ensureTenant("tenant-b", "Tenant B");
    const application = (await store.listApplications(a.id))[0]!;
    const workflow = await store.createWorkflow({
      tenantId: a.id,
      applicationId: application.id,
      name: "Create customer",
      description: null,
      bundlePath: null,
      recordingId: null,
      steps: [
        {
          index: 0,
          intent: "click save",
          action: "click",
          risk: "reversible",
          anchorKind: "structural",
          elementRole: "button",
          elementName: "Save",
          selector: "#save",
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
    await store.createSkill({
      tenantId: a.id,
      workflowId: workflow.id,
      name: "Create customer",
      description: "Creates",
      requiredInputs: [],
      triggeredBy: [],
      verification: null,
      approvedBy: "admin@acme.test",
    });

    expect(await store.getWorkflow(b.id, workflow.id)).toBeNull();
    expect((await store.listWorkflows(b.id)).length).toBe(0);
    expect((await store.listSkills(b.id)).length).toBe(0);
    expect((await store.listSkills(a.id)).length).toBe(1);
  });

  it("scopes a session to the tenant of its user", async () => {
    const a = await store.ensureTenant("tenant-a", "Tenant A");
    const b = await store.ensureTenant("tenant-b", "Tenant B");
    const user = await store.ensureUser(a.id, "admin@a.test", "A Admin", "admin");
    const session = await store.createSession(user);
    const loaded = await store.getSession(session.token);
    expect(loaded?.tenant.id).toBe(a.id);
    expect(loaded?.tenant.id).not.toBe(b.id);
    expect(await store.getSession("not-a-token")).toBeNull();
  });

  it("keeps user identities separate per tenant", async () => {
    const a = await store.ensureTenant("tenant-a", "Tenant A");
    const b = await store.ensureTenant("tenant-b", "Tenant B");
    await store.ensureUser(a.id, "shared@example.test", "A User", "admin");
    expect(await store.findUserByEmail(b.id, "shared@example.test")).toBeNull();
  });
});

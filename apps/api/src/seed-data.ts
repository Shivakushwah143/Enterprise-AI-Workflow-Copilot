/**
 * Seed the durable knowledge layer with two tenants, a role matrix, the two
 * demo applications, and an SOP document per application.
 *
 * Kept separate from `seed.ts` so the scenario runner can seed an isolated
 * database without duplicating the fixture. Idempotent: running it twice leaves
 * one of everything. It does NOT create skills - a skill only exists after a
 * recording has been compiled and an admin has approved it.
 */
import { ROLE_PERMISSIONS, type Application } from "@copilot/shared";
import type { KnowledgeEngine, Store } from "@copilot/knowledge";
import { DEMO_APPS, type DemoApp } from "@copilot/workflow";

export interface SeededWorld {
  demoTenantId: string;
  otherTenantId: string;
  users: { admin: string; employee: string; outsider: string };
  applications: { demo: DemoApp; application: Application }[];
}

export async function seedDemo(
  store: Store,
  knowledge: KnowledgeEngine,
  log: (event: Record<string, unknown>) => void = () => {},
): Promise<SeededWorld> {
  const demoTenant = await store.ensureTenant("acme-demo", "Acme Demo Corp");
  const secondTenant = await store.ensureTenant("other-tenant", "Other Tenant Inc");

  for (const tenant of [demoTenant, secondTenant]) {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      await store.ensureRole(tenant.id, role, permissions);
    }
  }

  const admin = await store.ensureUser(
    demoTenant.id,
    "admin@acme.test",
    "Ada Admin",
    "admin",
  );
  const employee = await store.ensureUser(
    demoTenant.id,
    "employee@acme.test",
    "Eve Employee",
    "employee",
  );
  const outsider = await store.ensureUser(
    secondTenant.id,
    "admin@other.test",
    "Otto Outsider",
    "admin",
  );

  const applications: { demo: DemoApp; application: Application }[] = [];
  for (const demo of DEMO_APPS) {
    // Identity is the normalized base URL, so re-seeding cannot leave a second
    // row for the same application behind.
    const { application } = await store.ensureApplication({
      tenantId: demoTenant.id,
      name: demo.name,
      baseUrl: demo.baseUrl,
      verificationBaseUrl: demo.baseUrl,
      kind: "browser",
    });
    applications.push({ demo, application });
  }

  const docs = [
    {
      title: "Customer onboarding SOP",
      applicationId: applications[0]?.application.id ?? null,
      content: `Customer onboarding standard operating procedure.
New customers are created in AcmeDesk CRM. Open the Customers page and choose
"New customer". Enter the legal company name exactly as it appears on the
signed order form, then the primary contact email, then the commercial tier.
Save the customer and confirm the success banner names the same company.
A customer record must never be created twice: search the customer list first.
Warehouse stock registrations are handled separately in StockDesk by SKU.`,
    },
    {
      title: "Stock intake SOP",
      applicationId: applications[1]?.application.id ?? null,
      content: `Stock intake procedure for the warehouse team.
Received goods are registered in StockDesk using the supplier SKU and the
received quantity. Open StockDesk, choose "New stock item", enter the SKU and
the quantity received, then register the item. Verify the item appears in the
registered items list with the same SKU and quantity.`,
    },
  ];

  for (const doc of docs) {
    const existing = await store.sql.query<{ id: string }>(
      "SELECT id FROM documents WHERE tenant_id = $1 AND title = $2",
      [demoTenant.id, doc.title],
    );
    if (existing.length === 0) {
      const result = await knowledge.ingest({
        tenantId: demoTenant.id,
        applicationId: doc.applicationId,
        title: doc.title,
        kind: "sop",
        content: doc.content,
      });
      log({ event: "seed.document", title: doc.title, chunks: result.chunks });
    }
  }

  return {
    demoTenantId: demoTenant.id,
    otherTenantId: secondTenant.id,
    users: { admin: admin.email, employee: employee.email, outsider: outsider.email },
    applications,
  };
}

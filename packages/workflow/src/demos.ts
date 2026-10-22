/**
 * The local, disposable demonstration applications.
 *
 * These are OUR apps (apps/demo), not OpenAdapt's bundled MockMed/MockLoan, so
 * the demonstration, the replay and the independent read-back all target the
 * same business object the copilot claims to have created. Every selector here
 * mirrors `packages/workflow/python/copilot_bridge.py`.
 */
export interface DemoApp {
  /** Key understood by the Python bridge. */
  key: string;
  name: string;
  baseUrl: string;
  /** What the demonstration creates. */
  creates: string;
  workflowName: string;
  description: string;
  /** Parameters the recording binds, in step order. */
  params: { name: string; label: string; secret: boolean }[];
  /** Verification contract template; `{param}` placeholders are substituted. */
  verification: {
    url: string;
    recordPath: string;
    expect: Record<string, string>;
    match: "includes" | "equals";
  };
  /** Utterances that should retrieve this skill. */
  triggers: string[];
}

const env = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;

export const DEMO_APPS: DemoApp[] = [
  {
    key: "acme-crm",
    name: "AcmeDesk CRM",
    baseUrl: env("DEMO_CRM_URL", "http://127.0.0.1:4300"),
    creates: "customer",
    workflowName: "Create customer",
    description:
      "Opens the new-customer form, fills the company name and contact email, and saves.",
    params: [
      { name: "company_name", label: "Company name", secret: false },
      { name: "email", label: "Contact email", secret: false },
    ],
    verification: {
      url:
        env("DEMO_CRM_URL", "http://127.0.0.1:4300") +
        "/api/customers?name={company_name}",
      recordPath: "items",
      expect: { name: "company_name", email: "email" },
      match: "equals",
    },
    triggers: ["customer", "client", "account", "crm", "contact"],
  },
  {
    key: "stockdesk",
    name: "StockDesk",
    baseUrl: env("DEMO_STOCK_URL", "http://127.0.0.1:4400"),
    creates: "stock item",
    workflowName: "Register stock item",
    description:
      "Opens the new-item form, fills the SKU and quantity, and registers the stock item.",
    params: [
      { name: "sku", label: "SKU", secret: false },
      { name: "quantity", label: "Quantity", secret: false },
    ],
    verification: {
      url:
        env("DEMO_STOCK_URL", "http://127.0.0.1:4400") +
        "/api/items?sku={sku}",
      recordPath: "items",
      expect: { sku: "sku", quantity: "quantity" },
      match: "equals",
    },
    triggers: ["stock", "item", "inventory", "sku", "warehouse"],
  },
];

export function demoAppByKey(key: string): DemoApp | null {
  return DEMO_APPS.find((a) => a.key === key) ?? null;
}

export function demoAppByUrl(url: string): DemoApp | null {
  const matches = DEMO_APPS.filter((a) => url.startsWith(a.baseUrl)).sort(
    (a, b) => b.baseUrl.length - a.baseUrl.length,
  );
  return matches[0] ?? null;
}

/** Substitute `{param}` placeholders without inventing values. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)\}/gi, (_, name: string) => {
    const value = values[name];
    return value === undefined ? "" : encodeURIComponent(value);
  });
}

import { describe, expect, it } from "vitest";
import type { VerificationContract } from "@copilot/shared";
import { verifyAgainstContract } from "@copilot/workflow";

const contract: VerificationContract = {
  kind: "http",
  tier: "system_of_record",
  url: "http://127.0.0.1:9/api/items?sku={sku}",
  recordPath: "items",
  expect: { sku: "sku", quantity: "quantity" },
  match: "equals",
};

const inputs = { sku: "SKU-100", quantity: "25" };

function fetcherReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("verifyAgainstContract", () => {
  it("passes only when the system of record holds the expected record", async () => {
    const result = await verifyAgainstContract(contract, inputs, {
      fetcher: fetcherReturning({ items: [{ sku: "SKU-100", quantity: 25 }] }),
    });
    expect(result.passed).toBe(true);
    expect(result.tier).toBe("system_of_record");
    expect(result.observed).toMatchObject({ sku: "SKU-100" });
  });

  it("substitutes inputs into the URL instead of trusting the caller", async () => {
    let seen = "";
    const fetcher = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyAgainstContract(contract, inputs, { fetcher });
    expect(seen).toContain("sku=SKU-100");
  });

  it("fails when a different record is present", async () => {
    const result = await verifyAgainstContract(contract, inputs, {
      fetcher: fetcherReturning({ items: [{ sku: "SKU-100", quantity: 99 }] }),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("No record");
  });

  it("fails, and says the outcome is unknown, when the oracle is unreachable", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await verifyAgainstContract(contract, inputs, { fetcher });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("unknown, not success");
  });

  it("fails on a non-2xx oracle response", async () => {
    const result = await verifyAgainstContract(contract, inputs, {
      fetcher: fetcherReturning({ error: "boom" }, 500),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("HTTP 500");
  });

  it("supports includes matching for free-text observations", async () => {
    const result = await verifyAgainstContract(
      { ...contract, match: "includes" },
      { sku: "100", quantity: "25" },
      { fetcher: fetcherReturning({ items: [{ sku: "SKU-100", quantity: "25 units" }] }) },
    );
    expect(result.passed).toBe(true);
  });
});

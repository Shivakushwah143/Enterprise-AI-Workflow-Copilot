/**
 * Independent verification (tier 1, `system_of_record`).
 *
 * The acting browser session is NOT evidence. This module reads the business
 * system through its own API/database - a different channel from the GUI the
 * agent just drove - and looks for the record the workflow claims it created.
 * A failure to reach the oracle is reported as a failed check with the reason,
 * never as success.
 */
import type { VerificationContract, VerificationTier } from "@copilot/shared";
import { fillTemplate } from "./demos.js";

export interface VerifyOutcome {
  tier: VerificationTier;
  passed: boolean;
  source: string;
  expected: Record<string, unknown>;
  observed: Record<string, unknown> | null;
  detail: string;
}

function dig(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  let current: unknown = value;
  for (const part of dotted.split(".")) {
    if (current && typeof current === "object" && part in (current as object)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

function matches(
  record: Record<string, unknown>,
  expect: Record<string, string>,
  inputs: Record<string, string>,
  mode: "includes" | "equals",
): boolean {
  return Object.entries(expect).every(([observedField, inputName]) => {
    const wanted = inputs[inputName];
    if (wanted === undefined) return false;
    const actual = record[observedField];
    if (actual === undefined || actual === null) return false;
    const actualText = String(actual).trim();
    const wantedText = String(wanted).trim();
    if (mode === "includes") {
      return actualText.toLowerCase().includes(wantedText.toLowerCase());
    }
    return actualText.toLowerCase() === wantedText.toLowerCase();
  });
}

export async function verifyAgainstContract(
  contract: VerificationContract,
  inputs: Record<string, string>,
  options: { timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<VerifyOutcome> {
  const url = fillTemplate(contract.url, inputs);
  const expected: Record<string, unknown> = {};
  for (const [observedField, inputName] of Object.entries(contract.expect)) {
    expected[observedField] = inputs[inputName] ?? null;
  }
  const base = {
    tier: contract.tier,
    source: url,
    expected,
  };

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...base,
        passed: false,
        observed: null,
        detail: `Verification endpoint returned HTTP ${response.status}; the outcome is unknown, not success.`,
      };
    }
    const payload = (await response.json()) as unknown;
    const records = asRecords(dig(payload, contract.recordPath));
    const hit = records.find((record) =>
      matches(record, contract.expect, inputs, contract.match),
    );
    if (!hit) {
      return {
        ...base,
        passed: false,
        observed: { recordsChecked: records.length },
        detail: `No record in the system of record matched ${JSON.stringify(expected)} (${records.length} record(s) inspected).`,
      };
    }
    return {
      ...base,
      passed: true,
      observed: hit,
      detail: `Found the record in the system of record (${records.length} record(s) inspected).`,
    };
  } catch (error) {
    return {
      ...base,
      passed: false,
      observed: null,
      detail: `Could not read the system of record: ${
        error instanceof Error ? error.message : "unknown error"
      }. The outcome is unknown, not success.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

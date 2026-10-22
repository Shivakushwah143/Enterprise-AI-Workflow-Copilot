/**
 * Live target resolution (M2).
 *
 * The compiled bundle names a control by the selector captured at record time.
 * Before executing, we open the application once and confirm each target: the
 * recorded selector first, then a selector supplied by a reviewed repair, then
 * role+name, label and visible text. A target that resolves through a fallback
 * is re-expressed as a plain CSS path, so the engine receives a selector it
 * understands and the approved bundle stays untouched.
 *
 * Presence, not visibility, is the test: a control inside a form that the
 * workflow opens later in the run is legitimately hidden *now*, and refusing it
 * would break every multi-step form. Whether the control is actionable at the
 * moment it is used remains the engine's decision.
 *
 * Nothing here acts on the page. If no candidate resolves, the step is reported
 * `none` and the executor decides whether to refuse.
 */
import { chromium } from "playwright";
import type { WorkflowStep } from "@copilot/shared";
import { locatorCandidates } from "@copilot/workflow";
import type { KnownTarget, LocatorAssist, TargetResolution } from "@copilot/agent";

/**
 * Find one control in the real DOM, hidden ancestors included, and return a
 * stable CSS path. `role` is matched from the explicit attribute or the tag's
 * implicit role; `name`/`text` from aria-label or trimmed text; `label` from the
 * associated `<label>`, an ancestor label, or the placeholder.
 */
interface FinderSpec {
  role: string | null;
  name: string | null;
  label: string | null;
  text: string | null;
}

/**
 * Runs inside the page.
 *
 * Kept as source text on purpose: `tsx`/esbuild injects a `__name()` helper into
 * serialized functions, which does not exist in the page (`__name is not
 * defined`). A plain source string is never rewritten, and the spec is embedded
 * as JSON so it is delivered as a real argument.
 */
const FIND_CONTROL_SRC = `function (spec) {
  var css = function (el) {
    var escape = function (value) {
      return window.CSS && window.CSS.escape ? window.CSS.escape(value) : value;
    };
    if (el.id) return '#' + escape(el.id);
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift('#' + escape(node.id)); break; }
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName;
        });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  };

  var implicitRole = function (el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return '';
  };

  var textOf = function (el) {
    return ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
  };

  var labelOf = function (el) {
    if (el.id) {
      var explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit) return textOf(explicit);
    }
    var ancestor = el.closest('label');
    if (ancestor) return textOf(ancestor);
    var placeholder = el.getAttribute('placeholder');
    return placeholder ? placeholder.trim() : '';
  };

  var matches = Array.prototype.filter.call(document.querySelectorAll('*'), function (el) {
    if (spec.role) {
      var role = el.getAttribute('role') || implicitRole(el);
      if (role !== spec.role) return false;
    }
    if (spec.name) {
      var aria = (el.getAttribute('aria-label') || '').trim();
      if (aria !== spec.name && textOf(el) !== spec.name) return false;
    }
    if (spec.label) {
      // A label names a form control; the <label> element itself can carry the
      // same text and must never win the match.
      var tagName = el.tagName.toLowerCase();
      if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') return false;
      if (labelOf(el) !== spec.label) return false;
    }
    if (spec.text) {
      var ariaText = (el.getAttribute('aria-label') || '').trim();
      if (ariaText !== spec.text && textOf(el) !== spec.text) return false;
    }
    if (!spec.role && !spec.name && !spec.label && !spec.text) return false;
    return true;
  });

  matches.sort(function (a, b) {
    return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
  });
  return matches.length ? css(matches[0]) : null;
}`;


export interface ResolveTargetsInput {
  url: string;
  steps: WorkflowStep[];
  /**
   * Selectors supplied by reviewed memory. Tried only where the ladder found
   * nothing: validated knowledge fills a gap, it does not override a direct
   * DOM identity match.
   */
  known?: KnownTarget[] | undefined;
  /** Bounded AI assist, only when the caller authorized it. */
  assist?: LocatorAssist | undefined;
  timeoutMs?: number;
}

const TARGET_ACTIONS = new Set(["click", "type", "select", "hover"]);

export async function resolveTargets(input: ResolveTargetsInput): Promise<TargetResolution[]> {
  const targets = input.steps.filter((step) => TARGET_ACTIONS.has(step.action));
  if (targets.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(input.url, {
      waitUntil: "domcontentloaded",
      timeout: input.timeoutMs ?? 20_000,
    });

    const out: TargetResolution[] = [];
    for (const step of targets) {
      const tried: string[] = [];
      let resolution: TargetResolution = {
        stepIndex: step.index,
        selector: null,
        source: "none",
        tried,
        detail: "No locator candidate resolved in the live page.",
      };

      const candidates = locatorCandidates(step);
      const semantic = candidates.filter((candidate) => candidate.kind !== "recorded");

      const lookup = async (candidate: (typeof candidates)[number]): Promise<string | null> => {
        if (candidate.kind === "recorded") {
          // Presence only: `count()` includes elements inside a closed form.
          const count = await page.locator(candidate.value).count().catch(() => 0);
          return count > 0 ? candidate.value : null;
        }
        const found = await page
          .evaluate(
            `(${FIND_CONTROL_SRC})(${JSON.stringify({
              role: candidate.role ?? null,
              name: candidate.name ?? null,
              label: candidate.label ?? null,
              text: candidate.text ?? null,
            })})`,
          )
          .catch((error: unknown) => {
            console.error(
              `[targets] semantic lookup failed for step ${step.index}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          });
        return typeof found === "string" ? found : null;
      };

      // 1. The recorded DOM identity, when it still exists.
      for (const candidate of candidates.filter((row) => row.kind === "recorded")) {
        tried.push(`${candidate.kind}:${candidate.value}`);
        const selector = await lookup(candidate);
        if (!selector) continue;
        resolution = {
          stepIndex: step.index,
          selector,
          source: "recorded",
          tried,
          detail: `${candidate.note} resolved to ${selector}`,
        };
        break;
      }

      // 2. Reviewed memory, before fresh discovery: a repair that has already
      //    been validated for this workflow version answers the question. It is
      //    used only if the control it names is actually present in this page.
      if (resolution.source === "none") {
        const known = (input.known ?? []).find((row) => row.stepIndex === step.index);
        if (known) {
          tried.push(`repair:${known.selector}`);
          const count = await page.locator(known.selector).count().catch(() => 0);
          if (count > 0) {
            resolution = {
              stepIndex: step.index,
              selector: known.selector,
              source: "repair",
              tried,
              detail: `reviewed repair ${known.repairId} supplied ${known.selector}`,
              repairId: known.repairId,
            };
          }
        }
      }

      // 3. Semantic re-discovery when neither the DOM identity nor memory helps.
      if (resolution.source === "none") {
        for (const candidate of semantic) {
          tried.push(`${candidate.kind}:${candidate.value}`);
          const selector = await lookup(candidate);
          if (!selector) continue;
          resolution = {
            stepIndex: step.index,
            selector,
            source: "rediscovered",
            tried,
            detail: `${candidate.note} resolved to ${selector}`,
          };
          break;
        }
      }

      // 4. Bounded AI assistance, only where everything deterministic failed.
      if (resolution.source === "none" && input.assist) {
        const assisted = await input
          .assist(step)
          .then((value) => value?.trim() || null)
          .catch(() => null);
        if (assisted) {
          tried.push(`ai:${assisted}`);
          const count = await page.locator(assisted).count().catch(() => 0);
          if (count > 0) {
            resolution = {
              stepIndex: step.index,
              selector: assisted,
              source: "ai_assisted",
              tried,
              detail: `Bounded AI assistance identified the control as ${assisted}`,
            };
          }
        }
      }

      out.push(resolution);
    }
    return out;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Human-readable instruction for the AI locator fallback. */
export function locateInstruction(step: WorkflowStep): string {
  const label = step.elementName ?? step.fieldLabel ?? step.intent;
  return `Locate the control for step "${step.intent}" (${step.action}) whose visible label is "${label}". Return its selector; do not click or type.`;
}

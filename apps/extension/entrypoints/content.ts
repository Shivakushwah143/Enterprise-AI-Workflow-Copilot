/**
 * Content script (isolated world).
 *
 * Exactly two capabilities, both driven by the side panel:
 *   1. highlight a DOM element by a selector the API recorded, with Driver.js;
 *   2. show a visible recording indicator while a demonstration is running.
 *
 * If there is no selector, or the selector matches nothing, this returns
 * `highlighted: false`. It never falls back to a coordinate: pointing at a
 * guess would be worse than pointing at nothing.
 */
import { defineContentScript } from "wxt/sandbox";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";

interface HighlightMessage {
  type: "COPILOT_HIGHLIGHT";
  selector?: string | null;
  instruction?: string | null;
  elementName?: string | null;
}

interface ClearMessage {
  type: "COPILOT_CLEAR_HIGHLIGHT";
}

interface RecordingMessage {
  type: "COPILOT_RECORDING_INDICATOR";
  active?: boolean;
}

/**
 * Guided mode: the employee performs the step, the panel asks the page whether
 * the recorded control is actually there and visible. This is observation only -
 * the content script still never clicks, types or reads form values.
 */
interface VerifyStepMessage {
  type: "COPILOT_VERIFY_STEP";
  selector?: string | null;
}

type CopilotMessage = HighlightMessage | ClearMessage | RecordingMessage | VerifyStepMessage;

interface HighlightResponse {
  ok: boolean;
  highlighted: boolean;
  reason?: string;
}

interface VerifyStepResponse {
  ok: boolean;
  found: boolean;
  visible: boolean;
  reason: string;
  url: string;
}

export default defineContentScript({
  matches: ["http://127.0.0.1/*", "http://localhost/*"],
  runAt: "document_idle",
  main() {
    let activeDriver: Driver | null = null;
    let indicator: HTMLDivElement | null = null;

    function clearHighlight(): void {
      activeDriver?.destroy();
      activeDriver = null;
      delete document.documentElement.dataset["copilotHighlighted"];
    }

    function showRecordingIndicator(active: boolean): void {
      document.documentElement.dataset["copilotRecording"] = active ? "true" : "false";
      if (!active) {
        indicator?.remove();
        indicator = null;
        return;
      }
      if (indicator && document.body.contains(indicator)) return;
      indicator = document.createElement("div");
      indicator.textContent = "● Recording demonstration";
      indicator.setAttribute("data-copilot-indicator", "active");
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-live", "polite");
      Object.assign(indicator.style, {
        position: "fixed",
        top: "14px",
        right: "14px",
        zIndex: "2147483647",
        background: "#b00020",
        color: "#ffffff",
        fontFamily: '"Segoe UI", Arial, sans-serif',
        fontSize: "15px",
        fontWeight: "600",
        padding: "9px 14px",
        borderRadius: "999px",
        boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(indicator);
    }

    function highlight(message: HighlightMessage): HighlightResponse {
      const selector = (message.selector ?? "").trim();
      if (!selector) {
        clearHighlight();
        return { ok: true, highlighted: false, reason: "no-selector" };
      }
      let element: Element | null = null;
      try {
        element = document.querySelector(selector);
      } catch {
        clearHighlight();
        return { ok: true, highlighted: false, reason: "invalid-selector" };
      }
      if (!element) {
        clearHighlight();
        return { ok: true, highlighted: false, reason: "element-not-found" };
      }
      clearHighlight();
      activeDriver = driver({
        showProgress: false,
        allowClose: true,
        overlayColor: "rgba(10, 20, 40, 0.45)",
        stagePadding: 6,
        stageRadius: 8,
        popoverClass: "copilot-driver-popover",
        steps: [
          {
            element,
            popover: {
              title: message.elementName ?? "Next step",
              description: message.instruction ?? "Perform this step in the application.",
            },
          },
        ],
      });
      activeDriver.drive();
      document.documentElement.dataset["copilotHighlighted"] = selector;
      return { ok: true, highlighted: true };
    }

    function verifyStep(message: VerifyStepMessage): VerifyStepResponse {
      const selector = (message.selector ?? "").trim();
      const base = { ok: true, found: false, visible: false, url: location.href };
      if (!selector) return { ...base, reason: "no-selector" };
      let element: Element | null = null;
      try {
        element = document.querySelector(selector);
      } catch {
        return { ...base, ok: false, reason: "invalid-selector" };
      }
      if (!element) return { ...base, reason: "element-not-found" };
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0;
      return {
        ok: true,
        found: true,
        visible,
        reason: visible ? "control-present" : "control-hidden",
        url: location.href,
      };
    }

    chrome.runtime.onMessage.addListener(
      (
        message: CopilotMessage,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: HighlightResponse | VerifyStepResponse | { ok: boolean }) => void,
      ) => {
        if (message.type === "COPILOT_VERIFY_STEP") {
          sendResponse(verifyStep(message));
          return false;
        }
        if (message.type === "COPILOT_HIGHLIGHT") {
          sendResponse(highlight(message));
          return false;
        }
        if (message.type === "COPILOT_CLEAR_HIGHLIGHT") {
          clearHighlight();
          sendResponse({ ok: true });
          return false;
        }
        if (message.type === "COPILOT_RECORDING_INDICATOR") {
          showRecordingIndicator(Boolean(message.active));
          sendResponse({ ok: true });
          return false;
        }
        return false;
      },
    );
  },
});

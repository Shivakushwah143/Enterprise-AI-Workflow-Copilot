/**
 * Background service worker.
 *
 * One job: make the toolbar button open the side panel. All copilot state lives
 * in the side panel and the API, so there is nothing to relay here.
 */
import { defineBackground } from "wxt/sandbox";

export default defineBackground(() => {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error("Could not enable side panel on action click", error);
    });
});

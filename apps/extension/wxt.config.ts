import { defineConfig } from "wxt";

/**
 * Chromium MV3 extension.
 *
 * The side panel is the copilot UI; the content script only ever does two
 * things to the page it runs on: highlight a selector the API told us about,
 * and show the recording indicator. It never clicks, types or reads form data.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  outDir: ".output",
  manifest: {
    name: "Enterprise AI Workflow Copilot",
    description:
      "Ask for a business outcome, let the copilot run the approved workflow, and see what the system of record actually says.",
    version: "0.1.0",
    permissions: ["sidePanel", "storage", "tabs", "activeTab"],
    // The API and both demo applications are local. Nothing else is contacted.
    host_permissions: ["http://127.0.0.1:*/*", "http://localhost:*/*"],
    action: {
      default_title: "Open the copilot",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
});

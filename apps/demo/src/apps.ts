/**
 * Two small, disposable business applications for the demonstration.
 *
 * Why our own apps instead of OpenAdapt's bundled MockMed/MockLoan: the
 * copilot's claim is "a customer was created". The demonstration, the replay
 * and the independent read-back must all target the SAME business object, with
 * a database we can query out of band. These apps are that object.
 *
 * They are deliberately plain: stable ids, static layout, no animation, no
 * random content - so a compiled replay is testing the workflow, not the layout
 * churn. The second app (StockDesk) shares no markup with the first, which is
 * what makes the cross-application scenario meaningful.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Fault injection for the demonstration apps.
 *
 * `reject-create` refuses the write; `missing-control` serves the same page
 * with the save control removed, which is what "the UI changed and the button
 * is gone" looks like to a replay. `renamed-selector` keeps the page and the
 * control's label identical and changes only the save button's id, which is the
 * smallest UI change a locator ladder can legitimately recover from.
 * `relabeled-selector` is the next change a real application ships: the same
 * control with a new id *and* new wording (`Commit changes`), which no DOM-text
 * heuristic can re-identify.
 * `css-label-selector` is a design-system restyle: the control keeps the id it
 * was given in the previous release but its label now comes from CSS, so the
 * DOM carries no text while the screen looks exactly the same.
 */
export type FaultMode =
  | "none"
  | "reject-create"
  | "missing-control"
  | "renamed-selector"
  | "relabeled-selector"
  | "css-label-selector";

const ACME_SAVE_BUTTON =
  '<button id="save-customer" class="primary" type="submit">Save customer</button>';
const STOCK_SAVE_BUTTON =
  '<button id="save-item" class="act" type="submit">Register item</button>';

function withMissingControl(page: string, button: string, replacement: string): string {
  return page.replace(button, replacement);
}

/**
 * The same page with only the save control's id changed. Every other byte -
 * label text, field ids, classes - is untouched, so a replay only has to
 * re-identify one element.
 */
/**
 * The same pixels, no DOM text: the label is rendered by CSS on a control that
 * kept the id from the previous release. A locator ladder that reads text,
 * role names or labels has nothing to match; the screen is unchanged.
 */
function withCssLabel(page: string, button: string, id: string): string {
  return page
    .replace(
      button,
      `<button id="${id}" class="primary css-label" type="submit"></button>`,
    )
    .replace(
      "</style>",
      "  .css-label::after { content: 'Save customer'; }\n</style>",
    );
}

function withRenamedSaveControl(
  page: string,
  button: string,
  fromId: string,
  toId: string,
): string {
  return page.replace(button, button.replace(`id="${fromId}"`, `id="${toId}"`));
}

export interface AppHandle {
  close(): Promise<void>;
  url: string;
  name: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function openDatabase(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  return db;
}

/* ------------------------------------------------------------------ */
/* AcmeDesk CRM                                                        */
/* ------------------------------------------------------------------ */

const ACME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AcmeDesk CRM</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #f4f6fb; color: #16213a; }
  .topbar { background: #1d3f8f; color: #fff; padding: 14px 28px; font-size: 20px; font-weight: 600; }
  main { max-width: 880px; margin: 0 auto; padding: 28px; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  h2 { font-size: 20px; margin: 28px 0 10px; }
  p.sub { margin: 0 0 20px; color: #4a5570; }
  button { font-size: 17px; padding: 12px 20px; border-radius: 8px; border: 1px solid #9aa6c0; background: #fff; cursor: pointer; }
  button.primary { background: #1d3f8f; color: #fff; border-color: #1d3f8f; font-weight: 600; }
  form { margin: 20px 0; padding: 20px; background: #fff; border: 1px solid #d3daea; border-radius: 10px; }
  label { display: block; font-weight: 600; margin: 14px 0 6px; font-size: 16px; }
  input, select { width: 100%; box-sizing: border-box; font-size: 17px; padding: 10px 12px; border: 1px solid #9aa6c0; border-radius: 6px; background: #fff; }
  #flash { min-height: 26px; margin: 14px 0; font-size: 17px; font-weight: 600; }
  #flash.ok { color: #11632f; }
  #flash.error { color: #a11212; }
  #customer-list { list-style: none; padding: 0; margin: 0; }
  #customer-list li { background: #fff; border: 1px solid #d3daea; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; font-size: 16px; }
</style>
</head>
<body>
<header class="topbar">AcmeDesk CRM</header>
<main>
  <h1 id="page-title">Customers</h1>
  <p class="sub">Manage your company's customer accounts.</p>
  <button id="new-customer" class="primary">New customer</button>
  <div id="flash" role="status"></div>
  <form id="customer-form" hidden>
    <label for="customer-name">Company name</label>
    <input id="customer-name" name="company_name" autocomplete="off">
    <label for="customer-email">Contact email</label>
    <input id="customer-email" name="email" autocomplete="off">
    <label for="customer-tier">Tier</label>
    <select id="customer-tier" name="tier">
      <option>Standard</option>
      <option>Enterprise</option>
    </select>
    <button id="save-customer" class="primary" type="submit">Save customer</button>
  </form>
  <h2>Customer list</h2>
  <ul id="customer-list"></ul>
</main>
<script>
const flash = document.getElementById('flash');
const form = document.getElementById('customer-form');
function setFlash(text, kind) { flash.textContent = text; flash.className = kind || ''; }
async function refresh() {
  const res = await fetch('/api/customers');
  const data = await res.json();
  const list = document.getElementById('customer-list');
  list.innerHTML = '';
  for (const item of data.items) {
    const li = document.createElement('li');
    li.textContent = item.name + ' - ' + item.email + ' (' + item.tier + ')';
    list.appendChild(li);
  }
}
document.getElementById('new-customer').addEventListener('click', () => {
  form.hidden = false;
  setFlash('', '');
  document.getElementById('customer-name').focus();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    name: document.getElementById('customer-name').value,
    email: document.getElementById('customer-email').value,
    tier: document.getElementById('customer-tier').value,
  };
  const res = await fetch('/api/customers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.ok) {
    setFlash('Customer created: ' + data.item.name, 'ok');
    form.hidden = true;
    form.reset();
  } else {
    setFlash('Save failed: ' + (data.error || 'unknown error'), 'error');
  }
  await refresh();
});
refresh();
</script>
</body>
</html>`;

export async function startAcmeDesk(options: {
  port: number;
  dataDir: string;
}): Promise<AppHandle> {
  const db = openDatabase(path.join(options.dataDir, "acme.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS faults (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL)`);
  db.exec(`INSERT INTO faults (id, mode) VALUES (1, 'none') ON CONFLICT (id) DO NOTHING`);

  const getFault = (): FaultMode => {
    const row = db.prepare("SELECT mode FROM faults WHERE id = 1").get() as
      | { mode: string }
      | undefined;
    if (row?.mode === "reject-create") return "reject-create";
    if (row?.mode === "missing-control") return "missing-control";
    if (row?.mode === "renamed-selector") return "renamed-selector";
    if (row?.mode === "relabeled-selector") return "relabeled-selector";
    if (row?.mode === "css-label-selector") return "css-label-selector";
    return "none";
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /") {
        const fault = getFault();
        if (fault === "missing-control") {
          return html(
            res,
            withMissingControl(
              ACME_HTML,
              ACME_SAVE_BUTTON,
              '<p id="save-unavailable">Saving is temporarily unavailable.</p>',
            ),
          );
        }
        if (fault === "renamed-selector") {
          return html(
            res,
            withRenamedSaveControl(
              ACME_HTML,
              ACME_SAVE_BUTTON,
              "save-customer",
              "save-customer-v2",
            ),
          );
        }
        if (fault === "css-label-selector") {
          return html(res, withCssLabel(ACME_HTML, ACME_SAVE_BUTTON, "save-customer-v2"));
        }
        if (fault === "relabeled-selector") {
          return html(
            res,
            withMissingControl(
              ACME_HTML,
              ACME_SAVE_BUTTON,
              '<button id="save-customer-v2" class="primary" type="submit">Commit changes</button>',
            ),
          );
        }
        return html(res, ACME_HTML);
      }

      if (route === "GET /api/customers") {
        const name = (url.searchParams.get("name") ?? "").trim();
        const email = (url.searchParams.get("email") ?? "").trim();
        const rows = db
          .prepare(
            `SELECT id, name, email, tier, created_at FROM customers
              WHERE ($name = '' OR lower(name) LIKE '%' || lower($name) || '%')
                AND ($email = '' OR lower(email) LIKE '%' || lower($email) || '%')
              ORDER BY id`,
          )
          .all({ name, email }) as Record<string, unknown>[];
        return json(res, 200, {
          items: rows.map((row) => ({
            id: row["id"],
            name: row["name"],
            email: row["email"],
            tier: row["tier"],
            createdAt: row["created_at"],
          })),
        });
      }

      if (route === "POST /api/customers") {
        const body = await readJson(req);
        const name = String(body["name"] ?? "").trim();
        const email = String(body["email"] ?? "").trim();
        const tier = String(body["tier"] ?? "Standard").trim() || "Standard";
        if (!name || !email.includes("@")) {
          return json(res, 422, { error: "Company name and contact email are required" });
        }
        if (getFault() === "reject-create") {
          // A real downstream rejection: nothing is written.
          return json(res, 500, {
            error: "Downstream validation rejected this customer",
          });
        }
        const existing = db
          .prepare("SELECT id FROM customers WHERE lower(name) = lower(?)")
          .get(name) as { id: number } | undefined;
        if (existing) {
          return json(res, 409, { error: "A customer with that name already exists" });
        }
        db.prepare(
          "INSERT INTO customers (name, email, tier, created_at) VALUES (?, ?, ?, ?)",
        ).run(name, email, tier, new Date().toISOString());
        const created = db
          .prepare("SELECT id, name, email, tier, created_at FROM customers WHERE lower(name) = lower(?)")
          .get(name) as Record<string, unknown>;
        return json(res, 201, {
          item: {
            id: created["id"],
            name: created["name"],
            email: created["email"],
            tier: created["tier"],
            createdAt: created["created_at"],
          },
        });
      }

      if (route === "GET /api/status") {
        const count = db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number };
        db.prepare("SELECT id FROM customers LIMIT 1").get();
        return json(res, 200, { customers: Number(count.n), fault: getFault() });
      }

      if (route === "GET /api/faults") return json(res, 200, { mode: getFault() });

      if (route === "POST /api/faults") {
        const body = await readJson(req);
        const mode =
          body["mode"] === "reject-create"
            ? "reject-create"
            : body["mode"] === "missing-control"
              ? "missing-control"
              : body["mode"] === "renamed-selector"
                ? "renamed-selector"
                : body["mode"] === "relabeled-selector"
                  ? "relabeled-selector"
                  : body["mode"] === "css-label-selector"
                    ? "css-label-selector"
                    : "none";
        db.prepare("UPDATE faults SET mode = ? WHERE id = 1").run(mode);
        return json(res, 200, { mode });
      }

      if (route === "POST /api/reset") {
        db.exec("DELETE FROM customers");
        db.prepare("UPDATE faults SET mode = 'none' WHERE id = 1").run();
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : "internal error",
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  return {
    name: "AcmeDesk CRM",
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/* ------------------------------------------------------------------ */
/* StockDesk — a deliberately different application                    */
/* ------------------------------------------------------------------ */

const STOCK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>StockDesk Inventory</title>
<style>
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #fffdf6; color: #23201a; }
  .masthead { border-bottom: 4px solid #7a3b12; padding: 18px 32px; font-size: 26px; letter-spacing: 1px; }
  main { max-width: 820px; margin: 0 auto; padding: 26px 32px 60px; }
  h1 { font-size: 28px; margin: 10px 0 4px; }
  .hint { color: #6b6250; margin-bottom: 20px; }
  button { font: inherit; font-size: 16px; padding: 10px 18px; border: 2px solid #7a3b12; background: #fff; color: #7a3b12; cursor: pointer; }
  button.act { background: #7a3b12; color: #fffdf6; }
  form { margin: 18px 0; padding: 18px; border: 1px dashed #b9a888; }
  label { display: block; margin: 12px 0 4px; font-size: 16px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 10px; border: 1px solid #b9a888; }
  #flash { min-height: 24px; margin: 12px 0; font-size: 16px; }
  #flash.ok { color: #1c5c2a; }
  #flash.error { color: #8c1a1a; }
  #item-list { padding-left: 20px; }
  #item-list li { padding: 6px 0; font-size: 16px; }
</style>
</head>
<body>
<div class="masthead">StockDesk Inventory</div>
<main>
  <h1 id="page-title">Stock items</h1>
  <p class="hint">Register received goods against their stock keeping unit.</p>
  <button id="new-item" class="act">New stock item</button>
  <div id="flash" role="status"></div>
  <form id="item-form" hidden>
    <label for="item-sku">SKU</label>
    <input id="item-sku" name="sku" autocomplete="off">
    <label for="item-qty">Quantity received</label>
    <input id="item-qty" name="quantity" autocomplete="off">
    <button id="save-item" class="act" type="submit">Register item</button>
  </form>
  <h2>Registered items</h2>
  <ol id="item-list"></ol>
</main>
<script>
const flash = document.getElementById('flash');
const form = document.getElementById('item-form');
async function refresh() {
  const res = await fetch('/api/items');
  const data = await res.json();
  const list = document.getElementById('item-list');
  list.innerHTML = '';
  for (const item of data.items) {
    const li = document.createElement('li');
    li.textContent = item.sku + ' qty ' + item.quantity;
    list.appendChild(li);
  }
}
document.getElementById('new-item').addEventListener('click', () => {
  form.hidden = false;
  flash.textContent = '';
  document.getElementById('item-sku').focus();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await fetch('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sku: document.getElementById('item-sku').value,
      quantity: document.getElementById('item-qty').value,
    }),
  });
  const data = await res.json();
  if (res.ok) {
    flash.textContent = 'Registered ' + data.item.sku;
    flash.className = 'ok';
    form.hidden = true;
    form.reset();
  } else {
    flash.textContent = 'Registration failed: ' + (data.error || 'unknown error');
    flash.className = 'error';
  }
  await refresh();
});
refresh();
</script>
</body>
</html>`;

export async function startStockDesk(options: {
  port: number;
  dataDir: string;
}): Promise<AppHandle> {
  const db = openDatabase(path.join(options.dataDir, "stockdesk.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS faults (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL)`);
  db.exec(`INSERT INTO faults (id, mode) VALUES (1, 'none') ON CONFLICT (id) DO NOTHING`);

  const getFault = (): FaultMode => {
    const row = db.prepare("SELECT mode FROM faults WHERE id = 1").get() as
      | { mode: string }
      | undefined;
    if (row?.mode === "reject-create") return "reject-create";
    if (row?.mode === "missing-control") return "missing-control";
    if (row?.mode === "renamed-selector") return "renamed-selector";
    if (row?.mode === "relabeled-selector") return "relabeled-selector";
    if (row?.mode === "css-label-selector") return "css-label-selector";
    return "none";
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /") {
        const fault = getFault();
        if (fault === "missing-control") {
          return html(
            res,
            withMissingControl(
              STOCK_HTML,
              STOCK_SAVE_BUTTON,
              '<p id="save-unavailable">Registration is temporarily unavailable.</p>',
            ),
          );
        }
        if (fault === "renamed-selector") {
          return html(
            res,
            withRenamedSaveControl(STOCK_HTML, STOCK_SAVE_BUTTON, "save-item", "save-item-v2"),
          );
        }
        if (fault === "relabeled-selector") {
          return html(
            res,
            withMissingControl(
              STOCK_HTML,
              STOCK_SAVE_BUTTON,
              '<button id="save-item-v2" class="act" type="submit">Commit changes</button>',
            ),
          );
        }
        return html(res, STOCK_HTML);
      }

      if (route === "GET /api/items") {
        const sku = (url.searchParams.get("sku") ?? "").trim();
        const rows = db
          .prepare(
            `SELECT id, sku, quantity FROM items
              WHERE ($sku = '' OR lower(sku) LIKE '%' || lower($sku) || '%')
              ORDER BY id`,
          )
          .all({ sku }) as Record<string, unknown>[];
        return json(res, 200, {
          items: rows.map((row) => ({
            id: row["id"],
            sku: row["sku"],
            quantity: row["quantity"],
          })),
        });
      }

      if (route === "POST /api/items") {
        const body = await readJson(req);
        const sku = String(body["sku"] ?? "").trim();
        const quantityRaw = String(body["quantity"] ?? "").trim();
        const quantity = Number(quantityRaw);
        if (!sku || !Number.isFinite(quantity) || quantity <= 0) {
          return json(res, 422, { error: "A SKU and a positive quantity are required" });
        }
        if (getFault() === "reject-create") {
          return json(res, 500, { error: "Warehouse system rejected the registration" });
        }
        db.prepare(
          "INSERT INTO items (sku, quantity, created_at) VALUES (?, ?, ?)",
        ).run(sku, Math.trunc(quantity), new Date().toISOString());
        const created = db
          .prepare("SELECT id, sku, quantity FROM items WHERE sku = ? ORDER BY id DESC LIMIT 1")
          .get(sku) as Record<string, unknown>;
        return json(res, 201, {
          item: { id: created["id"], sku: created["sku"], quantity: created["quantity"] },
        });
      }

      if (route === "GET /api/faults") return json(res, 200, { mode: getFault() });

      if (route === "POST /api/faults") {
        const body = await readJson(req);
        const mode =
          body["mode"] === "reject-create"
            ? "reject-create"
            : body["mode"] === "missing-control"
              ? "missing-control"
              : body["mode"] === "renamed-selector"
                ? "renamed-selector"
                : body["mode"] === "relabeled-selector"
                  ? "relabeled-selector"
                  : body["mode"] === "css-label-selector"
                    ? "css-label-selector"
                    : "none";
        db.prepare("UPDATE faults SET mode = ? WHERE id = 1").run(mode);
        return json(res, 200, { mode });
      }

      if (route === "POST /api/reset") {
        db.exec("DELETE FROM items");
        db.prepare("UPDATE faults SET mode = 'none' WHERE id = 1").run();
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 500, {
        error: error instanceof Error ? error.message : "internal error",
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  return {
    name: "StockDesk",
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

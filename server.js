// server.js
"use strict";

const express = require("express");
const { google } = require("googleapis");

// Use global fetch on Node >=18, fallback to node-fetch if needed.
const fetch = (...args) =>
  (global.fetch
    ? global.fetch(...args)
    : import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Env ----
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PUBLIC_BASE_URL_ENV = process.env.PUBLIC_BASE_URL || "";
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || "";
const SHEETS_TAB_NAME = process.env.SHEETS_TAB_NAME || "Sheet1";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";

// ---- Helpers: base URL ----
function getBaseUrl(req) {
  if (PUBLIC_BASE_URL_ENV) return PUBLIC_BASE_URL_ENV.replace(/\/+$/, "");
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    req.protocol ||
    "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// ---- Helpers: Google Sheets ----
async function getSheetsClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SHEETS_SPREADSHEET_ID) {
    throw new Error("Sheets env vars missing");
  }
  const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!key.client_email || !key.private_key) {
    throw new Error("Bad service account key");
  }
  // Fix escaped newlines in the private key
  key.private_key = String(key.private_key).replace(/\\n/g, "\n");

  const auth = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function appendRowToSheet(row) {
  try {
    if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.warn("Sheets disabled: missing SHEETS_SPREADSHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON");
      return;
    }
    const sheets = await getSheetsClient();
    const range = `${SHEETS_TAB_NAME}!A:Z`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error("Sheets append error:", err && err.message ? err.message : err);
  }
}

// ---- Helpers: normalize cart from Tilda or generic forms ----
function normalizeCart(body) {
  const orderId =
    body.orderId ||
    body.order_id ||
    body.tildaorderid ||
    body.order ||
    "";

  let total = parseFloat(
    body.total ||
      body.amount ||
      body.sum ||
      body.price ||
      body.orderprice ||
      0
  );
  if (Number.isNaN(total)) total = 0;

  // Products can be an array or a JSON string under different keys
  let items = [];
  const possible = body.items || body.products || body.cart || body.cart_json;
  if (possible) {
    try {
      const parsed = Array.isArray(possible) ? possible : JSON.parse(possible);
      items = parsed.map((it) => ({
        title: it.title || it.name || "Item",
        unit_price: Number(it.price || it.unit_price || 0),
        quantity: Number(it.quantity || 1),
        currency_id: it.currency_id || "ARS",
      }));
      if (!total) {
        total = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
      }
    } catch (_e) {
      // If parsing fails, we will fallback to single-item preference for full amount
    }
  }

  const customer = {
    email:
      body.email ||
      body.client_email ||
      body.customer_email ||
      body.Mail ||
      undefined,
    name:
      body.name ||
      body.client_name ||
      body.customer_name ||
      undefined,
    phone:
      body.phone ||
      body.client_phone ||
      body.customer_phone ||
      undefined,
  };

  total = Math.round(total * 100) / 100;
  return { total, items, orderId, customer };
}

// ---- Health ----
app.get("/", (_req, res) => res.type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- Create Mercado Pago checkout and redirect ----
app.post("/mp/create-checkout", async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).send("MP_ACCESS_TOKEN is not set");
    }
    const baseUrl = getBaseUrl(req);
    const { total, items, orderId, customer } = normalizeCart(req.body);

    if (!total || total <= 0) {
      return res.status(400).send("Bad total");
    }

    const preference = {
      items:
        items && items.length
          ? items
          : [
              {
                title: `Order ${orderId || ""}`,
                unit_price: total,
                quantity: 1,
                currency_id: "ARS",
              },
            ],
      back_urls: {
        success: `${baseUrl}/mp/return?status=success`,
        failure: `${baseUrl}/mp/return?status=failure`,
        pending: `${baseUrl}/mp/return?status=pending`,
      },
      auto_return: "approved",
      notification_url: `${baseUrl}/mp/webhook`,
      external_reference: orderId || undefined,
      payer: customer?.email ? { email: customer.email } : undefined,
      metadata: {
        orderId: orderId || "",
        items,
      },
    };

    const mpResp = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(preference),
      }
    );

    const data = await mpResp.json();
    if (!mpResp.ok) {
      console.error("MP preference error:", data);
      return res.status(502).send("Mercado Pago error");
    }

    const url = data.init_point || data.sandbox_init_point;
    if (!url) {
      console.error("MP preference has no init_point:", data);
      return res.status(502).send("Mercado Pago error");
    }
    return res.redirect(302, url);
  } catch (e) {
    console.error("create-checkout error:", e && e.message ? e.message : e);
    return res.status(500).send("Internal error");
  }
});

// ---- Mercado Pago webhook ----
// Supports both "webhooks" (JSON body with type/action/data.id)
// and a fallback for query-based notifications (topic/type + id)
app.post("/mp/webhook", async (req, res) => {
  // Always acknowledge quickly to avoid retries
  res.status(200).send("OK");

  try {
    const body = req.body || {};
    const q = req.query || {};

    // Preferred v1: body.type === "payment" and body.data.id present
    let type = body.type || body.topic || q.type || q.topic || "";
    let action = body.action || "";
    let id =
      (body.data && body.data.id) ||
      q["data.id"] ||
      q.id ||
      "";

    // Normalize case
    type = String(type || "").toLowerCase();
    action = String(action || "").toLowerCase();

    const isPayment =
      type === "payment" || action.startsWith("payment");

    if (isPayment && id) {
      // Schedule async processing outside of the request lifecycle
      setImmediate(() => handlePayment(String(id)));
    } else if ((type === "merchant_order" || type === "order") && id) {
      // If you need merchant_order details, fetch here similarly
      // setImmediate(() => handleMerchantOrder(String(id)));
      // For now, no-op
      console.log("Received merchant_order notification:", id);
    } else {
      console.log("Webhook received but did not match payment:", { type, action, id });
    }
  } catch (e) {
    console.error("webhook error:", e && e.message ? e.message : e);
  }
});

async function handlePayment(paymentId) {
  try {
    if (!MP_ACCESS_TOKEN) {
      console.error("handlePayment: MP_ACCESS_TOKEN missing");
      return;
    }
    const resp = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );
    const payment = await resp.json();

    if (!resp.ok) {
      console.error("MP payment fetch error:", payment);
      return;
    }

    if (String(payment.status).toLowerCase() === "approved") {
      const md = payment.metadata || {};
      const items =
        md.items ||
        (payment.additional_info && payment.additional_info.items) ||
        [];
      const total = payment.transaction_amount;
      const email =
        (payment.payer && payment.payer.email) ||
        (payment.additional_info &&
          payment.additional_info.payer &&
          payment.additional_info.payer.email) ||
        "";

      const row = [
        new Date().toISOString(),
        String(payment.id),
        md.orderId || payment.external_reference || "",
        email,
        total,
        payment.currency_id || "ARS",
        JSON.stringify(items),
      ];

      await appendRowToSheet(row);
    } else {
      console.log("Payment not approved, status:", payment.status, "id:", payment.id);
    }
  } catch (e) {
    console.error("handlePayment error:", e && e.message ? e.message : e);
  }
}

// ---- Simple return page after MP ----
app.get("/mp/return", (req, res) => {
  const status = String(req.query.status || "").toLowerCase();
  let message = "Pago cancelado o rechazado.";
  if (status === "success") message = "Pago aprobado. Gracias!";
  else if (status === "pending") message = "Pago pendiente.";

  res.type("html").send(
    [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><title>MP return</title></head>',
      "<body>",
      `<h2>${message}</h2>`,
      '<p><a href="/">Volver</a></p>',
      "</body></html>",
    ].join("")
  );
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});

'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);

// raw-тело для вебхуков MP (на будущее — если решите проверять подпись)
app.use('/mp/webhook', express.raw({ type: '*/*' }));

// обычный JSON-парсер для остальных роутов
app.use(express.json());
app.use(cors());

// ENV
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || ''; // не обязателен
const CURRENCY = (process.env.CURRENCY || 'ARS').toUpperCase();

// Tilda
const TILDA_SECRET = process.env.TILDA_SECRET || '';
const TILDA_SUCCESS_FIELD = process.env.TILDA_SUCCESS_FIELD || 'result';
const TILDA_SUCCESS_VALUE = process.env.TILDA_SUCCESS_VALUE || 'ok';
const TILDA_REDIRECT_FIELD = process.env.TILDA_REDIRECT_FIELD || 'redirect';
const TILDA_THANK_YOU_URL = process.env.TILDA_THANK_YOU_URL || '';
const TILDA_FAIL_URL = process.env.TILDA_FAIL_URL || '';

// Google Sheets
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Orders';

// ленивое подключение к Sheets
let sheetsClient = null;
async function getSheets() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEET_ID) return null;
  if (!sheetsClient) {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  }
  return sheetsClient;
}

const nowIso = () => new Date().toISOString();

function safeJsonParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
}

// Пытаемся аккуратно вытащить корзину из популярных полей Тильды
function extractCartFromTilda(body) {
  let items = [];
  let total = Number(body.amount || body.total || body.sum || 0);
  let currency = (body.currency || body.currency_id || CURRENCY || 'ARS').toString().toUpperCase();

  // Типичные места, где лежит JSON корзины
  const productsJson = body.products || body.cart || body.items_json || body['tildapayment-products'];
  const parsed = safeJsonParse(productsJson);
  if (Array.isArray(parsed)) {
    items = parsed.map(p => ({
      title: (p.title || p.name || 'Item'),
      quantity: Number(p.quantity || p.qty || 1),
      unit_price: Number(p.unit_price || p.price || p.amount || 0),
    }));
  }

  // fallback: если ничего не нашли, но есть total — делаем 1 позицию
  if (!items.length && total > 0) {
    items = [{ title: 'Order from Tilda', quantity: 1, unit_price: Number(total) }];
  }

  // если total не пришёл, считаем из items
  if (!total && items.length) {
    total = items.reduce((s, it) => s + (Number(it.unit_price) * Number(it.quantity || 1)), 0);
  }

  const customer = {
    name: (body.name || `${body.firstname || ''} ${body.lastname || ''}`).trim() || undefined,
    email: (body.email || body.customer_email || body.mail) || undefined,
    phone: (body.phone || body.customer_phone || body.tel) || undefined,
    address: body.address || undefined,
  };

  const note = (body.comment || body.note || body.comments) || '';

  return { items, total, currency, customer, note };
}

async function appendOrderToSheet(order) {
  const sheets = await getSheets();
  if (!sheets) {
    console.warn('[Sheets] disabled — skip append');
    return;
  }
  const values = [[
    nowIso(),                     // A: timestamp
    order.orderId,                // B: order id
    order.status,                 // C: status
    order.total,                  // D: total
    order.currency,               // E: currency
    order.customer?.name || '',   // F
    order.customer?.email || '',  // G
    order.customer?.phone || '',  // H
    JSON.stringify(order.items),  // I
    order.note || '',             // J
    order.paymentId || '',        // K
    order.paymentStatus || ''     // L
  ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_NAME}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function updateOrderInSheet(orderId, patch) {
  const sheets = await getSheets();
  if (!sheets) {
    console.warn('[Sheets] disabled — skip update');
    return false;
  }

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_NAME}!A:L`,
    majorDimension: 'ROWS',
  });

  const rows = data.values || [];
  let targetRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][1] || '') === orderId) { // column B — orderId
      targetRow = i + 1; // строки листа начинаются с 1
      break;
    }
  }

  if (targetRow === -1) {
    console.warn(`[Sheets] ${orderId} not found — append new row`);
    await appendOrderToSheet({
      orderId,
      status: patch.status || 'PAID',
      total: patch.total || '',
      currency: patch.currency || CURRENCY,
      customer: { name: patch.payerName || '', email: patch.payerEmail || '', phone: patch.payerPhone || '' },
      items: patch.items || [],
      note: '',
      paymentId: patch.paymentId || '',
      paymentStatus: patch.paymentStatus || '',
    });
    return true;
  }

  // Обновим C..L (Status..PaymentStatus)
  const rowRange = `${GOOGLE_SHEET_NAME}!C${targetRow}:L${targetRow}`;
  const row = rows[targetRow - 1];

  const newRow = [
    patch.status ?? row[2 - 2],
    patch.total ?? row[3 - 2],
    patch.currency ?? row[4 - 2],
    patch.payerName ?? row[5 - 2],
    patch.payerEmail ?? row[6 - 2],
    patch.payerPhone ?? row[7 - 2],
    patch.items ? JSON.stringify(patch.items) : row[8 - 2],
    patch.note ?? row[9 - 2],
    patch.paymentId ?? row[10 - 2],
    patch.paymentStatus ?? row[11 - 2],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rowRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [newRow] },
  });
  return true;
}

// Healthcheck
app.get('/healthz', (req, res) => res.json({ ok: true, time: nowIso() }));

// Точка для Тильды: создаем ссылку оплаты в MP
app.post('/tilda/checkout', async (req, res) => {
  try {
    // Проверка секрета (если задан)
    if (TILDA_SECRET) {
      const candidate = req.headers['x-tilda-secret'] || req.body.secret || req.body.token || req.query.secret;
      if (candidate !== TILDA_SECRET) {
        return res.status(401).json({ error: 'invalid_secret' });
      }
    }

    const { items, total, currency, customer, note } = extractCartFromTilda(req.body);
    const orderId = `pho_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const backSuccess = `${PUBLIC_BASE_URL}/mp/return?status=success&orderId=${encodeURIComponent(orderId)}`;
    const backFailure = `${PUBLIC_BASE_URL}/mp/return?status=failure&orderId=${encodeURIComponent(orderId)}`;
    const backPending = `${PUBLIC_BASE_URL}/mp/return?status=pending&orderId=${encodeURIComponent(orderId)}`;
    const notificationUrl = `${PUBLIC_BASE_URL}/mp/webhook`;

    const preferencePayload = {
      items: items.map(it => ({
        title: it.title,
        quantity: Number(it.quantity) || 1,
        unit_price: Number(it.unit_price),
        currency_id: currency || CURRENCY,
      })),
      payer: {
        name: customer?.name,
        email: customer?.email,
        phone: customer?.phone ? { number: String(customer.phone) } : undefined,
      },
      back_urls: { success: backSuccess, failure: backFailure, pending: backPending },
      auto_return: 'approved',
      external_reference: orderId,
      metadata: {
        orderId,
        customer_name: customer?.name,
        customer_email: customer?.email,
      },
      notification_url: notificationUrl
    };

    const mpResp = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      preferencePayload,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const checkoutUrl = mpResp.data.init_point || mpResp.data.sandbox_init_point;

    // Запишем «CREATED» (не мешает оформлению, ошибки глушим)
    appendOrderToSheet({
      orderId, status: 'CREATED', total, currency, customer, items, note
    }).catch(err => console.error('[Sheets] append error:', err?.response?.data || err.message));

    // Ответ в формате, который ждёт Тильда
    const payload = { [TILDA_SUCCESS_FIELD]: TILDA_SUCCESS_VALUE };
    payload[TILDA_REDIRECT_FIELD] = checkoutUrl;
    return res.json(payload);

  } catch (err) {
    console.error('Checkout error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

// Редирект обратно на страницы Тильды
app.get('/mp/return', (req, res) => {
  const status = (req.query.status || '').toString().toLowerCase();
  const orderId = req.query.orderId || '';
  const target =
    status === 'success' && TILDA_THANK_YOU_URL ? TILDA_THANK_YOU_URL :
    status === 'failure' && TILDA_FAIL_URL ? TILDA_FAIL_URL :
    TILDA_THANK_YOU_URL || TILDA_FAIL_URL || '/healthz';
  const url = target.includes('?') ? `${target}&orderId=${encodeURIComponent(orderId)}` : `${target}?orderId=${encodeURIComponent(orderId)}`;
  res.redirect(302, url);
});

// Webhook от Mercado Pago
app.post('/mp/webhook', async (req, res) => {
  res.status(200).send('OK'); // отвечаем быстро

  try {
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { event = {}; }

    if (!event || !event.type || !event.data || !event.data.id) {
      console.warn('[Webhook] unexpected payload', event);
      return;
    }

    if (event.type !== 'payment') {
      console.log('[Webhook] ignore type:', event.type);
      return;
    }

    const paymentId = event.data.id;
    const { data: payment } = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });

    const orderId = payment.external_reference || payment.metadata?.orderId || null;
    const status = (payment.status || '').toUpperCase();

    const patch = {
      status: status === 'APPROVED' ? 'PAID' : status,
      paymentId: String(paymentId),
      paymentStatus: payment.status,
      total: payment.transaction_amount,
      currency: payment.currency_id || CURRENCY,
      payerName: payment.payer?.first_name ? `${payment.payer.first_name} ${payment.payer.last_name || ''}`.trim() : undefined,
      payerEmail: payment.payer?.email,
      items: payment.additional_info?.items || undefined,
    };

    if (orderId) {
      await updateOrderInSheet(orderId, patch);
    } else {
      console.warn('[Webhook] no external_reference for payment', paymentId);
      await appendOrderToSheet({
        orderId: `mp_${paymentId}`,
        status: patch.status,
        total: patch.total,
        currency: patch.currency,
        customer: { name: patch.payerName || '', email: patch.payerEmail || '' },
        items: patch.items || [],
        note: '',
        paymentId,
        paymentStatus: payment.status,
      });
    }

  } catch (err) {
    console.error('[Webhook] error:', err?.response?.data || err.message);
  }
});

app.listen(PORT, () => {
  console.log(`pho-backend listening on ${PORT}`);
});

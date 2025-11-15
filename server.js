// server.js
// Express backend: creates MP preference, confirms payment, logs to Google Sheets.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────────────────────
// Обязательно задайте эти переменные окружения в Render (или .env локально):
// - MP_ACCESS_TOKEN                 (строка, Prod access token Mercado Pago)
// - PUBLIC_BASE_URL                 (например: https://pho-backend.onrender.com)
// - SHEETS_SPREADSHEET_ID           (ID Google-таблицы)
// - GOOGLE_SERVICE_ACCOUNT_JSON     (полный JSON ключ сервис-аккаунта)
// - SUCCESS_URL (опционально)       (URL страницы «Спасибо», по умолчанию: https://phorestaurante.tilda.ws/page93974626.html)

const {
  MP_ACCESS_TOKEN,
  PUBLIC_BASE_URL,
  SHEETS_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SUCCESS_URL
} = process.env;

if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN is required');
if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required');
if (!SHEETS_SPREADSHEET_ID) throw new Error('SHEETS_SPREADSHEET_ID is required');
if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');

const TILDA_SUCCESS = SUCCESS_URL || 'https://phorestaurante.tilda.ws/page93974626.html';

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// Разрешим запросы с вашего домена Tilda и локальные тесты
const allowedOrigins = new Set([
  'http://phorestaurante.tilda.ws',
  'https://phorestaurante.tilda.ws',
  'http://tilda.ws',
  'https://tilda.ws',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    try {
      const url = new URL(origin);
      if (allowedOrigins.has(url.origin)) return cb(null, true);
    } catch (_) {}
    // Мягко разрешим, если хотите — ужесточите
    return cb(null, true);
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets client
// ─────────────────────────────────────────────────────────────────────────────
const googleAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheetsClient = google.sheets({ version: 'v4', auth: googleAuth });

const SHEET_TAB = 'Orders'; // создайте/используйте лист с таким именем

async function ensureHeaderRow() {
  // Добавим заголовки, если лист пуст
  const get = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: `${SHEET_TAB}!A1:Z1`
  }).catch(() => null);

  const values = get?.data?.values;
  if (!values || values.length === 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      range: `${SHEET_TAB}!A1:N1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'timestamp_iso',
          'order_id',
          'mp_payment_id',
          'status',
          'amount',
          'currency',
          'buyer_name',
          'buyer_phone',
          'buyer_email',
          'delivery_mode',
          'address',
          'note',
          'items_json',
          'raw_metadata_json'
        ]]
      }
    });
  }
}

async function wasPaymentLogged(paymentId) {
  // Простой поиск дубликатов по колонке C (mp_payment_id)
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: `${SHEET_TAB}!C:C`
  }).catch(() => null);
  const rows = res?.data?.values || [];
  return rows.some(r => String(r[0]) === String(paymentId));
}

async function appendOrderRow(rowArray) {
  await ensureHeaderRow();
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:Z`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function newOrderId() {
  // Простой внутренний orderId
  return `pho-${Date.now()}`;
}

function mapCartToMpItems(cart, currency = 'ARS') {
  // ожидаем cart = [{ id?, title, description?, quantity, unit_price }]
  if (!Array.isArray(cart)) return [];
  return cart.map((p, idx) => ({
    id: String(p.id || idx + 1),
    title: String(p.title || 'Item'),
    description: p.description ? String(p.description) : undefined,
    quantity: Number(p.quantity || 1),
    unit_price: Number(p.unit_price || 0),
    currency_id: currency
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// 1) Создание preference
app.post('/api/mp/create-preference', async (req, res) => {
  try {
    const { cart, buyer, currency = 'ARS', statement_descriptor = 'PHO IS IT' } = req.body || {};
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ ok: false, error: 'EMPTY_CART' });
    }

    const orderId = newOrderId();
    const items = mapCartToMpItems(cart, currency);

    const payload = {
      items,
      back_urls: {
        success: TILDA_SUCCESS,
        failure: TILDA_SUCCESS, // можно выделить отдельно страницы, если нужно
        pending: TILDA_SUCCESS
      },
      auto_return: 'approved',
      external_reference: orderId,
      // пойдёт напрямую в платёж и вернётся на confirm
      metadata: {
        orderId,
        buyer: buyer || {},
        cart,
        source: 'tilda-st100'
      },
      statement_descriptor
      // notification_url: (не используем — без вебхуков)
    };

    const mp = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      payload,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const init_point = mp?.data?.init_point;
    if (!init_point) {
      return res.status(502).json({ ok: false, error: 'MP_NO_INIT_POINT', mp: mp?.data });
    }

    return res.json({ ok: true, orderId, init_point });
  } catch (err) {
    console.error('create-preference error:', err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      details: err?.response?.data || err.message
    });
  }
});

// 2) Подтверждение оплаты и запись в Google Sheets
app.get('/api/mp/confirm', async (req, res) => {
  try {
    const paymentId = req.query.payment_id || req.query.paymentId || req.query.id;
    if (!paymentId) return res.status(400).json({ ok: false, error: 'MISSING_payment_id' });

    // Получаем платёж из MP
    const mp = await axios.get(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const p = mp?.data;
    if (!p || !p.id) {
      return res.status(404).json({ ok: false, error: 'PAYMENT_NOT_FOUND' });
    }

    // Проверка статуса
    const status = p.status;                 // 'approved', 'rejected', etc.
    const status_detail = p.status_detail;   // детализация
    const approved = status === 'approved';

    // Берём metadata, external_reference, сумму и т.д.
    const metadata = p.metadata || {};
    const external_reference = p.external_reference || metadata.orderId || null;
    const amount = p.transaction_amount || 0;
    const currency = p.currency_id || 'ARS';
    const dateApproved = p.date_approved || null;

    // Если платёж не approved — просто сообщим состояние
    if (!approved) {
      return res.json({
        ok: true,
        approved: false,
        status,
        status_detail,
        payment_id: p.id,
        orderId: external_reference,
        amount,
        currency
      });
    }

    // Защита от дублей: если уже логировали этот payment_id — не добавляем ещё раз
    const already = await wasPaymentLogged(p.id);
    if (!already) {
      const buyer = (metadata && metadata.buyer) || {};
      const cart = (metadata && metadata.cart) || [];

      const deliveryMode = buyer.deliveryMode || buyer.delivery || '';
      const address = buyer.address || '';
      const note = buyer.note || buyer.comment || '';

      const nowIso = new Date().toISOString();

      const row = [
        nowIso,
        external_reference || '',
        String(p.id),
        status,
        amount,
        currency,
        buyer.name || '',
        buyer.phone || '',
        buyer.email || '',
        deliveryMode || '',
        address || '',
        note || '',
        JSON.stringify(cart),
        JSON.stringify(metadata)
      ];

      await appendOrderRow(row);
    }

    // Ответ для фронтенда «Спасибо»
    return res.json({
      ok: true,
      approved: true,
      payment_id: p.id,
      status,
      status_detail,
      orderId: external_reference,
      amount,
      currency,
      dateApproved,
      buyer: (metadata && metadata.buyer) || {},
      cart: (metadata && metadata.cart) || []
    });

  } catch (err) {
    console.error('confirm error:', err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      details: err?.response?.data || err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`pho-backend listening on :${PORT}`);
  console.log(`Base URL: ${PUBLIC_BASE_URL}`);
});

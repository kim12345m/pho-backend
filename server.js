'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const { google } = require('googleapis');

// -------------------- ENV --------------------
const {
  PORT = 10000,
  MP_ACCESS_TOKEN,                // из Mercado Pago (Access Token)
  PUBLIC_BASE_URL,                // https://pho-backend.onrender.com
  TILDA_NOTIFICATION_URL,         // https://forms.tildacdn.com/payment/notify/?projectid=17652556  (или твой custom-URL из скрина)
  TILDA_SUCCESS_FIELD = 'status', // 'status'
  TILDA_SUCCESS_VALUE = 'approved', // 'approved'
  GOOGLE_SERVICE_ACCOUNT_JSON,    // весь JSON сервис-аккаунта в 1 переменной
  GOOGLE_SHEET_ID,                // ID таблицы (из URL Google Sheets)
  GOOGLE_SHEET_TAB_NAME = 'Pho'   // имя листа ('Pho')
} = process.env;

// -------------------- BASIC APP --------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan('tiny'));

// простая проверка здоровья
app.get('/health', (_req, res) => res.status(200).send('OK'));

// -------------------- HELPERS --------------------
/** Универсальный парсер чисел с точками/запятыми/разделителями тысяч */
function parseMoney(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const s = String(value).trim();
  // убираем пробелы, символы валюты, нецифры кроме . и ,
  const cleaned = s.replace(/[^\d.,-]/g, '');
  // если есть и точки и запятой – считаем, что точка это разделитель тысяч
  const normalized = cleaned.indexOf('.') > -1 && cleaned.indexOf(',') > -1
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Безопасный JSON.parse */
function safeJsonParse(maybeJson) {
  if (maybeJson == null) return null;
  if (Array.isArray(maybeJson) || typeof maybeJson === 'object') return maybeJson;
  try { return JSON.parse(String(maybeJson)); } catch { return null; }
}

/** Достаём ID платёжа из разных форматов webhook Mercado Pago */
function extractPaymentId(req) {
  if (req.query && req.query.id) return req.query.id;
  const body = req.body || {};
  if (body.data && body.data.id) return body.data.id;
  if (body.id) return body.id;
  return null;
}

/** Собираем строку для записи в Google Sheets */
function toRowForSheet({
  timestamp,
  order_id,
  payment_id,
  status,
  customer_email,
  customer_phone,
  customer_name,
  delivery_zone,
  delivery_price,
  items_json,
  total_amount
}) {
  return [
    timestamp,
    order_id || '',
    payment_id || '',
    status || '',
    customer_email || '',
    customer_phone || '',
    customer_name || '',
    delivery_zone || '',
    delivery_price != null ? String(delivery_price) : '',
    items_json || '',
    total_amount != null ? String(total_amount) : ''
  ];
}

// -------------------- GOOGLE SHEETS --------------------
let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  if (!GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set');

  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheetsClient = google.sheets({ version: 'v4', auth: jwt });
  return sheetsClient;
}

async function appendToSheet(rowArray) {
  const sheets = getSheetsClient();
  const range = `${GOOGLE_SHEET_TAB_NAME}!A:Z`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] }
  });
}

// -------------------- TILDA NOTIFY --------------------
/**
 * Отправляем уведомление в Tilda, чтобы заказ считался оплаченным.
 * Важные поля: orderid, payment_id, status(=approved) и signature (тот же, что пришёл от Tilda).
 * Мы передадим минимум — Tilda этого достаточно.
 */
async function notifyTilda({ orderid, payment_id, signature, amount, currency }) {
  if (!TILDA_NOTIFICATION_URL) return;
  const payload = new URLSearchParams();
  if (orderid) payload.append('orderid', orderid);
  if (payment_id) payload.append('payment_id', String(payment_id));
  if (TILDA_SUCCESS_FIELD && TILDA_SUCCESS_VALUE) {
    payload.append(TILDA_SUCCESS_FIELD, TILDA_SUCCESS_VALUE);
  }
  if (signature) payload.append('signature', signature);
  if (amount != null) payload.append('amount', String(amount));
  if (currency) payload.append('currency', currency);

  try {
    await axios.post(TILDA_NOTIFICATION_URL, payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
  } catch (e) {
    // логируем, но не валим обработку
    console.error('Tilda notify error:', e.response?.status, e.response?.data || e.message);
  }
}

// -------------------- CHECKOUT FROM TILDA --------------------
/**
 * Tilda шлёт сюда POST при нажатии Checkout.
 * Мы:
 * 1) читаем заказ (products, amount и т.д.)
 * 2) создаём preference в Mercado Pago
 * 3) отдаём Tilda ссылку на оплату (init_point)
 *
 * В ответ возвращаем JSON { url: ... } — Tilda это понимает.
 */
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN is not set');
    if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is not set');

    const b = req.body || {};
    // стандартные поля из настроек Tilda
    const orderid = b.orderid || b.order_id || '';
    const description = b.description || 'Pedido';
    const currency = (b.currency || 'ARS').toUpperCase();
    const amount = parseMoney(b.amount);
    const email = b.email || b.customer_email || '';
    const phone = b.phone || b.customer_phone || '';
    const name = b.name || b.customer_name || '';
    const signature = b.signature || ''; // важно: вернём его в notify
    // возможные пользовательские поля (если ты их добавишь в Tilda)
    const delivery_zone = b.delivery_zone || '';
    const delivery_price = parseMoney(b.delivery_price);

    // товары
    const productsRaw = safeJsonParse(b.products);
    const items = Array.isArray(productsRaw) && productsRaw.length > 0
      ? productsRaw.map(p => ({
          title: p.name || 'Item',
          quantity: Number(p.quantity || 1),
          currency_id: currency,
          unit_price: parseMoney(p.price)
        }))
      : [{
          title: description,
          quantity: 1,
          currency_id: currency,
          unit_price: amount
        }];

    // включим доставку как отдельную позицию, если Tilda её не добавила, но ты передал delivery_price
    if (delivery_zone && delivery_price > 0) {
      items.push({
        title: `Delivery – ${delivery_zone}`,
        quantity: 1,
        currency_id: currency,
        unit_price: delivery_price
      });
    }

    // Строка external_reference: кладём туда orderid и signature,
    // чтобы на webhook точно вернуть их в Tilda
    const external_reference = [orderid, signature].join('|');

    // создаём Checkout Preference
    const pref = {
      items,
      payer: {
        email,
        name
      },
      back_urls: {
        success: `${PUBLIC_BASE_URL}/mp/return`,
        pending: `${PUBLIC_BASE_URL}/mp/return`,
        failure: `${PUBLIC_BASE_URL}/mp/return`
      },
      auto_return: 'approved',
      binary_mode: true,
      notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
      external_reference
      // (по желанию можно добавить statement_descriptor)
    };

    const mp = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      pref,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    // Возвращаем Tilda ссылку на оплату
    const payUrl = mp.data && (mp.data.init_point || mp.data.sandbox_init_point);
    if (!payUrl) throw new Error('Mercado Pago did not return init_point');

    res.status(200).json({ url: payUrl });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'checkout_failed', message: err.message });
  }
});

// -------------------- MP RETURN (для человека) --------------------
app.get('/mp/return', (req, res) => {
  // простая «заглушка» страницы возврата
  res
    .status(200)
    .send('<html><body><h3>Gracias. Si el pago fue aprobado, lo registraremos enseguida.</h3></body></html>');
});

// -------------------- MP WEBHOOK --------------------
/**
 * Mercado Pago шлёт сюда уведомления.
 * Мы:
 * 1) вытягиваем payment_id и запрашиваем детали оплаты
 * 2) если статус approved — шлём notify в Tilda и пишем строку в Google Sheets
 */
app.post('/mp/webhook', async (req, res) => {
  const paymentId = extractPaymentId(req);
  if (!paymentId) {
    // МР иногда шлёт нотификации «без id»; отвечаем 200, чтобы не спамило ретраями
    return res.status(200).send('noop');
  }

  try {
    const { data: payment } = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const status = payment.status; // expected 'approved'
    const transaction_amount = payment.transaction_amount;
    const currency = payment.currency_id || 'ARS';
    const extRef = payment.external_reference || '';
    const [orderid, signature] = extRef.split('|');

    const payer = payment.payer || {};
    const customer_email = payer.email || '';
    const customer_name = [payer.first_name || '', payer.last_name || ''].join(' ').trim();
    const customer_phone = payer.phone && payer.phone.number ? String(payer.phone.number) : '';

    // Позиции заказа (доступны в additional_info.items)
    const addInfo = payment.additional_info || {};
    const addItems = Array.isArray(addInfo.items) ? addInfo.items : [];
    const items_json = JSON.stringify(addItems);

    // Попробуем вычислить доставку из позиций
    let delivery_zone = '';
    let delivery_price = 0;
    for (const it of addItems) {
      const t = (it.title || '').toLowerCase();
      if (t.includes('delivery') || t.includes('envío') || t.includes('envio')) {
        delivery_zone = it.title;
        delivery_price = parseMoney(it.unit_price);
        break;
      }
    }

    // Уведомим Tilda (статус + payment_id + тот же signature)
    if (status && status.toLowerCase() === TILDA_SUCCESS_VALUE.toLowerCase()) {
      await notifyTilda({
        orderid,
        payment_id: paymentId,
        signature,
        amount: transaction_amount,
        currency
      });
    }

    // Запишем строку в Google Sheets
    try {
      const row = toRowForSheet({
        timestamp: new Date().toISOString(),
        order_id: orderid,
        payment_id: String(paymentId),
        status,
        customer_email,
        customer_phone,
        customer_name,
        delivery_zone,
        delivery_price,
        items_json,
        total_amount: transaction_amount
      });
      await appendToSheet(row);
    } catch (sheetErr) {
      console.error('Sheets append error:', sheetErr.message);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.response?.status, err.response?.data || err.message);
    // всё равно 200 — чтобы Mercado Pago не слал ретраи бесконечно
    res.status(200).send('OK');
  }
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

const express = require('express');
const axios = require('axios').default;
const { google } = require('googleapis');

const {
  PUBLIC_BASE_URL = 'http://localhost:3000',
  MP_ACCESS_TOKEN,
  CURRENCY = 'ARS',
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SHEET_ID,
  GOOGLE_SHEET_NAME = 'Pho',
  TILDA_NOTIFICATION_URL,       // URL в Tilda, куда наш сервер отправляет уведомление
  TILDA_SUCCESS_FIELD = 'status',
  TILDA_SUCCESS_VALUE = 'approved',
  TILDA_SECRET,                 // если нужно отправлять/проверять секрет
  MP_WEBHOOK_SECRET,           // если включите подпись вебхука
} = process.env;

if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN is required');
if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
if (!GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID is required');

const app = express();

// Tilda отправляет форму как application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Google Sheets helpers ----------
const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

function sheetsClient() {
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function appendOrderRow(orderRow) {
  const sheets = sheetsClient();
  const values = [[
    new Date().toISOString(),
    orderRow.order_id ?? '',
    orderRow.payment_id ?? '',
    orderRow.status ?? '',
    orderRow.customer_email ?? '',
    orderRow.customer_phone ?? '',
    orderRow.customer_name ?? '',
    orderRow.delivery_zone ?? '',
    orderRow.delivery_price ?? '',
    JSON.stringify(orderRow.items || []),
    orderRow.total_amount ?? ''
  ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_NAME}!A:K`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
}

async function updateRowByOrderId(order_id, patch) {
  // Для простоты: повторно пишем строку (append) как «журнал».
  // Если нужно именно «обновлять» существующую — добавьте поиск/scan листа.
  await appendOrderRow({ order_id, ...patch });
}

// ---------- Tilda items parser ----------
function parseItemsFromTilda(body) {
  const items = [];

  // Варианты массивов: name[], quantity[], price[] или name[0], ...
  const keys = Object.keys(body);

  // name[0] вариант
  const idxs = [...new Set(
    keys.map(k => {
      const m = k.match(/^name\[(\d+)\]$/);
      return m ? Number(m[1]) : null;
    }).filter(v => v !== null)
  )];

  if (idxs.length) {
    idxs.sort((a,b)=>a-b).forEach(i => {
      const title = body[`name[${i}]`];
      const qty = Number(body[`quantity[${i}]`] ?? 1);
      const price = Number(String(body[`price[${i}]`] ?? '0').replace(',', '.'));
      if (title && qty > 0) {
        items.push({ title, quantity: qty, currency_id: CURRENCY, unit_price: price });
      }
    });
    return items;
  }

  // name[] как массив
  const names = body['name[]'] || body.name;
  const quantities = body['quantity[]'] || body.quantity;
  const prices = body['price[]'] || body.price;

  if (Array.isArray(names)) {
    names.forEach((title, i) => {
      const qty = Number((quantities && quantities[i]) ?? 1);
      const price = Number(String((prices && prices[i]) ?? '0').replace(',', '.'));
      if (title && qty > 0) {
        items.push({ title, quantity: qty, currency_id: CURRENCY, unit_price: price });
      }
    });
  } else if (names) {
    const qty = Number(quantities ?? 1);
    const price = Number(String(prices ?? '0').replace(',', '.'));
    items.push({ title: names, quantity: qty, currency_id: CURRENCY, unit_price: price });
  }

  return items;
}

// ---------- Mercado Pago helpers ----------
async function createPreference({ order_id, items, payer, delivery_price }) {
  const preference = {
    items: items.map(it => ({
      title: it.title,
      quantity: it.quantity,
      unit_price: Number(it.unit_price),
      currency_id: CURRENCY
    })),
    payer,                                   // { name, email, phone: { area_code, number } }
    external_reference: String(order_id),    // чтобы связать оплату с заказом
    back_urls: {
      success: 'https://phorestaurante.tilda.ws/page93974626.html',
      failure: 'https://phorestaurante.tilda.ws/page93972756.html',
      pending: 'https://phorestaurante.tilda.ws/page93972756.html'
    },
    auto_return: 'approved',
    notification_url: `${PUBLIC_BASE_URL}/mp/webhook`
  };

  // Если есть доставка — можно добавить как shipping cost
  if (delivery_price) {
    preference.shipments = { cost: Number(delivery_price), mode: 'not_specified' };
  }

  const { data } = await axios.post(
    'https://api.mercadopago.com/checkout/preferences',
    preference,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return data; // содержит init_point и т. д.
}

async function fetchPayment(paymentId) {
  const { data } = await axios.get(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
  );
  return data;
}

// ---------- Уведомление в Tilda ----------
async function notifyTilda({ payment_id, status }) {
  if (!TILDA_NOTIFICATION_URL) return { sent: false, reason: 'TILDA_NOTIFICATION_URL not set' };

  // Tilda ожидает form-url-encoded и plaintext ответ «OK».
  const params = new URLSearchParams();
  params.set('payment_id', String(payment_id));
  params.set(TILDA_SUCCESS_FIELD, status);
  if (TILDA_SECRET) params.set('secret', TILDA_SECRET);

  const resp = await axios.post(
    TILDA_NOTIFICATION_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true }
  );

  const ok = typeof resp.data === 'string'
    ? resp.data.trim().toUpperCase() === 'OK'
    : false;

  return { sent: true, ok, statusCode: resp.status, body: resp.data };
}

// ---------- Endpoints ----------

// 1) Tilda -> checkout (создаем preference и редиректим покупателя)
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    const body = req.body || {};
    const order_id = body.order_id || body.orderid || body.order || Date.now();
    const customer = {
      name: body.customer_name || body.name || '',
      email: body.customer_email || body.email || '',
      phone: body.customer_phone ? { number: String(body.customer_phone) } : undefined
    };

    const delivery_zone = body.delivery_zone || '';
    const delivery_price = body.delivery_price ? Number(String(body.delivery_price).replace(',', '.')) : 0;

    const items = parseItemsFromTilda(body);
    const total_amount = items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity), 0) + (delivery_price || 0);

    // Журналируем заказ со статусом pending
    await appendOrderRow({
      order_id, status: 'pending',
      customer_email: customer.email,
      customer_phone: body.customer_phone || '',
      customer_name: customer.name,
      delivery_zone,
      delivery_price,
      items,
      total_amount
    });

    const pref = await createPreference({
      order_id, items,
      payer: customer,
      delivery_price
    });

    // Tilda корректно обработает 303 See Other -> init_point
    return res.redirect(303, pref.init_point);
  } catch (err) {
    console.error('Checkout error:', err?.response?.data || err.message);
    return res.status(500).send('Checkout ERROR');
  }
});

// 2) MP -> webhook (фиксируем статус и уведомляем Tilda)
app.post('/mp/webhook', async (req, res) => {
  try {
    // (Опционально) проверка подписи MP, если задан MP_WEBHOOK_SECRET
    // Документация MP шлет заголовки x-signature/x-request-id; можно добавить валидацию здесь.

    const { type, action, data } = req.body || {};
    if (type === 'payment' && data?.id) {
      const payment = await fetchPayment(data.id);
      const status = payment.status;                  // approved / pending / rejected / cancelled …
      const order_id = payment.external_reference;

      // Журналируем
      await updateRowByOrderId(order_id, { payment_id: payment.id, status });

      // Если оплата подтверждена — сообщаем в Tilda
      if (status === TILDA_SUCCESS_VALUE) {
        const r = await notifyTilda({ payment_id: payment.id, status });
        console.log('Notify Tilda:', r);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err?.response?.data || err.message);
    return res.status(200).send('OK'); // отвечаем 200, чтобы MP не ретраил бесконечно
  }
});

// 3) Простой healthcheck
app.get('/health', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

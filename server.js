// server.js
const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const SHEETS_TAB_NAME = process.env.SHEETS_TAB_NAME || 'Sheet1';

// --- Helpers: Google Sheets ---
async function getSheetsClient() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json || !SHEETS_SPREADSHEET_ID) {
    throw new Error('Sheets env vars missing');
  }
  const key = JSON.parse(json);
  if (!key.client_email || !key.private_key) {
    throw new Error('Bad service account key');
  }
  // Ключ часто приходит с \\n — заменяем на реальные переводы строк
  key.private_key = key.private_key.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function appendRowToSheet(row) {
  const sheets = await getSheetsClient();
  const range = `${SHEETS_TAB_NAME}!A:Z`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

// --- Helpers: нормализация корзины из Tilda ---
function normalizeCart(body) {
  // Tilda/формы часто передают разные имена полей. Поддержим распространённые.
  let orderId =
    body.orderId || body.order_id || body.tildaorderid || body.order || '';
  let total = parseFloat(
    body.total || body.amount || body.sum || body.price || body.orderprice || 0
  );
  if (Number.isNaN(total)) total = 0;

  // Список товаров может прийти массивом, либо JSON-строкой
  let items = [];
  const possible = body.items || body.products || body.cart || body.cart_json;
  if (possible) {
    try {
      const parsed = Array.isArray(possible) ? possible : JSON.parse(possible);
      items = parsed.map((it) => ({
        title: it.title || it.name || 'Item',
        unit_price: Number(it.price || it.unit_price || 0),
        quantity: Number(it.quantity || 1),
        currency_id: it.currency_id || 'ARS'
      }));
      if (!total) {
        total = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
      }
    } catch (_) {
      // если не распарсилось — не страшно, ниже сделаем единый товар на всю сумму
    }
  }

  const customer = {
    email: body.email || body.client_email || body.customer_email || body.Mail || undefined,
    name: body.name || body.client_name || body.customer_name || undefined,
    phone: body.phone || body.client_phone || body.customer_phone || undefined
  };

  // округлим до копеек/сентиavos
  total = Math.round(total * 100) / 100;
  return { total, items, orderId, customer };
}

// --- Health ---
app.get('/', (_req, res) => res.send('OK'));

// --- Создание чекаута Mercado Pago и редирект ---
app.post('/mp/create-checkout', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).send('MP_ACCESS_TOKEN is not set');
    }
    const { total, items, orderId, customer } = normalizeCart(req.body);
    if (!total || total <= 0) {
      return res.status(400).send('Bad total');
    }

    const preference = {
      items: items.length
        ? items
        : [
            {
              title: `Order ${orderId || ''}`,
              unit_price: total,
              quantity: 1,
              currency_id: 'ARS'
            }
          ],
      back_urls: {
        success: `${PUBLIC_BASE_URL}/mp/return?status=success`,
        failure: `${PUBLIC_BASE_URL}/mp/return?status=failure`,
        pending: `${PUBLIC_BASE_URL}/mp/return?status=pending`
      },
      auto_return: 'approved',
      notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
      external_reference: orderId || undefined,
      payer: customer?.email ? { email: customer.email } : undefined,
      metadata: {
        orderId: orderId || '',
        items
      }
    };

    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preference)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('MP preference error', data);
      return res.status(502).send('Mercado Pago error');
    }

    const url = data.init_point || data.sandbox_init_point;
    // Возвращаем 302 редирект — браузер сразу уйдёт на Mercado Pago
    return res.redirect(302, url);
  } catch (e) {
    console.error('create-checkout error', e);
    return res.status(500).send('Internal error');
  }
});

// --- Webhook от Mercado Pago ---
app.post('/mp/webhook', async (req, res) => {
  // Отвечаем сразу, чтобы MP не ретрайл.
  res.status(200).send('OK');
  try {
    const { type, action, data } = req.body || {};
    const isPayment =
      type === 'payment' || (typeof action === 'string' && action.startsWith('payment'));
    if (isPayment && data?.id) {
      await handlePayment(String(data.id));
    }
  } catch (e) {
    console.error('webhook error', e);
  }
});

async function handlePayment(paymentId) {
  try {
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const payment = await resp.json();
    if (!resp.ok) {
      console.error('MP payment fetch error:', payment);
      return;
    }
    if (payment.status === 'approved') {
      const md = payment.metadata || {};
      const items = md.items || payment.additional_info?.items || [];
      const total = payment.transaction_amount;
      const email =
        payment.payer?.email || payment.additional_info?.payer?.email || '';

      const row = [
        new Date().toISOString(),                 // дата/время
        String(payment.id),                       // id платежа
        md.orderId || payment.external_reference || '', // orderId
        email,                                    // email покупателя
        total,                                    // сумма
        payment.currency_id || 'ARS',             // валюта
        JSON.stringify(items)                     // состав заказа
      ];

      try {
        await appendRowToSheet(row);
      } catch (err) {
        console.error('Sheets append error', err);
      }
    }
  } catch (e) {
    console.error('handlePayment error', e);
  }
}

// --- Возврат со страницы MP (просто инфо-страница) ---
app.get('/mp/return', (req, res) => {
  const { status } = req.query;
  const message =
    status === 'success'
      ? 'Pago aprobado. ¡Gracias!'
      : status === 'pending'
      ? 'Pago pendiente.'
      : 'Pago cancelado o rechazado.';
  res.send(
    `<html><meta charset="utf-8"><body><h2>${message}</h2><p><a href="/">Volver</a></p></body></html>`
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));

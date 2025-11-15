// server.js
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const { google } = require('googleapis');

// -----------------------------
// Google Sheets: запись заказа
// -----------------------------
async function appendToSheet(order) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Твой Google Sheet ID и вкладка
    const spreadsheetId = '1A0Q3x9kS8T7lgzT_BulWaM1cT1DeGzZn0F7zAGc-coU';
    const sheetName = 'Pho';

    const timestamp = new Date().toISOString();

    const row = [
      timestamp,
      order.order_id,
      order.payment_id,
      order.status,
      order.customer_email,
      order.customer_phone,
      order.customer_name,
      order.delivery_zone,
      order.delivery_price,
      JSON.stringify(order.items),
      order.total_amount
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    console.log('Google Sheets: запись добавлена.');
  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}

const app = express();

// логирование и парсинг
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// healthcheck
app.get('/health', (req, res) => res.status(200).send('OK'));


// ---------------------------------------------------
// 1) Точка оплаты от Тильды → создаёт MercadoPago ссылка
// ---------------------------------------------------
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_TOKEN) {
      console.error('MP_ACCESS_TOKEN не задан');
      return res.status(500).send('Mercado Pago token is missing');
    }

    const {
      orderid, order_id, description,
      amount, email, customer_email,
      delivery_price, shipping_price,
      products
    } = req.body;

    const externalRef = String(order_id || orderid || Date.now());

    // Разбор списка товаров
    const parseProducts = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        try { return JSON.parse(val); } catch (_) {}
        try { return JSON.parse(Buffer.from(val, 'base64').toString('utf8')); } catch (_) {}
      }
      return [];
    };

    const itemsIn = parseProducts(products);

    let items = itemsIn.map((p, i) => ({
      title: p.name || `Item ${i + 1}`,
      quantity: Number(p.quantity) || 1,
      currency_id: 'ARS',
      unit_price: Number(p.price) || 0
    }));

    // Доставка как отдельная позиция
    const ship = Number(delivery_price || shipping_price);
    if (!Number.isNaN(ship) && ship > 0) {
      items.push({
        title: 'Delivery',
        quantity: 1,
        currency_id: 'ARS',
        unit_price: ship
      });
    }

    // Если товаров нет — fallback
    if (items.length === 0) {
      const total = Number(amount);
      if (Number.isNaN(total) || total <= 0) {
        return res.status(400).send('Bad order: no items and no amount');
      }
      items = [{
        title: description || `Order ${externalRef}`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: total
      }];
    }

    // URL'ы
    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    const successUrl = process.env.SUCCESS_URL || 'https://phorestaurante.tilda.ws/thank-you';
    const failureUrl = process.env.FAIL_URL || successUrl;
    const pendingUrl = process.env.PENDING_URL || successUrl;

    // Preference body
    const prefBody = {
      items,
      payer: {
        email: customer_email || email || undefined
      },
      back_urls: {
        success: successUrl,
        failure: failureUrl,
        pending: pendingUrl
      },
      auto_return: 'approved',
      external_reference: externalRef,
      notification_url: baseUrl ? `${baseUrl}/mp/webhook` : undefined,
      statement_descriptor: 'PHO RESTO'
    };

    const mpResp = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      prefBody,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );

    const initPoint = mpResp?.data?.init_point;
    if (!initPoint) {
      console.error('init_point отсутствует', mpResp?.data);
      return res.status(502).send('Mercado Pago: init_point missing');
    }

    return res.redirect(302, initPoint);

  } catch (err) {
    console.error('checkout error:', err?.response?.data || err.message);
    return res.status(500).send('Checkout error');
  }
});


// ---------------------------------------------------
// 2) Вебхуки Mercado Pago → подтверждение оплаты → Sheets
// ---------------------------------------------------
app.get('/mp/webhook', (req, res) => res.status(200).send('OK'));

app.post('/mp/w

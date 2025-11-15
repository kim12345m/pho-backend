'use strict';

// server.js
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const crypto = require('crypto');
const { google } = require('googleapis');

// ---------- Google Sheets (опционально: логировать оплату) ----------
async function appendToSheet(order) {
  try {
    const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
      : null;

    if (!creds) return;

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = '1A0Q3x9kS8T7lgzT_BulWaM1cT1DeGzZn0F7zAGc-coU';
    const sheetName = 'Pho';
    const timestamp = new Date().toISOString();

    const row = [
      timestamp,
      order.order_id || '',
      order.payment_id || '',
      order.status || '',
      order.customer_email || '',
      order.customer_phone || '',
      order.customer_name || '',
      order.delivery_zone || '',
      order.delivery_price || '',
      JSON.stringify(order.items || []),
      order.total_amount || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}

// ---------- helpers ----------
function parseProducts(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch (_) {}
    try { return JSON.parse(Buffer.from(val, 'base64').toString('utf8')); } catch (_) {}
  }
  return [];
}

// Подпись для Tilda: MD5 от конкатенации значений всех полей (кроме signature) в алфавитном порядке ключей.
// Если включишь HMAC в интерфейсе Tilda — раскомментируй ветку с HMAC и включи переменную TILDA_USE_HMAC=1.
function tildaSignature(payload) {
  const keys = Object.keys(payload)
    .filter(k => k !== 'signature')
    .sort();

  const base = keys.map(k => String(payload[k] ?? '')).join('');

  if (process.env.TILDA_USE_HMAC === '1') {
    return crypto.createHmac('md5', process.env.TILDA_SECRET || '')
      .update(base).digest('hex');
  }
  return crypto.createHash('md5').update(base).digest('hex');
}

async function notifyTilda(payload) {
  const url = process.env.TILDA_NOTIFICATION_URL; // вида https://forms.tildaapi.com/payment/custom/psXXXX
  if (!url) {
    console.warn('TILDA_NOTIFICATION_URL не задан — уведомление в Tilda пропущено');
    return;
  }

  const data = { ...payload };
  data.signature = tildaSignature(data);

  const body = new URLSearchParams(data).toString();

  try {
    const resp = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    console.log('Tilda notify:', resp.status, String(resp.data).slice(0, 200));
  } catch (e) {
    console.error('Tilda notify error:', e?.response?.status, e?.response?.data || e.message);
  }
}

// ---------- app ----------
const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (_, res) => res.status(200).send('OK'));

// === 1) Старт оплаты с Tilda ===
// Tilda → POST /api/tilda/checkout
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_TOKEN) return res.status(500).send('Mercado Pago token is missing');

    const {
      orderid,
      order_id,
      description,
      amount,
      email,
      customer_email,
      delivery_price,
      shipping_price,
      products
    } = req.body;

    const externalRef = String(order_id || orderid || Date.now());

    const itemsIn = parseProducts(products);
    let items = itemsIn.map((p, i) => ({
      title: p.name || `Item ${i + 1}`,
      quantity: Number(p.quantity) || 1,
      currency_id: 'ARS',
      unit_price: Number(p.price) || 0
    }));

    const ship = Number(delivery_price || shipping_price);
    if (!Number.isNaN(ship) && ship > 0) {
      items.push({ title: 'Delivery', quantity: 1, currency_id: 'ARS', unit_price: ship });
    }

    if (items.length === 0) {
      const total = Number(amount);
      if (Number.isNaN(total) || total <= 0) {
        return res.status(400).send('Bad order: no items and no amount');
      }
      items = [{ title: description || `Order ${externalRef}`, quantity: 1, currency_id: 'ARS', unit_price: total }];
    }

    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    const successUrl =
      process.env.SUCCESS_URL ||
      process.env.TILDA_THANK_YOU_URL ||
      'https://phorestaurante.tilda.ws/thank-you';

    const failureUrl =
      process.env.FAIL_URL ||
      process.env.TILDA_FAIL_URL ||
      'http://phorestaurante.tilda.ws';

    const pendingUrl =
      process.env.PENDING_URL ||
      process.env.TILDA_PENDING_URL ||
      failureUrl;

    const prefBody = {
      items,
      payer: { email: customer_email || email || undefined },
      back_urls: { success: successUrl, failure: failureUrl, pending: pendingUrl },
      auto_return: 'approved',
      external_reference: externalRef,
      notification_url: baseUrl ? `${baseUrl}/mp/webhook` : undefined,
      statement_descriptor: 'PHO RESTO'
      // при необходимости можно включить binary_mode: true
    };

    const mpResp = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      prefBody,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );

    const initPoint = mpResp?.data?.init_point;
    if (!initPoint) return res.status(502).send('Mercado Pago: init_point missing');

    return res.redirect(302, initPoint);
  } catch (err) {
    console.error('checkout error:', err?.response?.data || err.message);
    return res.status(500).send('Checkout error');
  }
});

// === 2) Вебхуки Mercado Pago ===
// В кабинете MP: Webhooks → URL = https://<PUBLIC_BASE_URL>/mp/webhook
app.get('/mp/webhook', (_, res) => res.status(200).send('OK'));

app.post('/mp/webhook', async (req, res) => {
  try {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    const event = req.body || {};
    console.log('MP webhook:', JSON.stringify(event));

    const isPaymentEvent =
      event?.type === 'payment' ||
      req.query?.type === 'payment' ||
      req.query?.topic === 'payment';

    const paymentId = event?.data?.id || req.query?.id;

    if (isPaymentEvent && paymentId) {
      try {
        const { data: p } = await axios.get(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
        );

        console.log(`Payment ${p.id}: status=${p.status} external_reference=${p.external_reference}`);

        // уведомляем Tilda (она сама пометит заказ оплаченным при status === 'approved')
        await notifyTilda({
          orderid: String(p.external_reference || ''),     // должен совпадать с orderid, который Tilda отправляла на /checkout
          payment_id: String(p.id),
          status: String(p.status || 'unknown'),
          amount: p.transaction_amount,
          currency: p.currency_id || 'ARS',
          email: p.payer?.email || ''
        });

        // опционально логируем в Google Sheets
        await appendToSheet({
          order_id: p.external_reference,
          payment_id: p.id,
          status: p.status,
          customer_email: p.payer?.email || '',
          items: [],
          total_amount: p.transaction_amount
        });
      } catch (e) {
        console.error('fetch payment error:', e?.response?.data || e.message);
      }
    }

    // всегда 200 — иначе MP будет ретраить
    res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err.message);
    res.sendStatus(200);
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on', PORT));

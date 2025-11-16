'use strict';

// server.js
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const crypto = require('crypto');
const { google } = require('googleapis');

// === [НОВОЕ] Опциональный Redis для идемпотентности ===
let redisClient = null;
let redisReady = false;
try {
  if (process.env.REDIS_URL) {
    // пакет "redis" v4: npm i redis
    const { createClient } = require('redis');
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (e) => console.error('Redis error:', e.message));
    redisClient.connect()
      .then(() => { redisReady = true; console.log('Redis connected'); })
      .catch((e) => console.error('Redis connect error:', e.message));
  }
} catch (_) {
  console.warn('Пакет "redis" не установлен — будет использоваться in-memory кеш');
}

// === [НОВОЕ] In-memory fallback (для одного процесса) ===
const localOnce = new Map(); // key -> expireAt
function localSetOnce(key, ttlSec) {
  const now = Date.now();
  const exp = localOnce.get(key);
  if (exp && exp > now) return false; // уже было
  const until = now + ttlSec * 1000;
  localOnce.set(key, until);
  setTimeout(() => {
    if (localOnce.get(key) === until) localOnce.delete(key);
  }, ttlSec * 1000 + 1000);
  return true;
}
async function claimOnce(key, ttlSec = 3 * 24 * 3600) {
  if (redisReady) {
    // NX + EX — установим флаг "отправлено" ровно один раз
    const r = await redisClient.set(key, '1', { NX: true, EX: ttlSec });
    return r === 'OK';
  }
  return localSetOnce(key, ttlSec);
}
async function releaseOnce(key) {
  if (redisReady) {
    try { await redisClient.del(key); } catch (_) {}
  } else {
    localOnce.delete(key);
  }
}

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

// Подпись для Tilda
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
  const url = process.env.TILDA_NOTIFICATION_URL;
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

// === WhatsApp: отправка уведомлений ресторану ===
async function sendWhatsAppText(to, text) {
  const phoneId = process.env.WA_PHONE_ID;
  const token = process.env.WA_TOKEN;

  if (!phoneId || !token) {
    console.warn('WA_PHONE_ID или WA_TOKEN не заданы — WhatsApp-уведомление пропущено');
    return;
  }
  if (!to) {
    console.warn('WA_RESTAURANT (номер получателя) не задан — WhatsApp-уведомление пропущено');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  try {
    const resp = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log('WhatsApp notify:', resp.status, resp.data);
  } catch (err) {
    console.error('WhatsApp notify error:', err?.response?.data || err.message);
    throw err;
  }
}

// ---------- app ----------
const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (_, res) => res.status(200).send('OK'));

// === 1) Старт оплаты с Tilda ===
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
      items = [{
        title: description || `Order ${externalRef}`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: total
      }];
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
app.get('/mp/webhook', (_, res) => res.status(200).send('OK'));

// [НОВОЕ] — быстрый ACK + обработка в фоне, идемпотентность для WhatsApp и Sheets
app.post('/mp/webhook', (req, res) => {
  // 1) Сразу отвечаем 200, чтобы MP не ретраил
  res.sendStatus(200);

  // 2) Дальше — асинхронная обработка
  (async () => {
    try {
      const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
      const event = req.body || {};
      const query = req.query || {};
      console.log('MP webhook:', JSON.stringify({ body: event, query }));

      const isPaymentEvent =
        event?.type === 'payment' ||
        query?.type === 'payment' ||
        query?.topic === 'payment';

      const paymentId = event?.data?.id || query?.id;
      if (!isPaymentEvent || !paymentId) return;

      // Получаем платеж
      let p;
      try {
        const { data } = await axios.get(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          { headers: { Authorization: `Bearer ${MP_TOKEN}` }, timeout: 10000 }
        );
        p = data;
      } catch (e) {
        console.error('fetch payment error:', e?.response?.data || e.message);
        return;
      }

      console.log(`Payment ${p.id}: status=${p.status} external_reference=${p.external_reference}`);

      // Уведомляем Tilda всегда (пусть будет идемпотентно на стороне Tilda)
      try {
        await notifyTilda({
          orderid: String(p.external_reference || ''), // должен совпадать с orderid у /checkout
          payment_id: String(p.id),
          status: String(p.status || 'unknown'),
          amount: p.transaction_amount,
          currency: p.currency_id || 'ARS',
          email: p.payer?.email || ''
        });
      } catch (_) {}

      // Только при успешной оплате — и только один раз на заказ
      if (p.status === 'approved') {
        const to = process.env.WA_RESTAURANT;
        const key = `wa:order-approved:${p.external_reference || p.id}`; // один ключ на заказ

        const firstTime = await claimOnce(key, 7 * 24 * 3600); // неделя
        if (!firstTime) {
          console.log('Skip duplicate WhatsApp for', key);
          return;
        }

        try {
          const msgLines = [
            `✅ Nuevo pedido #${p.external_reference || p.id}`,
            `Estado: PAGADO`,
            `Total: ${p.transaction_amount} ${p.currency_id || 'ARS'}`,
            p.payer?.email ? `Cliente: ${p.payer.email}` : ''
          ].filter(Boolean);

          await sendWhatsAppText(to, msgLines.join('\n'));

          // [Опционально] лог в таблицу — тоже только один раз
          await appendToSheet({
            order_id: p.external_reference,
            payment_id: p.id,
            status: p.status,
            customer_email: p.payer?.email || '',
            items: [],
            total_amount: p.transaction_amount
          });
        } catch (err) {
          // если отправка упала — освободим флажок, чтобы можно было повторить позже
          await releaseOnce(key);
          console.error('WhatsApp/Sheet flow error:', err.message);
        }
      }
    } catch (err) {
      console.error('webhook async error:', err.message);
    }
  })();
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on', PORT));

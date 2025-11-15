// server.js
'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// --- Конфиг из переменных окружения ---
const PORT = process.env.PORT || 10000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // PROD токен
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://pho-backend.onrender.com';

// Куда вернуть пользователя после оплаты (ваша страница "Gracias" в Тильде)
const DEFAULT_SUCCESS_URL = process.env.MP_SUCCESS_URL || 'http://phorestaurante.tilda.ws/page93974626.html';

// --- Базовая защита и парсинг ---
app.use(cors()); // для простоты открываемся всем; при желании ограничьте на домен Tilda
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Раздача статических файлов из /public (в т.ч. tilda-mp.js)
app.use(express.static('public', { maxAge: '5m' }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

// --- Stub вебхука (пока что просто 200 OK, пригодится позже) ---
app.post('/mp/webhook', (req, res) => {
  // На следующем этапе будем обрабатывать уведомления.
  res.sendStatus(200);
});

// --- Вспомогательные функции ---
function toAmount(n) {
  const num = Number(String(n).replace(',', '.'));
  if (!isFinite(num)) return 0;
  return Math.round(num * 100) / 100; // 2 знака
}

function normalizeItems(items, currency) {
  const cur = (currency || 'ARS').toUpperCase();
  if (Array.isArray(items) && items.length) {
    return items.map((p, idx) => ({
      id: String(p.id ?? idx + 1),
      title: String(p.title ?? p.name ?? 'Producto'),
      quantity: Number(p.quantity ?? p.qty ?? 1),
      currency_id: cur,
      unit_price: toAmount(p.unit_price ?? p.price ?? 0),
    }));
  }
  return null;
}

// --- Главный эндпоинт: создать Preference и вернуть init_point ---
app.post('/mp/create-preference', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'MP_ACCESS_TOKEN is not set on the server' });
    }

    const {
      total,
      currency = 'ARS',
      items,
      payer = {},
      delivery_zone,
      success_url,        // опционально переопределить success
      external_reference, // опционально
    } = req.body || {};

    const amount = toAmount(total);
    if (amount <= 0 && !(items && items.length)) {
      return res.status(400).json({ error: 'Invalid total or items' });
    }

    const mpItems = normalizeItems(items, currency) || [{
      id: 'ORDER-1',
      title: 'Pedido PHO',
      quantity: 1,
      currency_id: (currency || 'ARS').toUpperCase(),
      unit_price: amount,
    }];

    const preference = {
      items: mpItems,
      binary_mode: true, // без статуса "pending"
      auto_return: 'approved',
      back_urls: {
        success: success_url || DEFAULT_SUCCESS_URL,
        failure: success_url || DEFAULT_SUCCESS_URL,
        pending: success_url || DEFAULT_SUCCESS_URL,
      },
      notification_url: `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/mp/webhook`,
      statement_descriptor: 'PHO IS IT',
      external_reference: external_reference || `tilda-${Date.now()}`,
      metadata: {
        delivery_zone: delivery_zone || null,
      },
      payer: {
        name: payer.name || null,
        surname: payer.surname || null,
        email: payer.email || null,
        phone: payer.phone ? {
          area_code: payer.phone.area_code || '',
          number: String(payer.phone.number || '').replace(/\D/g, '')
        } : undefined,
        identification: payer.identification,
      },
    };

    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      preference,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const pref = response.data || {};
    const link = pref.init_point || pref.sandbox_init_point;
    if (!link) {
      return res.status(502).json({ error: 'Mercado Pago did not return init_point' });
    }

    return res.json({
      id: pref.id,
      init_point: link,
    });
  } catch (err) {
    console.error('MP create-preference error:', err?.response?.data || err.message);
    return res.status(500).json({
      error: 'Failed to create Mercado Pago preference',
      details: err?.response?.data || err.message,
    });
  }
});

// --- Старт сервера ---
app.listen(PORT, () => {
  console.log(`pho-backend listening on ${PORT}`);
});

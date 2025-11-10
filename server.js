// server.js
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');

const app = express();

// логирование и парсинг
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// healthcheck
app.get('/health', (req, res) => res.status(200).send('OK'));

// === 1) Точка оплаты для Тильды ===
// Tilda: Settings → Платежные системы → Универсальная → API URL = https://<твой-домен>/api/tilda/checkout
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_TOKEN) {
      console.error('MP_ACCESS_TOKEN не задан');
      return res.status(500).send('Mercado Pago token is missing');
    }

    // Достаём данные из формы Тильды
    const {
      orderid,
      order_id,
      description,
      amount,            // если настроишь "Сумма заказа" = amount, придёт тут
      email,
      customer_email,
      delivery_price,
      shipping_price,
      products           // Массив товаров: JSON или base64(JSON)
    } = req.body;

    // Внешняя ссылка на заказ (для поиска в логах/вебхуках)
    const externalRef = String(order_id || orderid || Date.now());

    // Разбор товаров
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

    // Собираем позиции для MP (валюта ARS)
    let items = itemsIn.map((p, i) => ({
      title: p.name || `Item ${i + 1}`,
      quantity: Number(p.quantity) || 1,
      currency_id: 'ARS',
      unit_price: Number(p.price) || 0
    }));

    // Доставка отдельной позицией (если пришла)
    const ship = Number(delivery_price || shipping_price);
    if (!Number.isNaN(ship) && ship > 0) {
      items.push({
        title: 'Delivery',
        quantity: 1,
        currency_id: 'ARS',
        unit_price: ship
      });
    }

    // Если товаров нет — берём общую сумму
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
    const successUrl = process.env.SUCCESS_URL || 'https://phorestaurante.tilda.ws/thank-you';
    const failureUrl = process.env.FAIL_URL || successUrl;
    const pendingUrl = process.env.PENDING_URL || successUrl;

    // Создаём preference (Checkout Pro)
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
      // Вебхук в наш сервер
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

    // Редиректим клиента на Mercado Pago
    return res.redirect(302, initPoint);
  } catch (err) {
    console.error('checkout error:', err?.response?.data || err.message);
    return res.status(500).send('Checkout error');
  }
});

// === 2) Вебхуки Mercado Pago ===
// MP панель: Webhooks → URL de producción = https://<твой-домен>/mp/webhook
// Симулятор иногда дергает GET — держим и GET, и POST.
app.get('/mp/webhook', (req, res) => {
  // простой ответ для проверки URL
  return res.status(200).send('OK');
});

app.post('/mp/webhook', async (req, res) => {
  try {
    const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
    const event = req.body || {};
    console.log('MP webhook event:', JSON.stringify(event));

    // Типичный payload: { type: "payment", data: { id: "123456" } }
    if (event.type === 'payment' && event.data && event.data.id) {
      const id = event.data.id;
      try {
        const payResp = await axios.get(
          `https://api.mercadopago.com/v1/payments/${id}`,
          { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
        );
        const st = payResp?.data?.status;
        const extRef = payResp?.data?.external_reference;
        console.log(`payment ${id} status=`, st, 'external_reference=', extRef);

        // Здесь можно: отправить в Google Sheets/WhatsApp/Тильду
        // TODO: ваш код пост-обработки успешной оплаты (st === 'approved')
      } catch (e) {
        console.error('fetch payment error:', e?.response?.data || e.message);
      }
    }

    // Важно: всегда 200, иначе MP будет ретраить
    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook error:', err.message);
    return res.sendStatus(200); // всё равно 200
  }
});

// старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on', PORT));

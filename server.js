// server.js
// Node.js >= 18 (на Render сейчас подойдет и 20/22/25).
// Эндпоинты:
//  - POST /api/tilda/checkout  -> редирект на Mercado Pago CheckoutPro
//  - POST /mp/webhook          -> обработка вебхука, уведомление Тильды
//  - GET  /mp/return           -> страница возврата для пользователя
//  - GET  /health              -> ok

const express = require('express');
const crypto = require('crypto');

// Для локальной разработки .env. На Render можно не ставить dotenv.
try { require('dotenv').config(); } catch (_) {}

const app = express();

// Парсеры: Tilda шлет form-urlencoded из браузера, вебхук — JSON.
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Небольшой лог
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const TILDA_NOTIFICATION_URL = process.env.TILDA_NOTIFICATION_URL || '';
const TILDA_SECRET = process.env.TILDA_SECRET || ''; // можно оставить пустой, если в Тильде секрет не используется

if (!MP_ACCESS_TOKEN) console.warn('[WARN] MP_ACCESS_TOKEN не задан.');
if (!PUBLIC_BASE_URL) console.warn('[WARN] PUBLIC_BASE_URL не задан.');
if (!TILDA_NOTIFICATION_URL) console.warn('[WARN] TILDA_NOTIFICATION_URL не задан. Вебхук не сможет уведомлять Тильду.');

// ---------- Утилиты ----------

// MD5 без HMAC, как в настройках: сортировка ключей по возрастанию, без поля "signature".
function buildTildaSignature(obj, secret = '', { addSecret = 'none', excludeEmpty = false } = {}) {
  const data = { ...obj };
  delete data.signature;

  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b));
  const parts = [];

  if (addSecret === 'first' && secret) parts.push(secret);

  for (const k of keys) {
    const v = data[k];
    if (excludeEmpty && (v === '' || v === null || v === undefined)) continue;
    // В Тильде массивы/объекты обычно передаются строкой (например, items как JSON).
    parts.push(typeof v === 'string' ? v : JSON.stringify(v));
  }

  if (addSecret === 'last' && secret) parts.push(secret);

  const str = parts.join('');
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

// items: строка JSON | base64(JSON) | массив
function parseItems(itemsRaw) {
  if (!itemsRaw) return [];
  if (Array.isArray(itemsRaw)) return itemsRaw;

  let txt = String(itemsRaw);
  // Попытка base64 -> текст, иначе берем как есть
  try {
    const maybe = Buffer.from(txt, 'base64').toString('utf8');
    // Если получилась валидная JSON-строка — используем её
    if (maybe.trim().startsWith('[') || maybe.trim().startsWith('{')) {
      txt = maybe;
    }
  } catch (_) {}

  try {
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function toNumber(n) {
  if (typeof n === 'number') return n;
  if (typeof n !== 'string') return 0;
  // убрать разделители тысяч
  const cleaned = n.replace(/\./g, '').replace(/,/g, '.'); // на всякий
  const val = Number(cleaned);
  return Number.isFinite(val) ? val : 0;
}

// Запрос к API MP (используем глобальный fetch в Node >=18)
async function mpApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = `[MP API] ${method} ${path} -> ${res.status} ${res.statusText} ${JSON.stringify(json)}`;
    throw new Error(msg);
  }
  return json;
}

// Уведомление Тильде (form-urlencoded, как принято)
async function notifyTilda(payload) {
  if (!TILDA_NOTIFICATION_URL) {
    console.warn('[notifyTilda] TILDA_NOTIFICATION_URL не задан, пропускаю нотификацию.');
    return { ok: false, skipped: true };
  }

  // Собираем подпись по тем же правилам (MD5, без секрета, если он пустой)
  const signature = buildTildaSignature(payload, TILDA_SECRET, {
    addSecret: 'none',      // вы указывали “Добавлять секрет в подпись: Нет”
    excludeEmpty: false,    // флажок “Не использовать пустые” был снят
  });

  const body = new URLSearchParams({ ...payload, signature });

  const res = await fetch(TILDA_NOTIFICATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text().catch(() => '');
  // Тильда по настройке должна возвращать "OK" / "ERROR"
  const ok = res.ok && /OK/i.test(text);
  if (!ok) {
    console.warn(`[notifyTilda] non-OK response: status=${res.status}, body=${text}`);
  } else {
    console.log('[notifyTilda] OK');
  }
  return { ok, status: res.status, body: text };
}

// ---------- Роуты ----------

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

// Приём из Тильды -> создаём преференс и редиректим на CheckoutPro
app.post('/api/tilda/checkout', async (req, res) => {
  try {
    // Поля из Тильды: см. вашу карту полей в настройках
    const {
      orderid = '',
      description = 'Order',
      amount,
      currency = 'ARS',
      email = '',
      phone = '',
      name = '',
      items: itemsRaw,
      signature: tildaSignatureIn,
      // created_at, login, и др. — тоже придут, но сейчас не обязательны
    } = req.body || {};

    // Верификацию подписи можно включить при необходимости.
    // Не “ломаем” поток пользователю, просто логируем расхождение.
    try {
      const expected = buildTildaSignature(req.body || {}, TILDA_SECRET, {
        addSecret: 'none',
        excludeEmpty: false,
      });
      if (tildaSignatureIn && expected && expected !== tildaSignatureIn) {
        console.warn(`[checkout] Signature mismatch: expected=${expected} got=${tildaSignatureIn}`);
      }
    } catch (e) {
      console.warn('[checkout] signature check error:', e.message);
    }

    const items = parseItems(itemsRaw);

    // Если из Тильды пришли позиции — используем их. Иначе — одна позиция по сумме заказа.
    let mpItems;
    if (items.length) {
      mpItems = items.map((it, idx) => ({
        id: String(idx + 1),
        title: String(it.name || it.title || 'Item'),
        quantity: Number(it.quantity || 1),
        currency_id: currency || 'ARS',
        unit_price: toNumber(it.price || it.amount || 0),
      }));
    } else {
      mpItems = [{
        id: '1',
        title: String(description || 'Order'),
        quantity: 1,
        currency_id: currency || 'ARS',
        unit_price: toNumber(amount || 0),
      }];
    }

    // Подготовка payer
    const payer = {};
    if (email) payer.email = String(email);
    if (name) {
      const parts = String(name).split(' ');
      payer.first_name = parts[0] || '';
      payer.last_name = parts.slice(1).join(' ');
    }

    // URL возврата для пользователя
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const ret = (status) =>
      `${base}/mp/return?status=${encodeURIComponent(status)}&orderid=${encodeURIComponent(orderid || '')}`;

    const prefBody = {
      external_reference: orderid || undefined,
      items: mpItems,
      payer,
      back_urls: {
        success: ret('success'),
        pending: ret('pending'),
        failure: ret('failure'),
      },
      auto_return: 'approved',
      // Вебхук сервера
      notification_url: `${base}/mp/webhook`,
      statement_descriptor: 'PHO IS IT',
    };

    const pref = await mpApi('/checkout/preferences', { method: 'POST', body: prefBody });

    const redirectUrl = pref.init_point || pref.sandbox_init_point;
    if (!redirectUrl) {
      throw new Error('Mercado Pago не вернул init_point');
    }

    // 302 на Mercado Pago CheckoutPro
    return res.redirect(302, redirectUrl);
  } catch (err) {
    console.error('[checkout] error:', err);
    // Покажем пользователю простую страницу с сообщением и ссылкой назад
    res.status(500).send(
      `<!doctype html><meta charset="utf-8">
       <title>Error</title>
       <h3>Не удалось начать оплату</h3>
       <p>Попробуйте ещё раз или свяжитесь с нами.</p>`
    );
  }
});

// Вебхук Mercado Pago
app.post('/mp/webhook', async (req, res) => {
  try {
    // Форматы от MP бывают разные — поддержим основные.
    const body = req.body || {};
    const type = body.type || body.topic || '';
    const idFromBody = body?.data?.id || body?.id;
    const idFromQuery = req.query['data.id'] || req.query.id;
    const paymentId = idFromBody || idFromQuery;

    // Нас интересуют только платежи
    if (!/payment/i.test(type) && !paymentId) {
      // Некоторые инсталлы шлют order/merchant_order, их можно добавить по необходимости
      console.log('[webhook] skip non-payment event', { type, paymentId });
      return res.status(200).send('OK');
    }

    const pay = await mpApi(`/v1/payments/${paymentId}`, { method: 'GET' });

    console.log('[webhook] payment status:', pay.status, 'ext_ref:', pay.external_reference);

    // Готовим поля для Тильды
    const tildaPayload = {
      orderid: pay.external_reference || '',            // <ID проекта>:<ID заказа> из преференса
      status: pay.status || '',                         // ожидается "approved" для оплачен
      payment_id: String(pay.id || ''),                 // целое число
      amount: String(pay.transaction_amount || ''),     // сумма
      currency: String(pay.currency_id || ''),          // например, ARS
      email: pay.payer?.email || '',
      name: [pay.payer?.first_name, pay.payer?.last_name].filter(Boolean).join(' '),
    };

    await notifyTilda(tildaPayload);

    // Важно быстро отвечать вебхуку 200
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[webhook] error:', err);
    // Отвечаем 200, чтобы MP не ретраил бесконечно — но логируем ошибку.
    return res.status(200).send('OK');
  }
});

// Страница возврата после оплаты
app.get('/mp/return', (req, res) => {
  const { status = '', orderid = '' } = req.query || {};
  const isOk = String(status).toLowerCase() === 'success' || String(status).toLowerCase() === 'approved';

  const title = isOk ? 'Оплата принята' : (String(status).toLowerCase() === 'pending' ? 'Платёж в ожидании' : 'Оплата не прошла');
  const desc = isOk
    ? 'Спасибо! Заказ отмечен как оплаченный.'
    : (String(status).toLowerCase() === 'pending'
        ? 'Платёж ещё не подтверждён банком.'
        : 'К сожалению, оплата не завершена.');

  const tildaMain = 'http://phorestaurante.tilda.ws/'; // при желании замените на свою «Gracias»-страницу
  res.status(200).send(`<!doctype html><meta charset="utf-8">
    <title>${title}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif; padding:24px; line-height:1.45}
      a{color:#1663ff; text-decoration:none}
      .box{max-width:640px; margin:0 auto}
    </style>
    <div class="box">
      <h2>${title}</h2>
      <p>${desc}</p>
      ${orderid ? `<p>Номер заказа: <strong>${String(orderid)}</strong></p>` : ''}
      <p><a href="${tildaMain}">Вернуться на сайт</a></p>
    </div>`);
});

// Корень
app.get('/', (_req, res) => res.status(200).send('pho-backend up'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`pho-backend listening on port ${PORT}`);
});

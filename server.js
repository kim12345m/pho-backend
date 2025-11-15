'use strict';

/* -----------------------------------------------------------
 * Google Sheets: инициализация клиента и функция appendToSheet
 * ----------------------------------------------------------- */
const { google } = require('googleapis');

let _sheetsClient = null;

/**
 * Создаёт и кеширует клиент Google Sheets (JWT по сервис-аккаунту).
 * Берёт JSON из GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON или base64).
 */
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('[Sheets] GOOGLE_SERVICE_ACCOUNT_JSON не задан — пропущу запись в таблицу.');
    return null;
  }

  let creds;
  try {
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    creds = JSON.parse(text);
  } catch (e) {
    console.error('[Sheets] Невалидный GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    return null;
  }

  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  // Исправляем \n в приватном ключе
  const private_key = (creds.private_key || '').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: private_key,
    scopes
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

/**
 * Добавляет одну строку в таблицу.
 * @param {Array} values - массив ячеек (одна строка)
 */
async function appendToSheet(values) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = process.env.GOOGLE_SHEETS_TAB_NAME || 'Sheet1';

  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEETS_SPREADSHEET_ID не задан — пропускаю append.');
    return;
  }

  const sheets = await getSheetsClient();
  if (!sheets) return;

  const range = `${tab}!A:Z`;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });

  console.log('[Sheets] Строка добавлена.');
}

/* -----------------------------------------------------------
 * Сервер: Express + Mercado Pago Webhook
 * ----------------------------------------------------------- */
const express = require('express');
const crypto = require('crypto');

const app = express();

// Healthcheck
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Для всех остальных JSON-запросов
app.use(express.json({ limit: '1mb' }));

/**
 * Верификация подписи Mercado Pago (опционально).
 * Если MP_WEBHOOK_SECRET не задан – просто возвращаем true (не блокируем).
 * Реализации у MP бывают разные; здесь вариант с заголовком x-signature: "ts=...,v1=...".
 * Если у вас другой формат подписи – событие всё равно не будет отклонено,
 * пока не установите ENFORCE_MP_SIGNATURE=true (строгое соблюдение).
 */
function verifyMpSignature(req, rawBodyBuf) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: true, reason: 'no-secret' };
  }

  const sigHeader = req.get('x-signature') || '';
  // Ожидаем формат вида: ts=...,v1=HMAC
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const [k, v] = kv.trim().split('=');
      return [k, (v || '').trim()];
    })
  );

  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) {
    return { ok: false, reason: 'bad-header' };
  }

  // По документации MP одна из схем — HMAC-SHA256(ts + url + body)
  // где url — это полный NOTIFICATION URL (должен совпадать с тем, что настроен в панели),
  // поэтому берём PUBLIC_BASE_URL + '/mp/webhook'.
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const notificationUrl = `${publicBase}/mp/webhook`;
  const payload = `${ts}${notificationUrl}${rawBodyBuf.toString('utf8')}`;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const ok = crypto.timingSafeEqual(
    Buffer.from(digest, 'hex'),
    Buffer.from(v1, 'hex')
  );

  return { ok, reason: ok ? 'ok' : 'mismatch' };
}

// Вебхук Mercado Pago — raw body нужен для подписи
app.post('/mp/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Подпись (опционально строгая)
    const sig = verifyMpSignature(req, req.body || Buffer.from(''));
    if (!sig.ok && String(process.env.ENFORCE_MP_SIGNATURE).toLowerCase() === 'true') {
      console.warn('[MP] Подпись не прошла проверку:', sig.reason);
      return res.status(401).send('invalid signature');
    }
    if (!sig.ok) {
      console.warn('[MP] Подпись не прошла, но обработка не заблокирована:', sig.reason);
    }

    // Тело события
    let event;
    try {
      event = JSON.parse((req.body || Buffer.from('{}')).toString('utf8'));
    } catch (e) {
      console.error('[MP] Невалидный JSON в вебхуке:', e.message);
      return res.status(200).send('ignored');
    }

    // Пример события из панели MP (Simular notificación):
    // {
    //   "type":"payment",
    //   "action":"payment.updated",
    //   "data":{"id":"123456"},
    //   ...
    // }
    const { type, action, data } = event || {};
    if (type !== 'payment' || !data || !data.id) {
      // Для прочих типов отвечаем 200, чтобы не ретраили.
      return res.status(200).send('ignored');
    }

    const paymentId = data.id;
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) {
      console.error('[MP] MP_ACCESS_TOKEN не задан.');
      return res.status(200).send('no-token');
    }

    // Тянем платёж, чтобы узнать статус
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (resp.status === 404) {
      // Такое бывает при "Simular notificación" — фейковый id.
      console.warn(`[MP] payment ${paymentId} не найден (возможно, симуляция).`);
      return res.status(200).send('ok');
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('[MP] Ошибка запроса payment:', resp.status, text);
      // Возвращаем 200, чтобы MP не крутил ретраи бесконечно.
      return res.status(200).send('ok');
    }

    const payment = await resp.json();

    // Обрабатываем только подтверждённые
    if (payment.status === 'approved') {
      // Составим строку для таблицы (корректируйте под вашу структуру)
      const items = (payment.additional_info && payment.additional_info.items) || [];
      const itemsCompact = items.map(i => `${i.title || ''} x${i.quantity || 1} @ ${i.unit_price ?? ''}`).join(' | ');

      const row = [
        new Date().toISOString(),                 // Время обработки вебхука
        String(payment.id || ''),                 // ID оплаты MP
        String(payment.external_reference || ''), // Внешняя ссылка/номер заказа (если передавали)
        String(payment.description || ''),        // Описание
        String(payment.transaction_amount ?? ''), // Сумма
        String(payment.currency_id || ''),        // Валюта
        String(payment.payment_method_id || ''),  // Метод оплаты
        String(payment.payer && payment.payer.email || ''), // Email плательщика
        String(payment.status || ''),             // Статус
        String(payment.status_detail || ''),      // Деталь статуса
        itemsCompact                               // Позиции заказа (сжато)
      ];

      try {
        await appendToSheet(row);
        console.log(`[MP] Оплата ${payment.id} записана в Google Sheets.`);
      } catch (e) {
        console.error('[Sheets] Ошибка записи в таблицу:', e.message);
        // Даже если таблица недоступна — вебхук ответим 200, чтобы MP не ретраил.
      }
    } else {
      console.log(`[MP] Оплата ${paymentId} со статусом: ${payment.status} — не пишем в Sheets.`);
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[MP] Непредвиденная ошибка вебхука:', err);
    // Возвращаем 200, чтобы избежать бесконечных ретраев со стороны MP.
    return res.status(200).send('ok');
  }
});

// (опционально) корень
app.get('/', (_req, res) => res.send('pho-backend up'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`pho-backend listening on port ${PORT}`);
});

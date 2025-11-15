// public/tilda-mp.js
(function () {
  const BACKEND = (window.MP_BACKEND_BASE_URL || 'https://pho-backend.onrender.com').replace(/\/+$/, '');
  const SUCCESS_URL = window.MP_SUCCESS_URL || 'http://phorestaurante.tilda.ws/page93974626.html';
  const DEBUG = !!window.MP_DEBUG;

  function log(...args) { if (DEBUG && typeof console !== 'undefined') console.log('[MP]', ...args); }

  // Ждём появления tcart (Тильда подгружает его асинхронно)
  function waitForCartReady(cb, tries = 0) {
    if (window.tcart && Array.isArray(window.tcart.products)) return cb();
    if (tries > 300) return; // ~60 сек максимум
    setTimeout(() => waitForCartReady(cb, tries + 1), 200);
  }

  // Считываем данные корзины
  function readCartData() {
    const c = window.tcart || {};
    const products = Array.isArray(c.products) ? c.products : [];
    const items = products.map((p) => ({
      id: p.uid || p.sku || p.id || undefined,
      title: p.name || 'Producto',
      quantity: Number(p.quantity || p.qty || 1),
      unit_price: Number((p.price || 0)),
    }));
    // Попробуем взять total из tcart; если нет — из DOM
    let total = Number(c.total || c.prodamount || 0);
    if (!total || !isFinite(total)) {
      const n = document.querySelector('.t706__cartwin-totalamount, .js-tilda-price-total, [data-cart-total]');
      if (n) {
        const m = (n.textContent || '').replace(/[^\d.,-]/g, '').replace(',', '.');
        total = Number(m);
      }
    }
    // Валюта в Тильде обычно задаётся глобально; по умолчанию ARS
    const currency = (window.tcart__currency || c.currency || 'ARS').toString().toUpperCase();
    return { items, total, currency };
  }

  // Ищем выбранную зону доставки (radio в форме корзины)
  function readDeliveryZone(formEl) {
    try {
      const checked = formEl.querySelector('input[type="radio"]:checked');
      if (!checked) return null;
      // попытаемся взять ближайший текст label
      const label = checked.closest('label');
      if (label) return label.textContent.trim();
      // или текстовый узел рядом
      if (checked.nextSibling && checked.nextSibling.textContent) {
        return checked.nextSibling.textContent.trim();
      }
      return checked.value || null;
    } catch (_) { return null; }
  }

  // Ищем имя/телефон/email из полей формы (если есть)
  function readPayer(formEl) {
    const getVal = (sel) => {
      const el = formEl.querySelector(sel);
      return el ? (el.value || '').trim() : '';
    };
    const name = getVal('input[name*="name" i], input[placeholder*="name" i], input[placeholder*="Nombre" i]');
    const email = getVal('input[type="email"], input[name*="mail" i]');
    const rawPhone = getVal('input[type="tel"], input[name*="phone" i], input[placeholder*="Tel" i]');
    const phoneDigits = rawPhone.replace(/\D/g, '');
    return {
      name: name || undefined,
      email: email || undefined,
      phone: phoneDigits ? { number: phoneDigits } : undefined,
    };
  }

  // Главный перехватчик отправки формы корзины
  function attachCartSubmitInterceptor() {
    document.addEventListener('submit', async function (e) {
      const form = e.target;
      if (!form || !(form instanceof HTMLFormElement)) return;

      // Узнаём форму корзины по скрытому полю "Cart" (Тильда так его добавляет)
      const isCart = !!form.querySelector('input[type="hidden"][value="Cart"]');
      if (!isCart) return;

      e.preventDefault(); // блокируем стандартную отправку
      log('Intercepted Tilda cart submit');

      // Достаём данные
      const { items, total, currency } = readCartData();
      const delivery_zone = readDeliveryZone(form);
      const payer = readPayer(form);

      if (!total || !isFinite(total) || total <= 0) {
        alert('No pudimos calcular el total del pedido.');
        return;
      }

      // Делаем кнопку неактивной, чтобы не дублировать клики
      const submitBtn = form.querySelector('button[type="submit"], .t-submit, .js-store-btn');
      const prevText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creando pago…';
      }

      try {
        const resp = await fetch(`${BACKEND}/mp/create-preference`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items, total, currency, delivery_zone, payer,
            success_url: SUCCESS_URL
          }),
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.init_point) {
          log('Create preference error:', data);
          alert('No pudimos iniciar el pago. Intentalo de nuevo.');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevText; }
          return;
        }

        // Редирект на Mercado Pago
        window.location.href = data.init_point;
      } catch (err) {
        log('Network error:', err);
        alert('Error de conexión con el servidor de pago.');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevText; }
      }
    }, true); // перехватываем в capture-фазе, чтобы опередить внутренний обработчик Тильды
  }

  waitForCartReady(attachCartSubmitInterceptor);
})();

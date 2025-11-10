import express from "express";
import axios from "axios";
import crypto from "crypto";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function sign(data, secret) {
  const str = Object.keys(data)
    .filter(k => k !== "signature" && data[k] !== undefined && data[k] !== null)
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(str).digest("hex");
}

// === 1. Принимаем заказ от Tilda ===
app.post("/api/tilda/checkout", async (req, res) => {
  try {
    const order = req.body;
    if (!order.orderid || !order.amount) return res.status(400).send("invalid");

    const external_reference = order.orderid;
    const amount = Number(order.amount);
    const pref = {
      items: [
        {
          title: `Order ${external_reference}`,
          quantity: 1,
          unit_price: amount,
          currency_id: "ARS",
        },
      ],
      external_reference,
      back_urls: {
        success: `${process.env.PUBLIC_BASE_URL}/mp/return`,
        failure: `${process.env.PUBLIC_BASE_URL}/mp/return`,
        pending: `${process.env.PUBLIC_BASE_URL}/mp/return`,
      },
      auto_return: "approved",
      notification_url: `${process.env.PUBLIC_BASE_URL}/mp/webhook`,
    };

    const r = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      pref,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    const payUrl = r.data.init_point;
    res.redirect(302, payUrl);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("error");
  }
});

// === 2. Webhook Mercado Pago ===
app.post("/api/mp/webhook", async (req, res) => {
  try {
    const paymentId = req.query.id || req.body.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const r = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    if (r.data.status === "approved") {
      const payload = {
        orderid: r.data.external_reference,
        amount: r.data.transaction_amount,
        [process.env.TILDA_SUCCESS_FIELD]: process.env.TILDA_SUCCESS_VALUE,
      };
      const signature = sign(payload, process.env.TILDA_SECRET);
      await axios.post(process.env.TILDA_NOTIFICATION_URL, {
        ...payload,
        signature,
      });
    }

    res.send("OK");
  } catch (err) {
    console.error(err.message);
    res.send("ERROR");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));

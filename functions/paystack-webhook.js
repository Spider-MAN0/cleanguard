// CleanGuard — Paystack Webhook + Payment Handler
// Netlify Function: /.netlify/functions/paystack-webhook

const https  = require("https");
const crypto = require("crypto");

const PROJECT_ID      = process.env.FIREBASE_PROJECT_ID  || "cleanguard-493c2";
const FIREBASE_KEY    = process.env.FIREBASE_API_KEY     || "AIzaSyABKGu9feYP7eK-dFI4DDLR29SqM_bHDLA";
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PLAN_NGN        = process.env.PAYSTACK_PLAN_NGN    || "PLN_08ykesll2sshn37";
const PLAN_USD        = process.env.PAYSTACK_PLAN_USD    || ""; // Set after creating USD plan

// ── FIRESTORE WRITE ──
async function writePlanToFirestore(email, plan, extraFields = {}) {
  const docId = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const url   = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/payments/${docId}?key=${FIREBASE_KEY}`;

  const fields = {
    email:     { stringValue: email },
    plan:      { stringValue: plan },
    active:    { booleanValue: plan === "premium" },
    updatedAt: { timestampValue: new Date().toISOString() },
    ...extraFields,
  };

  const body = JSON.stringify({ fields });

  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        console.log(`[FIRESTORE] ${email} → plan:${plan} active:${plan === "premium"} (${res.statusCode})`);
        resolve({ ok: res.statusCode < 300, status: res.statusCode });
      });
    });
    req.on("error", e => { console.error("[FIRESTORE ERROR]", e.message); reject(e); });
    req.write(body);
    req.end();
  });
}

// ── PAYSTACK API HELPERS ──
function paystackRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.paystack.co", port: 443,
      path, method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error("Invalid JSON from Paystack")); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function verifySignature(body, sig) {
  if (!PAYSTACK_SECRET || !sig) return false;
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(body).digest("hex");
  return hash === sig;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const resp = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });

// ── HANDLER ──
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const path = (event.path || "").replace(/.*paystack-webhook/, "") || "/";

  // ── INITIALIZE PAYMENT ──
  if (event.httpMethod === "POST" && path === "/initialize") {
    try {
      const { email, currency = "NGN" } = JSON.parse(event.body || "{}");
      if (!email) return resp(400, { error: "Email required" });

      const plan   = currency === "NGN" ? PLAN_NGN : PLAN_USD;
      const amount = currency === "NGN" ? 200000 : 499; // kobo / cents

      const body = {
        email, currency,
        callback_url: "https://trycleanguard.com/payment-success.html",
        metadata: { product: "CleanGuard Premium" },
      };

      // Pass plan code for recurring — Paystack ignores amount when plan is set
      if (plan) body.plan = plan;
      else body.amount = amount;

      const result = await paystackRequest("POST", "/transaction/initialize", body);

      if (result.status) {
        return resp(200, {
          authorization_url: result.data.authorization_url,
          reference: result.data.reference,
        });
      }
      return resp(400, { error: result.message });
    } catch (e) { return resp(500, { error: e.message }); }
  }

  // ── VERIFY PAYMENT (after redirect) ──
  if (event.httpMethod === "GET" && path === "/verify") {
    try {
      const ref = event.queryStringParameters?.reference;
      if (!ref) return resp(400, { error: "Reference required" });

      const result = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(ref)}`);

      if (result.status && result.data.status === "success") {
        const email = result.data.customer.email;
        const nextPaymentDate = result.data.plan_object?.next_payment_date || null;

        await writePlanToFirestore(email, "premium", {
          subscriptionCode: { stringValue: result.data.subscription || "" },
          nextPaymentDate:  { stringValue: nextPaymentDate || "" },
          currency:         { stringValue: result.data.currency || "NGN" },
        });

        return resp(200, { success: true, plan: "premium", email });
      }

      return resp(400, { success: false, status: result.data?.status });
    } catch (e) { return resp(500, { error: e.message }); }
  }

  // ── PAYSTACK WEBHOOK (subscription lifecycle) ──
  if (event.httpMethod === "POST" && (path === "/" || path === "")) {
    // Verify it's really from Paystack
    if (!verifySignature(event.body, event.headers["x-paystack-signature"])) {
      console.log("[WEBHOOK] Invalid signature — rejected");
      return resp(401, { error: "Invalid signature" });
    }

    try {
      const payload = JSON.parse(event.body);
      const event_type = payload.event;
      const email = payload.data?.customer?.email;

      console.log(`[WEBHOOK] Event: ${event_type} | Email: ${email}`);

      // ── PAYMENT SUCCESS → set premium ──
      if (event_type === "charge.success") {
        if (email) await writePlanToFirestore(email, "premium");
      }

      // ── SUBSCRIPTION CREATED → set premium ──
      if (event_type === "subscription.create") {
        if (email) {
          const nextDate = payload.data?.next_payment_date || "";
          await writePlanToFirestore(email, "premium", {
            subscriptionCode: { stringValue: payload.data?.subscription_code || "" },
            nextPaymentDate:  { stringValue: nextDate },
          });
        }
      }

      // ── SUBSCRIPTION RENEWED → keep premium + update next date ──
      if (event_type === "invoice.payment_success") {
        if (email) {
          const nextDate = payload.data?.subscription?.next_payment_date || "";
          await writePlanToFirestore(email, "premium", {
            nextPaymentDate: { stringValue: nextDate },
          });
          console.log(`[WEBHOOK] Subscription renewed for ${email} → next: ${nextDate}`);
        }
      }

      // ── PAYMENT FAILED → downgrade to free ──
      if (event_type === "invoice.payment_failed") {
        if (email) {
          await writePlanToFirestore(email, "free");
          console.log(`[WEBHOOK] Payment failed for ${email} → downgraded to free`);
        }
      }

      // ── SUBSCRIPTION CANCELLED/DISABLED → downgrade to free ──
      if (["subscription.disable", "subscription.not_renew", "subscription.expiry_card"].includes(event_type)) {
        if (email) {
          await writePlanToFirestore(email, "free");
          console.log(`[WEBHOOK] Subscription ended for ${email} → downgraded to free`);
        }
      }

      // ── SUBSCRIPTION CANCELLED BY USER ──
      if (event_type === "subscription.expiry_notification") {
        // Just log — plan still active until end of period
        console.log(`[WEBHOOK] Expiry notification for ${email} — plan still active`);
      }

      return resp(200, { received: true });
    } catch (e) {
      console.error("[WEBHOOK ERROR]", e.message);
      return resp(500, { error: e.message });
    }
  }

  return resp(404, { error: "Not found" });
};

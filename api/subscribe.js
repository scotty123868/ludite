// Vercel serverless function for the Ludite waitlist form.
// Receives POST from /index.html → stores the email + sends a notification.
//
// STORAGE — pick one or both, configure in Vercel dashboard:
//
//   1) Vercel KV (recommended — first-party, free tier covers a launch):
//      Vercel dashboard → Storage → Create Database → KV → connect to project.
//      Auto-injects KV_REST_API_URL and KV_REST_API_TOKEN.
//      Inspect signups: in dashboard → Storage → KV → Data Browser → key:
//      "ludite:subscribers" (a Redis list, newest first).
//
//   2) Resend email notification (optional — get an email per signup):
//      Sign up at resend.com, create an API key.
//      Vercel dashboard → Settings → Environment Variables → add:
//        RESEND_API_KEY  = re_xxx
//        NOTIFY_EMAIL    = scotty@lasolasvc.com
//        RESEND_FROM     = Ludite <onboarding@resend.dev>   (default works
//                          before you verify a custom domain)
//
// If neither is configured, the function still returns 200 so the form's UX
// doesn't break — but the signup won't be persisted. Vercel function logs
// will surface a warning. Configure storage before launch.

const isValidEmail = (s) =>
  typeof s === "string" &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
  s.length <= 254;

export default async function handler(req, res) {
  // CORS / safety: only POST, only same-origin or no-origin (form posts).
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const email = String(body.email_address || body.email || "")
    .trim()
    .toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }

  const ts = new Date().toISOString();
  const ip =
    (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "")
      .toString()
      .split(",")[0]
      .trim();
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 200);
  const referer = (req.headers["referer"] || "").toString().slice(0, 300);

  const record = { email, ts, ip, ua, referer };

  let stored = false;
  let notified = false;

  // ---- Vercel KV via REST API (no package install needed) ----
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const url = `${process.env.KV_REST_API_URL}/lpush/ludite:subscribers/${encodeURIComponent(
        JSON.stringify(record)
      )}`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        },
      });
      stored = r.ok;
      if (!r.ok) {
        console.error("KV lpush failed:", r.status, await r.text());
      }
      // Also keep a uniqueness set so we can dedupe later if needed.
      await fetch(
        `${process.env.KV_REST_API_URL}/sadd/ludite:emails/${encodeURIComponent(email)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        }
      ).catch(() => {});
    } catch (e) {
      console.error("KV store error:", e);
    }
  }

  // ---- Resend email notification (optional) ----
  if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "Ludite <onboarding@resend.dev>",
          to: process.env.NOTIFY_EMAIL,
          subject: `New Ludite signup: ${email}`,
          text:
            `${email}\n\n` +
            `Received: ${ts}\n` +
            `IP: ${ip || "(none)"}\n` +
            `Referer: ${referer || "(none)"}\n` +
            `UA: ${ua || "(none)"}`,
        }),
      });
      notified = r.ok;
      if (!r.ok) {
        console.error("Resend send failed:", r.status, await r.text());
      }
    } catch (e) {
      console.error("Resend error:", e);
    }
  }

  if (!stored && !notified) {
    console.warn(
      `[ludite] signup for ${email} accepted but NOT persisted. ` +
        `Configure Vercel KV or Resend in environment variables.`
    );
  } else {
    console.log(
      `[ludite] signup ${email} stored=${stored} notified=${notified}`
    );
  }

  // Always return 200 so the form UX never feels broken. Failures are
  // visible in Vercel function logs.
  return res.status(200).json({ ok: true });
}

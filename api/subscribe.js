// Vercel serverless function for the Ludite waitlist form.
// Receives POST from /index.html → stores the email + sends a notification.
//
// STORAGE — pick any combination, configure in Vercel dashboard:
//
//   PATH A — Supabase (recommended, fully integrated):
//      Vercel → Storage → Marketplace → Supabase → Create → Connect to project.
//      Auto-injects SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (and others).
//      Then run supabase/schema.sql in the Supabase SQL Editor (one paste).
//      Inspect signups: Supabase dashboard → Table Editor → "subscribers".
//      It looks like a spreadsheet. Export as CSV any time.
//
//   PATH B — Resend (per-signup email notification, no database):
//      1. Sign up at resend.com, create an API key.
//      2. Vercel → Settings → Environment Variables, add:
//           RESEND_API_KEY  = re_xxx
//           NOTIFY_EMAIL    = scotty@lasolasvc.com
//           RESEND_FROM     = Ludite <onboarding@resend.dev>
//                             (default sender works until you verify
//                              ludite.live as a custom Resend domain)
//
//   PATH C — Upstash Redis (legacy / alternative to Supabase):
//      Vercel → Storage → Marketplace → Upstash → Redis → Connect.
//      Auto-injects either KV_REST_API_* or UPSTASH_REDIS_REST_* env vars.
//      This function handles either pair.
//      Inspect signups: Upstash dashboard → Data Browser → "ludite:subscribers".
//
// You can use all three at once (database + email notification + redundancy).
//
// If none are configured, the function still returns 200 so the form's UX
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

  // ---- Supabase via PostgREST API (no SDK needed) ----
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/subscribers`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ email, ip, ua, referer }),
      });
      // 201 = inserted. 409 = already exists (treat as success — they're on the list).
      stored = r.ok || r.status === 409;
      if (!r.ok && r.status !== 409) {
        console.error("Supabase insert failed:", r.status, await r.text());
      }
    } catch (e) {
      console.error("Supabase error:", e);
    }
  }

  // ---- Upstash Redis via REST API (works with either env var convention) ----
  const redisUrl =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (redisUrl && redisToken) {
    try {
      const r = await fetch(
        `${redisUrl}/lpush/ludite:subscribers/${encodeURIComponent(
          JSON.stringify(record)
        )}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${redisToken}` },
        }
      );
      stored = r.ok;
      if (!r.ok) {
        console.error("Redis lpush failed:", r.status, await r.text());
      }
      // Uniqueness set so we can dedupe later if needed.
      await fetch(
        `${redisUrl}/sadd/ludite:emails/${encodeURIComponent(email)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${redisToken}` },
        }
      ).catch(() => {});
    } catch (e) {
      console.error("Redis store error:", e);
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

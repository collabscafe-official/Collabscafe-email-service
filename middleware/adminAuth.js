// Admin auth for every campaign / status route (2026-10-20).
//
// Until now the service had NO auth: anyone could send email to any address
// from our SES sender, or page through every creator's and brand's email.
//
// Accepts the CC-Admin login token (Authorization: Bearer <admin JWT>) issued
// by Backend-V2. Verified here with Node's crypto (HS256) using the same
// secret as Backend-V2's JWT_SECRET_KEY_FOR_ADMIN_AFTER_LOGIN, set as
// ADMIN_JWT_SECRET in this service's .env. Only super_admin tokens pass.
//
// Transition: while ALLOW_LEGACY_API_KEY=true, the old x-api-key
// (ADMIN_API_KEY) is also accepted. Turn it off once CC-Admin sends tokens:
// that key ships inside the admin app's JavaScript, so it is not a secret.

const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function verifyHs256(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  if (typeof payload?.exp === "number" && Date.now() / 1000 >= payload.exp) return null;
  return payload;
}

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_JWT_SECRET;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const payload = verifyHs256(auth.slice(7), secret);
    if (payload?.payload?.user_type === "super_admin") {
      req.admin = { id: payload.payload.user_id };
      return next();
    }
  }
  if (process.env.ALLOW_LEGACY_API_KEY === "true" && safeEqual(req.headers["x-api-key"], process.env.ADMIN_API_KEY)) {
    return next();
  }
  if (!secret && process.env.ALLOW_LEGACY_API_KEY !== "true") {
    return res.status(503).json({ error: "Admin auth not configured" });
  }
  return res.status(401).json({ error: "Unauthorized" });
}

module.exports = { requireAdmin, verifyHs256 };

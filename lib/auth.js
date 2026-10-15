/*
 * Authentification sans service externe : mots de passe hachés (scrypt,
 * bibliothèque standard Node) et sessions par cookie signé HMAC.
 * Aucun jeton ni mot de passe n'est stocké en clair.
 */
import crypto from "node:crypto";

const SECRET_DEV = "colisexpress-session-dev-secret";
const DUREE_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function secret() {
  return process.env.SESSION_SECRET || SECRET_DEV;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored = "") {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const attendu = Buffer.from(hashHex, "hex");
  const calcule = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), attendu.length);
  return crypto.timingSafeEqual(attendu, calcule);
}

export function createSessionToken(agencyId, agentId = null) {
  const charge = { id: agencyId, exp: Date.now() + DUREE_SESSION_MS };
  // Session d'un agent : le compte reste l'agence, l'agent est l'acteur tracé.
  if (agentId) charge.agent = agentId;
  const corps = b64url(JSON.stringify(charge));
  const signature = b64url(crypto.createHmac("sha256", secret()).update(corps).digest());
  return `${corps}.${signature}`;
}

/** Charge complète de la session (agence + agent éventuel), ou null. */
export function readSessionCharge(token = "") {
  const [corps, signature] = String(token).split(".");
  if (!corps || !signature) return null;
  const attendu = b64url(crypto.createHmac("sha256", secret()).update(corps).digest());
  const a = Buffer.from(signature);
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const charge = JSON.parse(Buffer.from(corps, "base64url").toString("utf8"));
    if (!charge?.id || typeof charge.exp !== "number" || charge.exp < Date.now()) return null;
    return charge;
  } catch {
    return null;
  }
}

export function readSessionToken(token = "") {
  return readSessionCharge(token)?.id ?? null;
}

export function parseCookies(req) {
  const entete = req.headers?.cookie || "";
  const cookies = {};
  for (const morceau of entete.split(";")) {
    const index = morceau.indexOf("=");
    if (index > 0) cookies[morceau.slice(0, index).trim()] = decodeURIComponent(morceau.slice(index + 1).trim());
  }
  return cookies;
}

function cookieOptions(maxAgeMs) {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join("; ");
}

export function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `ce_session=${token}; ${cookieOptions(DUREE_SESSION_MS)}`);
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `ce_session=; ${cookieOptions(0)}`);
}

export function getSessionAgencyId(req) {
  return readSessionToken(parseCookies(req).ce_session || "");
}

/** Charge de session portée par la requête (agence + agent éventuel), ou null. */
export function getSessionCharge(req) {
  return readSessionCharge(parseCookies(req).ce_session || "");
}

/* ---------------------- console plateforme (LOT 6) ---------------------- */
// Session SÉPARÉE de celle des agences : cookie distinct (`ce_plateforme`),
// charge distincte ({ plateforme }) et domaine de signature distinct — un
// jeton d'agence ne vaut jamais session plateforme, et réciproquement.

const DUREE_SESSION_PLATEFORME_MS = 12 * 60 * 60 * 1000; // 12 heures
const DOMAINE_PLATEFORME = "plateforme.";

function signerPlateforme(corps) {
  return b64url(crypto.createHmac("sha256", secret()).update(DOMAINE_PLATEFORME + corps).digest());
}

export function createPlatformToken(adminId) {
  const corps = b64url(JSON.stringify({ plateforme: adminId, exp: Date.now() + DUREE_SESSION_PLATEFORME_MS }));
  return `${corps}.${signerPlateforme(corps)}`;
}

export function readPlatformCharge(token = "") {
  const [corps, signature] = String(token).split(".");
  if (!corps || !signature) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(signerPlateforme(corps));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const charge = JSON.parse(Buffer.from(corps, "base64url").toString("utf8"));
    if (!charge?.plateforme || charge.id || typeof charge.exp !== "number" || charge.exp < Date.now()) return null;
    return charge;
  } catch {
    return null;
  }
}

function cookiePlateforme(valeur, maxAgeMs) {
  const parts = [`ce_plateforme=${valeur}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) parts.push("Secure");
  parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join("; ");
}

export function setPlatformCookie(res, token) {
  res.setHeader("Set-Cookie", cookiePlateforme(token, DUREE_SESSION_PLATEFORME_MS));
}

export function clearPlatformCookie(res) {
  res.setHeader("Set-Cookie", cookiePlateforme("", 0));
}

export function getPlatformCharge(req) {
  return readPlatformCharge(parseCookies(req).ce_plateforme || "");
}

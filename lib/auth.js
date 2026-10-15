/*
 * Authentification sans service externe : mots de passe hachés (scrypt,
 * bibliothèque standard Node) et sessions par cookie signé HMAC.
 * Aucun jeton ni mot de passe n'est stocké en clair.
 */
import crypto from "node:crypto";

// Valeur de secours réservée au MODE DÉMO LOCAL (PGlite, sans DATABASE_URL,
// hors production). LOT 8 : dès qu'une vraie base est branchée ou que
// VERCEL_ENV vaut production, elle n'est JAMAIS utilisée — SESSION_SECRET
// (32 caractères minimum) devient obligatoire, sinon connexions et routes
// authentifiées sont refusées avec une erreur claire.
const SECRET_DEV = "colisexpress-session-dev-secret";
const DUREE_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
export const LONGUEUR_MIN_SECRET_SESSION = 32;

export class ErreurConfigurationSession extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
    this.code = "SESSION_SECRET";
  }
}

/** Un SESSION_SECRET fort est-il exigé (vraie base ou production) ? */
export function secretSessionExige(env = process.env) {
  return Boolean(String(env.DATABASE_URL ?? "").trim()) || String(env.VERCEL_ENV ?? "").trim().toLowerCase() === "production";
}

/**
 * État du secret de session, sans jamais révéler sa valeur :
 * { ok, exige, longueur, raison }. Utilisé par le serveur (refus) et par le
 * panneau « Mise en service » de la console.
 */
export function etatSecretSession(env = process.env) {
  const valeur = String(env.SESSION_SECRET ?? "");
  const exige = secretSessionExige(env);
  const longueur = valeur.length;
  if (longueur >= LONGUEUR_MIN_SECRET_SESSION) return { ok: true, exige, longueur, raison: "SESSION_SECRET définie (32 caractères ou plus)." };
  if (!exige) {
    return { ok: true, exige, longueur, raison: "Mode démo local : secret de session de démonstration (aucune donnée réelle)." };
  }
  return {
    ok: false,
    exige,
    longueur,
    raison: longueur
      ? `SESSION_SECRET est trop courte (${longueur} caractères) : au moins ${LONGUEUR_MIN_SECRET_SESSION} caractères sont exigés. Connexions refusées tant qu'elle n'est pas corrigée dans Vercel.`
      : `SESSION_SECRET est absente : définissez-la dans Vercel (au moins ${LONGUEUR_MIN_SECRET_SESSION} caractères). Connexions refusées tant qu'elle n'est pas définie.`
  };
}

function secret() {
  const etat = etatSecretSession();
  if (!etat.ok) throw new ErreurConfigurationSession(etat.raison);
  if (etat.longueur >= LONGUEUR_MIN_SECRET_SESSION) return process.env.SESSION_SECRET;
  return process.env.SESSION_SECRET || SECRET_DEV;
}

/** Lève ErreurConfigurationSession si le secret exigé manque (routes authentifiées). */
export function verifierSecretSession() {
  secret();
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
  verifierSecretSession();
  return readSessionToken(parseCookies(req).ce_session || "");
}

/** Charge de session portée par la requête (agence + agent éventuel), ou null. */
export function getSessionCharge(req) {
  verifierSecretSession();
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
  verifierSecretSession();
  return readPlatformCharge(parseCookies(req).ce_plateforme || "");
}

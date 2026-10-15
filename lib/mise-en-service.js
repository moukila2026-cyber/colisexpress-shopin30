/*
 * Mise en service (LOT 9) — diagnostic en LECTURE SEULE pour la console
 * plateforme : une ligne par point de configuration, avec un état
 * (ok / attention / erreur) et l'action à faire.
 *
 * RÈGLE ABSOLUE : aucune valeur de secret n'est renvoyée, même partiellement
 * (ni clé SasPay, ni SESSION_SECRET, ni jeton Blob, ni DATABASE_URL). Seuls
 * sortent : présence / absence, longueur minimale atteinte, mode effectif,
 * et une empreinte courte NON réversible de l'hôte de la base (pour vérifier
 * que Preview et Production n'utilisent pas la même base).
 */
import crypto from "node:crypto";

import { query } from "../db/db.js";
import { etatSecretSession } from "./auth.js";
import { configurationNotifications } from "./notifications.js";
import { configurationPaiements, environnementVercel } from "./paiements.js";

export const SEUIL_ALERTE_QUOTA = 0.8;

/** Empreinte courte (10 hex) et non réversible de l'hôte d'une URL de base. */
export function empreinteHoteBase(databaseUrl) {
  const brut = String(databaseUrl ?? "").trim();
  if (!brut) return null;
  let hote = "";
  try {
    hote = new URL(brut).hostname.toLowerCase();
  } catch {
    return { hote: null, empreinte: null, lisible: false };
  }
  if (!hote) return { hote: null, empreinte: null, lisible: false };
  const empreinte = crypto.createHash("sha256").update(hote).digest("hex").slice(0, 10);
  const neon = /neon\.tech$/.test(hote);
  return { empreinte, lisible: true, neon, hoteFinal: hote.split(".").slice(-2).join(".") };
}

function ligne(cle, libelle, etat, detail, action = "") {
  return { cle, libelle, etat, detail, action };
}

/**
 * Diagnostic complet. `hoteRequete` : hôte (et protocole) vu par la requête
 * courante, pour comparer APP_URL. Rien d'autre que des booléens, des modes
 * et des libellés n'est renvoyé.
 */
export async function diagnosticMiseEnService({ env = process.env, hoteRequete = "", now = new Date() } = {}) {
  const vercel = environnementVercel(env);
  const production = vercel === "production";
  const preview = vercel === "preview";
  const surVercel = Boolean(vercel || env.VERCEL);
  const lignes = [];

  // 1. Environnement
  lignes.push(ligne(
    "environnement", "Environnement",
    "ok",
    vercel ? `Vercel — ${vercel === "production" ? "Production" : vercel === "preview" ? "Preview (préversion)" : "Development"}` : "Local (hors Vercel)",
    vercel ? "" : "Sur Vercel, VERCEL_ENV est définie automatiquement : rien à faire."
  ));

  // 2. Base de données
  const base = empreinteHoteBase(env.DATABASE_URL);
  if (!base) {
    lignes.push(ligne("base", "Base de données", surVercel ? "erreur" : "ok",
      surVercel ? "DATABASE_URL absente : aucune base branchée." : "Démo locale (PGlite en mémoire).",
      surVercel ? "Vercel → Settings → Environment Variables → DATABASE_URL (connection string Neon), distincte en Production et en Preview." : ""));
  } else if (!base.lisible) {
    lignes.push(ligne("base", "Base de données", "erreur", "DATABASE_URL illisible (format attendu : postgresql://…).", "Recopiez la connection string depuis Neon (bouton « Copy »)."));
  } else {
    lignes.push(ligne("base", "Base de données", "ok",
      `${base.neon ? "Neon" : "PostgreSQL"} — empreinte de l'hôte : ${base.empreinte}`,
      "Comparez cette empreinte entre Production et Preview : elle doit être DIFFÉRENTE (branche Neon « preview » séparée)."));
  }

  // 3. SESSION_SECRET
  const secret = etatSecretSession(env);
  lignes.push(ligne("session", "SESSION_SECRET", secret.ok ? (secret.exige ? "ok" : "attention") : "erreur",
    secret.ok ? (secret.exige ? "Présente, 32 caractères ou plus." : secret.raison) : secret.raison,
    secret.ok && secret.exige ? "" : "Vercel → Environment Variables → SESSION_SECRET (≥ 32 caractères, valeur différente en Production et en Preview). Générer : console du navigateur → crypto.randomUUID() + crypto.randomUUID()."));

  // 4. Vercel Blob
  const blob = Boolean(String(env.BLOB_READ_WRITE_TOKEN ?? "").trim());
  lignes.push(ligne("blob", "Photos et logos (Vercel Blob)", blob ? "ok" : surVercel ? "erreur" : "attention",
    blob ? "BLOB_READ_WRITE_TOKEN présente : stockage Vercel Blob actif." : surVercel ? "BLOB_READ_WRITE_TOKEN absente : le disque de Vercel est en lecture seule, les photos et logos échoueront." : "Absente : stockage sur le disque local (normal en démo).",
    blob ? "" : "Vercel → onglet Storage → Create → Blob → Connect to project (la variable est ajoutée à tous les environnements) → Redeploy."));

  // 5. Paiement
  const paiement = configurationPaiements(env);
  let etatPaiement = "ok";
  if (!paiement.actif) etatPaiement = production || paiement.erreur ? "erreur" : "attention";
  else if (production && paiement.mode !== "live") etatPaiement = "erreur";
  else if (preview && paiement.mode === "live") etatPaiement = "erreur";
  else if (preview && paiement.mode === "simulation") etatPaiement = "attention";
  lignes.push(ligne("paiement", "Paiement en ligne SasPay", etatPaiement,
    `Mode ${paiement.mode}${paiement.modeFrais ? ` · frais ${paiement.modeFrais}` : " · frais : réglage du compte SasPay"} — ${paiement.raison}`,
    etatPaiement === "ok" ? "" : production
      ? "Production : SASPAY_SECRET_KEY = clé sk_live_ (scope PAYIN ou BOTH), sans PAIEMENTS_SIMULATION."
      : "Preview : SASPAY_SECRET_KEY = clé sk_test_ (jamais sk_live_), ou PAIEMENTS_SIMULATION=1 pour une simulation."));

  // 6. Secret webhook
  const webhook = Boolean(String(env.SASPAY_WEBHOOK_SECRET ?? "").trim());
  lignes.push(ligne("webhook_secret", "SASPAY_WEBHOOK_SECRET", webhook ? "ok" : paiement.mode === "live" ? "erreur" : paiement.mode === "test" ? "attention" : "ok",
    webhook ? "Présente : les webhooks SasPay signés sont acceptés." : paiement.mode === "simulation" || paiement.mode === "desactive" ? "Absente (inutile tant qu'aucune clé SasPay n'est configurée)." : "Absente : les webhooks SasPay sont refusés (503), seule la vérification au retour du paiement fonctionne.",
    webhook ? "" : "Tableau de bord SasPay → Webhooks → créer l'URL …/api/paiements/webhook (transaction.success, failed, cancelled) → copier le secret affiché UNE seule fois → Vercel → SASPAY_WEBHOOK_SECRET."));

  // 7. APP_URL
  const appUrl = String(env.APP_URL ?? "").trim().replace(/\/+$/, "");
  const hote = String(hoteRequete ?? "").trim().replace(/\/+$/, "");
  if (production) {
    const egal = appUrl && hote && appUrl.toLowerCase() === hote.toLowerCase();
    lignes.push(ligne("app_url", "APP_URL", egal ? "ok" : appUrl ? "erreur" : "attention",
      egal ? `Égale à l'adresse du site (${hote}).` : appUrl ? `Différente de l'adresse de la requête (${hote || "inconnue"}) : le retour de paiement pointerait ailleurs.` : `Absente : l'adresse de la requête (${hote || "inconnue"}) est utilisée.`,
      egal ? "" : `Production : APP_URL = ${hote || "https://votre-domaine"} (sans barre finale).`));
  } else {
    lignes.push(ligne("app_url", "APP_URL", appUrl ? "attention" : "ok",
      appUrl ? "Définie hors production : le retour de paiement quitterait cet environnement." : `Vide : normal ${preview ? "en préversion (retour sur l'adresse de la préversion)" : "hors production"}.`,
      appUrl ? "Preview : laissez APP_URL vide (définie en Production seulement)." : ""));
  }

  // 8. Dernier webhook reçu
  const { rows: derniersWebhooks } = await query("SELECT evenement, recu_le_iso FROM paiements_webhooks ORDER BY created_at DESC LIMIT 1");
  const dernierWebhook = derniersWebhooks[0] ?? null;
  lignes.push(ligne("webhook_dernier", "Dernier webhook SasPay reçu", dernierWebhook ? "ok" : paiement.mode === "live" || paiement.mode === "test" ? "attention" : "ok",
    dernierWebhook ? `${dernierWebhook.evenement} le ${dernierWebhook.recu_le_iso}` : "Aucun webhook signé reçu pour l'instant.",
    dernierWebhook || !(paiement.mode === "live" || paiement.mode === "test") ? "" : "Tableau de bord SasPay → Webhooks → « Envoyer un test » (webhook.test), puis actualisez ce panneau. En Preview, la protection Vercel peut bloquer les webhooks : la vérification au retour du paiement suffit."));

  // 9. Notifications
  const notifications = configurationNotifications(env);
  lignes.push(ligne("notifications", "Notifications (canal effectif)", notifications.simulation ? (production ? "attention" : "ok") : "ok",
    `${notifications.simulation ? "Simulation" : `Envoi réel via ${notifications.canal}`} — ${notifications.raison}`,
    notifications.simulation && production ? "Envois réels WhatsApp / SMS : LOT 12 (variables WHATSAPP_* et ORANGE_SMS_*)." : ""));

  // 10. Tâche quotidienne (LOT 11)
  const cronSecret = String(env.CRON_SECRET ?? "").trim();
  const cron = cronSecret.length >= 32;
  const { rows: executions } = await query("SELECT demarree_le_iso, statut FROM taches_executions ORDER BY created_at DESC LIMIT 1");
  const derniere = executions[0] ?? null;
  const ageH = derniere ? (now.getTime() - new Date(derniere.demarree_le_iso).getTime()) / 36e5 : null;
  const cronOk = Boolean(cron && derniere && ageH !== null && ageH <= 48 && derniere.statut === "ok");
  lignes.push(ligne("cron", "Tâche quotidienne (Vercel Cron)",
    cronOk ? "ok" : production ? (cron ? "attention" : "erreur") : "attention",
    derniere ? `Dernière exécution le ${derniere.demarree_le_iso} (${derniere.statut}).` : cron ? "CRON_SECRET configurée, aucune exécution enregistrée pour l'instant (Vercel Cron tourne une fois par jour)." : cronSecret ? "CRON_SECRET est trop courte : 32 caractères minimum sont requis." : "CRON_SECRET absente : tâche désactivée.",
    cronOk ? "" : cron ? (derniere ? "Vérifiez Vercel → Settings → Cron Jobs, puis relancez la tâche depuis cette console." : "La tâche est prévue à 05:00 UTC chaque jour ; vous pouvez aussi la lancer depuis la console plateforme.") : "Vercel → Settings → Environment Variables → CRON_SECRET (32 caractères minimum, Production) — puis redeploy."));

  // 11. Agences Gratuit à ≥ 80 % du quota (période en cours)
  const cle = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
  const { rows: proches } = await query(
    `SELECT a.name, f.colis_comptes, f.quota FROM facturation_periodes f JOIN agencies a ON a.id = f.agency_id
     WHERE f.periode = $1 AND f.plan = 'gratuit' AND f.quota IS NOT NULL AND f.quota > 0
       AND f.colis_comptes >= CEIL(f.quota * $2::float)
     ORDER BY f.colis_comptes DESC LIMIT 20`,
    [cle, SEUIL_ALERTE_QUOTA]
  );
  lignes.push(ligne("quotas", "Agences au plan Gratuit proches du quota (≥ 80 %)", proches.length ? "attention" : "ok",
    proches.length ? proches.map((p) => `${p.name} : ${p.colis_comptes}/${p.quota}`).join(" · ") : "Aucune agence Gratuit à 80 % ou plus de son quota ce mois-ci.",
    proches.length ? "Proposez le plan Pro ou une recharge du portefeuille (30 FCFA par colis hors forfait)." : ""));

  const resume = {
    ok: lignes.filter((l) => l.etat === "ok").length,
    attention: lignes.filter((l) => l.etat === "attention").length,
    erreur: lignes.filter((l) => l.etat === "erreur").length
  };
  return { environnement: vercel ?? "local", production, genereLeISO: now.toISOString(), resume, lignes };
}

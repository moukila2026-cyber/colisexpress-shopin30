/*
 * Console plateforme (LOT 6) — vue d'ensemble en LECTURE SEULE pour l'équipe
 * Shopin30 : file des incidents ouverts depuis plus de 7 jours (filePlateforme
 * du LOT 4), litiges, agences (plan, compteur du mois, portefeuille,
 * abonnement) et volumes du réseau. Aucune écriture ici : consulter la console
 * n'ouvre aucune période et ne prélève rien. Les données clients (noms,
 * téléphones, CNI) ne sont pas projetées : seuls les codes de suivi, villes,
 * statuts et agences concernées apparaissent.
 */
import { query } from "../db/db.js";
import { escaladeIncident, libelleEtatIncident, libelleTypeIncident } from "../js/metier-incidents.js";
import { bornesPeriode, clePeriode, conditionsPlan, normaliserPeriode, resumeFacturation } from "../js/metier-plans.js";

function projectionIncident(row, now) {
  const escalade = escaladeIncident({ incident: { state: row.state, openedAtISO: row.opened_at_iso }, now });
  return {
    id: row.id,
    type: row.type,
    libelleType: libelleTypeIncident(row.type),
    state: row.state,
    libelleEtat: libelleEtatIncident(row.state),
    note: row.note ?? "",
    resolution: row.resolution ?? "",
    openedByName: row.opened_by_name ?? "",
    openedAtISO: row.opened_at_iso,
    resolvedAtISO: row.resolved_at_iso ?? null,
    heures: escalade.heures,
    jours: Math.floor(escalade.heures / 24),
    filePlateforme: escalade.filePlateforme,
    parcel: {
      id: row.parcel_id,
      trackingCode: row.tracking_code,
      status: row.parcel_status,
      originCity: row.origin_city,
      destinationCity: row.destination_city
    },
    expediteur: { id: row.owner_id, name: row.owner_agency_name },
    destination: row.destination_agency_id
      ? { id: row.destination_agency_id, name: row.destination_agency_name }
      : { id: null, name: `${row.destination_agency_name || "Agence"} (non inscrite)` }
  };
}

export async function vuePlateforme(now = new Date()) {
  const cle = clePeriode(now);
  const { debutISO } = bornesPeriode(cle);

  const { rows: agencesRows } = await query(
    `SELECT a.id, a.name, a.city, a.phone, a.email, a.created_at_iso, a.plan, a.plan_suivant,
            a.quota_negocie, a.prix_negocie_fcfa, a.portefeuille_fcfa,
            f.periode, f.plan AS periode_plan, f.quota, f.colis_comptes, f.colis_depassement,
            f.abonnement_fcfa, f.abonnement_statut, f.echeance_iso, f.paye_le_iso
     FROM agencies a
     LEFT JOIN facturation_periodes f ON f.agency_id = a.id AND f.periode = $1
     ORDER BY a.created_at_iso, a.id`,
    [cle]
  );
  const { rows: envoyes } = await query(
    `SELECT owner_id AS id, count(*)::int AS total, count(*) FILTER (WHERE created_at_iso >= $1)::int AS mois
     FROM parcels GROUP BY owner_id`,
    [debutISO]
  );
  const { rows: recus } = await query(
    `SELECT destination_agency_id AS id, count(*)::int AS total, count(*) FILTER (WHERE created_at_iso >= $1)::int AS mois
     FROM parcels WHERE destination_agency_id IS NOT NULL GROUP BY destination_agency_id`,
    [debutISO]
  );
  const { rows: ouverts } = await query(
    `SELECT p.owner_id, p.destination_agency_id FROM incidents i JOIN parcels p ON p.id = i.parcel_id WHERE i.state <> 'resolu'`
  );
  const parId = (rows) => new Map(rows.map((row) => [row.id, row]));
  const envoyesParId = parId(envoyes);
  const recusParId = parId(recus);

  const agences = agencesRows.map((row) => {
    const ouverte = Boolean(row.periode);
    // Période pas encore ouverte (aucune activité ce mois) : conditions du plan,
    // compteur à zéro — la console ne crée rien.
    const conditions = conditionsPlan({ plan: row.plan, quotaNegocie: row.quota_negocie, prixNegocieFCFA: row.prix_negocie_fcfa });
    const periode = normaliserPeriode(
      ouverte
        ? { ...row, plan: row.periode_plan }
        : { periode: cle, plan: conditions.plan, quota: conditions.quota, colis_comptes: 0, colis_depassement: 0, abonnement_fcfa: 0, abonnement_statut: "sans_frais" },
      now
    );
    const soldeFCFA = Number(row.portefeuille_fcfa ?? 0);
    return {
      id: row.id,
      name: row.name,
      city: row.city,
      phone: row.phone,
      email: row.email,
      createdAtISO: row.created_at_iso,
      plan: row.plan,
      planSuivant: row.plan_suivant ?? null,
      quotaNegocie: row.quota_negocie ?? null,
      prixNegocieFCFA: row.prix_negocie_fcfa ?? null,
      portefeuilleFCFA: soldeFCFA,
      periodeOuverte: ouverte,
      periode,
      resume: resumeFacturation({ periode, soldeFCFA }),
      volumes: {
        envoyesMois: envoyesParId.get(row.id)?.mois ?? 0,
        envoyesTotal: envoyesParId.get(row.id)?.total ?? 0,
        recusMois: recusParId.get(row.id)?.mois ?? 0,
        recusTotal: recusParId.get(row.id)?.total ?? 0
      },
      incidentsOuverts: ouverts.filter((i) => i.owner_id === row.id || i.destination_agency_id === row.id).length
    };
  });

  const { rows: parMois } = await query(
    `SELECT substring(created_at_iso from 1 for 7) AS periode, count(*)::int AS colis
     FROM parcels GROUP BY 1 ORDER BY 1 DESC LIMIT 6`
  );
  const { rows: parStatut } = await query("SELECT status, count(*)::int AS colis FROM parcels GROUP BY status ORDER BY 2 DESC");

  const { rows: incidentsRows } = await query(
    `SELECT i.*, p.tracking_code, p.status AS parcel_status, p.origin_city, p.destination_city,
            p.owner_id, p.owner_agency_name, p.destination_agency_id, p.destination_agency_name
     FROM incidents i JOIN parcels p ON p.id = i.parcel_id
     WHERE i.state <> 'resolu' OR i.type = 'conteste'
     ORDER BY i.opened_at_iso, i.id`
  );
  const incidents = incidentsRows.map((row) => projectionIncident(row, now));
  const fileIncidents = incidents.filter((incident) => incident.filePlateforme);
  const litiges = incidents
    .filter((incident) => incident.type === "conteste")
    .sort((a, b) => Number(a.state === "resolu") - Number(b.state === "resolu"));

  return {
    periode: cle,
    indicateurs: {
      agences: agences.length,
      colisMois: agences.reduce((somme, agence) => somme + agence.volumes.envoyesMois, 0),
      colisTotal: agences.reduce((somme, agence) => somme + agence.volumes.envoyesTotal, 0),
      incidentsFile: fileIncidents.length,
      litigesOuverts: litiges.filter((incident) => incident.state !== "resolu").length,
      abonnementsDus: agences.filter((agence) => agence.periode.abonnement.statut === "du").length,
      abonnementsEnRetard: agences.filter((agence) => agence.periode.abonnement.enRetard).length,
      portefeuillesFCFA: agences.reduce((somme, agence) => somme + agence.portefeuilleFCFA, 0)
    },
    agences,
    volumes: { parMois, parStatut },
    fileIncidents,
    litiges
  };
}

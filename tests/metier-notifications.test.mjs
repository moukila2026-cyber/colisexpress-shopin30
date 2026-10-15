/*
 * Tests des notifications (LOT 5) : js/metier-notifications.js (messages sans
 * donnée personnelle, destinataires = les deux agences, dédoublonnage,
 * échéances) et sélection du canal de lib/notifications.js (simulation par
 * défaut, aucun envoi réel sans transport branché ET configuré).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FAMILLES_NOTIFICATION,
  TYPES_NOTIFICATION,
  agencesConcernees,
  cleNotification,
  construireNotification,
  destinatairesNotification,
  estFamilleNotification,
  estTypeNotification,
  evenementsEcheance,
  familleNotification,
  filtrerNotifications,
  libelleTypeNotification,
  niveauRappelAbonnement,
  normaliserNotification,
  notificationsPourAgences,
  resumeNotifications
} from "../js/metier-notifications.js";

process.env.SEED_DEMO = "0";
const { TRANSPORTS, configurationNotifications } = await import("../lib/notifications.js");

const NOW = new Date("2026-10-15T12:00:00.000Z");
const heures = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** Colis truffé de données personnelles : aucune ne doit ressortir d'un message. */
function colis(overrides = {}) {
  return {
    id: "p1",
    trackingCode: "CLI-NOTIF1",
    ownerId: "A",
    destinationAgencyId: "B",
    ownerAgencyName: "Agence Alpha",
    destinationAgencyName: "Agence Bêta",
    originCity: "Abidjan",
    destinationCity: "Bouaké",
    status: "En transit",
    sender: { firstName: "Awa", lastName: "Traoré", phone: "0700000001", cni: "CI12345678" },
    recipient: { firstName: "Ibrahim", lastName: "Koné", phone: "0500000002" },
    collectedBy: { name: "Moussa Diallo", cni: "CI99999999" },
    history: [{ status: "Enregistré", date: heures(200), actorId: "agent-1", actorName: "Koffi N'Guessan" }],
    createdAtISO: heures(200),
    updatedAtISO: heures(1),
    ...overrides
  };
}

const bordereau = {
  id: "b1",
  code: "BDR-NOTIF1",
  fromAgencyId: "A",
  toAgencyId: "B",
  fromCity: "Abidjan",
  toCity: "Bouaké",
  parcelCount: 3,
  carrierName: "Moussa Transport",
  carrierPhone: "0700000055",
  handedOverBy: "Koffi N'Guessan",
  checkedBy: "Aïcha Touré"
};

const incident = {
  id: "i1",
  type: "retard",
  state: "ouvert",
  note: "M. Koné a appelé trois fois au 0500000002, très mécontent.",
  openedByName: "Aïcha Touré",
  openedAtISO: heures(2)
};

const DONNEES_PERSONNELLES = [
  "Awa", "Traoré", "0700000001", "CI12345678", "Ibrahim", "Koné", "0500000002",
  "Moussa", "CI99999999", "Koffi", "Aïcha", "0700000055", "mécontent"
];

function sansDonneePersonnelle(valeur, contexte) {
  const brut = JSON.stringify(valeur);
  for (const sensible of DONNEES_PERSONNELLES) {
    assert.ok(!brut.includes(sensible), `${contexte} : « ${sensible} » ne doit jamais figurer dans une notification`);
  }
}

test("catalogue : types d'événements rangés en 5 familles, libellés français", () => {
  assert.equal(TYPES_NOTIFICATION.length, 13);
  for (const type of [
    "incident_ouvert", "incident_escalade", "bordereau_arrive", "bordereau_ecart", "colis_souffrance",
    "retour_decide", "retour_recu", "alerte_sans_mouvement", "alerte_non_retire", "alerte_non_rattache",
    "abonnement_jmoins2", "abonnement_echeance", "abonnement_retard"
  ]) {
    assert.ok(estTypeNotification(type), `${type} doit être un type connu`);
    assert.ok(estFamilleNotification(familleNotification(type)), `${type} doit appartenir à une famille`);
    assert.notEqual(libelleTypeNotification(type), type, `${type} doit avoir un libellé français`);
  }
  assert.equal(estTypeNotification("suppression"), false);
  assert.deepEqual(FAMILLES_NOTIFICATION.map((f) => f.id), ["incidents", "bordereaux", "souffrance", "dorment", "facturation"]);
});

test("destinataires : les deux agences concernées, sans doublon ni valeur vide", () => {
  assert.deepEqual(destinatairesNotification("A", "B"), ["A", "B"]);
  assert.deepEqual(destinatairesNotification("A", null), ["A"], "destination non rattachée : l'expéditrice seule");
  assert.deepEqual(destinatairesNotification(["A", "A", "", undefined]), ["A"]);
  assert.deepEqual(agencesConcernees({ parcel: colis() }), ["A", "B"]);
  assert.deepEqual(agencesConcernees({ parcel: colis({ destinationAgencyId: null }) }), ["A"]);
  assert.deepEqual(agencesConcernees({ bordereau }), ["A", "B"]);
  assert.deepEqual(agencesConcernees({ bordereau: { ...bordereau, toAgencyId: null } }), ["A"]);
  assert.deepEqual(agencesConcernees({}), [], "aucun destinataire extérieur");
});

test("chaque type construit un message français avec code, trajet et lien interne", () => {
  const cas = [
    [{ type: "incident_ouvert", parcel: colis(), incident }, /Retard.*CLI-NOTIF1.*Abidjan → Bouaké/, "colis.html?id=p1"],
    [{ type: "incident_ouvert", parcel: colis(), incident: { id: "i2", type: "perdu", automatique: true }, bordereau }, /automatiquement.*CLI-NOTIF1.*BDR-NOTIF1/, "colis.html?id=p1"],
    [{ type: "incident_escalade", parcel: colis(), incident, heures: 50 }, /ouvert depuis 2 jours/, "colis.html?id=p1"],
    [{ type: "bordereau_arrive", bordereau }, /BDR-NOTIF1 \(Abidjan → Bouaké, 3 colis\) est arrivé/, "bordereaux.html?id=b1"],
    [{ type: "bordereau_ecart", bordereau, absents: ["CLI-ABS001"] }, /1 colis absent sur 3 \(CLI-ABS001\)/, "bordereaux.html?id=b1"],
    [{ type: "colis_souffrance", parcel: colis(), jours: 9 }, /depuis 9 jours sans être retiré/, "colis.html?id=p1"],
    [{ type: "retour_decide", parcel: colis() }, /retour à l'expéditeur du colis CLI-NOTIF1/i, "colis.html?id=p1"],
    [{ type: "retour_recu", parcel: colis() }, /revenu à l'agence expéditrice/, "colis.html?id=p1"],
    [{ type: "alerte_sans_mouvement", parcel: colis(), heures: 60 }, /« En transit » sans mouvement depuis plus de 48 h/, "colis.html?id=p1"],
    [{ type: "alerte_non_retire", parcel: colis(), heures: 80 }, /retrait depuis plus de 72 h/, "colis.html?id=p1"],
    [{ type: "alerte_non_rattache", parcel: colis({ destinationAgencyId: null }), jours: 8 }, /vers Bouaké.*après 8 jours/, "colis.html?id=p1"],
    [{ type: "abonnement_jmoins2", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-17T05:00:00.000Z" }, /10 000 FCFA.*dans deux jours/, "abonnement.html"],
    [{ type: "abonnement_echeance", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-15T05:00:00.000Z" }, /arrive à échéance aujourd'hui/, "abonnement.html"],
    [{ type: "abonnement_retard", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-14T05:00:00.000Z" }, /reste à régler/, "abonnement.html"]
  ];
  for (const [evenement, attendu, lien] of cas) {
    const notification = construireNotification(evenement);
    assert.ok(notification, `${evenement.type} doit produire une notification`);
    assert.match(notification.message, attendu, `${evenement.type} : message inattendu « ${notification.message} »`);
    assert.ok(notification.titre.length > 5);
    assert.equal(notification.lien, lien);
    assert.equal(notification.type, evenement.type);
  }
});

test("aucune donnée personnelle ne sort : ni client, ni agent, ni note libre, ni téléphone du transporteur", () => {
  const evenements = [
    { type: "incident_ouvert", parcel: colis(), incident },
    { type: "incident_ouvert", parcel: colis(), incident: { ...incident, automatique: true }, bordereau },
    { type: "incident_escalade", parcel: colis(), incident, heures: 30 },
    { type: "bordereau_arrive", bordereau },
    { type: "bordereau_ecart", bordereau, absents: ["CLI-ABS001", "CLI-ABS002"] },
    { type: "colis_souffrance", parcel: colis(), jours: 8 },
    { type: "retour_decide", parcel: colis() },
    { type: "retour_recu", parcel: colis() },
    { type: "alerte_sans_mouvement", parcel: colis(), heures: 50 },
    { type: "alerte_non_retire", parcel: colis(), heures: 80 },
    { type: "alerte_non_rattache", parcel: colis({ destinationAgencyId: null }), jours: 8 },
    { type: "abonnement_jmoins2", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-17T05:00:00.000Z" },
    { type: "abonnement_echeance", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-15T05:00:00.000Z" },
    { type: "abonnement_retard", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-14T05:00:00.000Z" }
  ];
  for (const evenement of evenements) {
    for (const notification of notificationsPourAgences(evenement, evenement.agencyId ? [evenement.agencyId] : null)) {
      sansDonneePersonnelle(notification, evenement.type);
      assert.deepEqual(
        Object.keys(notification).sort(),
        ["agencyId", "bordereauId", "cle", "incidentId", "lien", "message", "parcelId", "refId", "titre", "type"],
        "projection stricte : aucun champ recopié de l'entrée"
      );
    }
  }
});

test("événement incomplet ou inconnu : aucune notification (l'appelant n'échoue jamais)", () => {
  assert.equal(construireNotification({ type: "inconnu", parcel: colis() }), null);
  assert.equal(construireNotification({ type: "retour_decide" }), null, "colis manquant");
  assert.equal(construireNotification({ type: "bordereau_arrive", parcel: colis() }), null, "bordereau manquant");
  assert.equal(construireNotification({ type: "incident_ouvert", parcel: colis() }), null, "incident manquant");
  assert.deepEqual(notificationsPourAgences({ type: "retour_recu" }), []);
});

test("rappels d'abonnement : J-2, échéance le jour J, puis retard dédoublonné", () => {
  assert.deepEqual(niveauRappelAbonnement({ echeanceISO: "2026-10-17T05:00:00.000Z", now: NOW }), { type: "abonnement_jmoins2", joursRestants: 2 });
  assert.deepEqual(niveauRappelAbonnement({ echeanceISO: "2026-10-15T05:00:00.000Z", now: NOW }), { type: "abonnement_echeance", joursRestants: 0 });
  assert.deepEqual(niveauRappelAbonnement({ echeanceISO: "2026-10-14T05:00:00.000Z", now: NOW }), { type: "abonnement_retard", joursRestants: -1 });
  assert.equal(niveauRappelAbonnement({ echeanceISO: "2026-10-20T00:00:00.000Z", now: NOW }), null, "aucun rappel avant J-2");
  assert.equal(niveauRappelAbonnement({ echeanceISO: "invalid", now: NOW }), null, "date invalide ignorée");

  const evenement = { type: "abonnement_retard", agencyId: "A", periode: "2026-10", plan: "pro", montantFCFA: 10000, echeanceISO: "2026-10-14T05:00:00.000Z" };
  const [a] = notificationsPourAgences(evenement, ["A"]);
  assert.equal(a.refId, "A:2026-10");
  assert.equal(a.cle, cleNotification({ type: "abonnement_retard", refId: "A:2026-10", agencyId: "A" }));
  assert.equal(notificationsPourAgences({ ...evenement, agencyId: "" }, ["A"]).length, 0);
});

test("dédoublonnage : une clé par événement, par agence et par épisode", () => {
  const [pourA, pourB] = notificationsPourAgences({ type: "retour_decide", parcel: colis() });
  assert.equal(pourA.agencyId, "A");
  assert.equal(pourB.agencyId, "B");
  assert.notEqual(pourA.cle, pourB.cle, "chaque agence a sa propre clé");
  assert.equal(pourA.cle, cleNotification({ type: "retour_decide", refId: "p1", agencyId: "A" }));

  const episode1 = notificationsPourAgences({ type: "alerte_sans_mouvement", parcel: colis(), depuis: heures(60) }, ["A"])[0];
  const episode2 = notificationsPourAgences({ type: "alerte_sans_mouvement", parcel: colis(), depuis: heures(10) }, ["A"])[0];
  assert.notEqual(episode1.cle, episode2.cle, "un colis qui redort après avoir bougé est renotifié");

  const incidentA = notificationsPourAgences({ type: "incident_escalade", parcel: colis(), incident, heures: 30 }, ["A"])[0];
  assert.equal(incidentA.refId, "i1", "l'escalade se rattache à l'incident (une seule fois)");
});

test("échéances : escalade > 24 h, souffrance > 7 j, colis qui dorment 48 h / 72 h / 7 j", () => {
  const arrive = (h) => colis({
    id: `arr-${h}`, trackingCode: `CLI-ARR${h}`, status: "Arrivé à l'agence de destination",
    history: [{ status: "Arrivé à l'agence de destination", date: heures(h) }], updatedAtISO: heures(h)
  });
  const parcels = [
    colis({ id: "dort", trackingCode: "CLI-DORT01", status: "Expédié", updatedAtISO: heures(50) }),
    colis({ id: "frais", trackingCode: "CLI-FRAIS1", status: "En transit", updatedAtISO: heures(5) }),
    arrive(80),
    arrive(200),
    colis({ id: "seul", trackingCode: "CLI-SEUL01", status: "Enregistré", destinationAgencyId: null, createdAtISO: heures(24 * 8), updatedAtISO: heures(24 * 8) })
  ];
  const incidents = [
    { ...incident, id: "vieux", parcelId: "frais", openedAtISO: heures(30) },
    { ...incident, id: "recent", parcelId: "dort", openedAtISO: heures(3) },
    { ...incident, id: "clos", parcelId: "dort", state: "resolu", openedAtISO: heures(300) }
  ];
  const evenements = evenementsEcheance({ parcels, incidents, now: NOW });
  const types = (id) => evenements.filter((e) => e.parcel.id === id).map((e) => e.type).sort();

  assert.deepEqual(types("dort"), ["alerte_sans_mouvement"]);
  assert.deepEqual(types("frais"), ["incident_escalade"], "seul l'incident ouvert depuis 30 h escalade");
  assert.deepEqual(types("arr-80"), ["alerte_non_retire"]);
  assert.deepEqual(types("arr-200"), ["alerte_non_retire", "colis_souffrance"]);
  assert.deepEqual(types("seul"), ["alerte_non_rattache"]);

  for (const evenement of evenements) {
    const attendu = evenement.parcel.destinationAgencyId ? ["A", "B"] : ["A"];
    assert.deepEqual(evenement.agences, attendu, "les deux agences concernées (une seule si non rattachée)");
  }
  const souffrance = evenements.find((e) => e.type === "colis_souffrance");
  assert.equal(souffrance.depuis, heures(200), "épisode daté par l'arrivée");
  assert.equal(souffrance.jours, 8);
  assert.deepEqual(evenementsEcheance({ parcels: [], incidents, now: NOW }), [], "incident orphelin ignoré");
});

test("journal : normalisation sans clé interne, filtres et compteurs", () => {
  const ligne = {
    id: "n1", agency_id: "A", type: "bordereau_ecart", titre: "Écart", message: "…", lien: "bordereaux.html?id=b1",
    parcel_id: null, bordereau_id: "b1", incident_id: null, canal: "simulation", statut: "simule",
    erreur: "", dedup_key: "bordereau_ecart:b1:A", lu: false, created_at_iso: NOW.toISOString()
  };
  const notification = normaliserNotification(ligne);
  assert.equal(notification.famille, "bordereaux");
  assert.equal(notification.lu, false);
  assert.equal("dedup_key" in notification || "cle" in notification, false, "la clé de dédoublonnage reste interne");
  assert.equal("agencyId" in notification, false);

  const liste = [
    notification,
    normaliserNotification({ ...ligne, id: "n2", type: "retour_recu", lu: true }),
    normaliserNotification({ ...ligne, id: "n3", type: "alerte_non_retire" })
  ];
  assert.deepEqual(filtrerNotifications({ notifications: liste, famille: "souffrance" }).map((n) => n.id), ["n2"]);
  assert.deepEqual(filtrerNotifications({ notifications: liste, nonLuesSeulement: true }).map((n) => n.id), ["n1", "n3"]);
  const resume = resumeNotifications(liste);
  assert.equal(resume.total, 3);
  assert.equal(resume.nonLues, 2);
  assert.deepEqual(resume.parFamille, { incidents: 0, bordereaux: 1, souffrance: 1, dorment: 1, facturation: 0 });
});

test("canal : simulation par défaut, aucun envoi réel sans transport branché ET configuré", () => {
  assert.equal(configurationNotifications({}).canal, "simulation");
  assert.equal(configurationNotifications({}).simulation, true);
  assert.equal(configurationNotifications({ NOTIFICATIONS_CANAL: "SMS" }).canal, "simulation", "transport pas encore branché");
  assert.equal(configurationNotifications({ NOTIFICATIONS_CANAL: "pigeon" }).canal, "simulation", "canal inconnu");
  assert.equal(configurationNotifications({ NOTIFICATIONS_CANAL: "rm -rf /;" }).demande, "inconnu", "valeur illisible jamais renvoyée");
  for (const canal of ["whatsapp", "sms", "email"]) {
    assert.equal(TRANSPORTS[canal].envoyer, null, `${canal} : point de branchement prévu, aucun envoi réel dans ce lot`);
    assert.ok(TRANSPORTS[canal].variables.length > 0, `${canal} : variables d'environnement documentées`);
  }

  // Un transport branché mais non configuré reste en simulation ; configuré, il devient effectif.
  const branche = { ...TRANSPORTS, whatsapp: { ...TRANSPORTS.whatsapp, envoyer: async () => ({ statut: "envoye" }) } };
  assert.equal(configurationNotifications({ NOTIFICATIONS_CANAL: "whatsapp" }, branche).canal, "simulation");
  const secret = "jeton-ultra-secret-123";
  const actif = configurationNotifications({ NOTIFICATIONS_CANAL: "whatsapp", WHATSAPP_API_URL: "https://exemple.invalid", WHATSAPP_API_TOKEN: secret }, branche);
  assert.equal(actif.canal, "whatsapp");
  assert.equal(actif.simulation, false);
  assert.ok(!JSON.stringify(actif).includes(secret), "la configuration ne renvoie jamais de secret");
});

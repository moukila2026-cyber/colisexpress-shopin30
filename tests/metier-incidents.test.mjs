/*
 * Tests des incidents (LOT 4) : js/metier-incidents.js — ouverture,
 * transitions d'état, escalade (24 h / 7 jours) et bandeau du suivi public.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BANDEAU_PUBLIC_INCIDENT,
  SEUIL_ALERTE_24H,
  SEUIL_FILE_PLATEFORME_JOURS,
  bandeauPublicIncident,
  escaladeIncident,
  estTypeIncident,
  libelleEtatIncident,
  libelleTypeIncident,
  normaliserIncident,
  validerOuvertureIncident,
  validerTransitionIncident
} from "../js/metier-incidents.js";

test("ouverture d'un incident : types imposés, note obligatoire", () => {
  for (const type of ["perdu", "endommage", "retard", "conteste", "bloque"]) {
    assert.equal(validerOuvertureIncident({ type, note: "colis introuvable au dépotage" }).error, undefined, type);
    assert.ok(estTypeIncident(type));
  }
  assert.match(validerOuvertureIncident({ type: "vole", note: "x" }).error, /type d'incident/);
  assert.match(validerOuvertureIncident({ type: "perdu", note: "" }).error, /Décrivez/);
  assert.match(validerOuvertureIncident({ type: "perdu", note: "x".repeat(2001) }).error, /2000/);
  assert.equal(libelleTypeIncident("endommage"), "Endommagé");
  assert.equal(libelleEtatIncident("recherches"), "En recherches");
});

test("transitions : ouvert → recherches → résolu, résolu immuable, jamais retour à ouvert", () => {
  const ouvert = { state: "ouvert" };
  assert.equal(validerTransitionIncident({ incident: ouvert, state: "recherches" }).valeur.state, "recherches");
  assert.equal(validerTransitionIncident({ incident: ouvert, state: "resolu", resolution: "retrouvé" }).valeur.state, "resolu");
  assert.match(validerTransitionIncident({ incident: ouvert, state: "resolu", resolution: "" }).error, /Expliquez/);
  assert.match(validerTransitionIncident({ incident: ouvert, state: "ouvert" }).error, /ne revient jamais/);
  assert.match(validerTransitionIncident({ incident: ouvert, state: "cloture" }).error, /état valide/);
  assert.match(validerTransitionIncident({ incident: { state: "resolu" }, state: "recherches" }).error, /déjà résolu/);
  assert.match(validerTransitionIncident({ incident: null, state: "recherches" }).error, /introuvable/);
});

test("escalade : rien sous 24 h, alerte entre 24 h et 7 j, file plateforme au-delà", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const heures = (h) => ({ state: "ouvert", openedAtISO: new Date(now.getTime() - h * 3_600_000).toISOString() });

  const recent = escaladeIncident({ incident: heures(23), now });
  assert.deepEqual(recent, { heures: 23, alerte24h: false, filePlateforme: false });

  const unJour = escaladeIncident({ incident: heures(25), now });
  assert.equal(unJour.alerte24h, true);
  assert.equal(unJour.filePlateforme, false);

  const huitJours = escaladeIncident({ incident: heures(8 * 24), now });
  assert.equal(huitJours.alerte24h, true);
  assert.equal(huitJours.filePlateforme, true);

  // Résolu ou en recherches depuis longtemps : aucune escalade sur un résolu.
  assert.deepEqual(escaladeIncident({ incident: { state: "resolu", openedAtISO: heures(720).openedAtISO }, now }), { heures: 0, alerte24h: false, filePlateforme: false });
  assert.equal(escaladeIncident({ incident: { state: "recherches", openedAtISO: heures(30).openedAtISO }, now }).alerte24h, true);

  assert.equal(SEUIL_ALERTE_24H, 24);
  assert.equal(SEUIL_FILE_PLATEFORME_JOURS, 7);
});

test("le bandeau public est sobre, fixe, et tombe dès la résolution", () => {
  assert.equal(bandeauPublicIncident([{ state: "ouvert" }]), BANDEAU_PUBLIC_INCIDENT);
  assert.equal(bandeauPublicIncident([{ state: "recherches" }]), BANDEAU_PUBLIC_INCIDENT);
  assert.equal(bandeauPublicIncident([{ state: "resolu" }]), null);
  assert.equal(bandeauPublicIncident([{ state: "resolu" }, { state: "ouvert" }]), BANDEAU_PUBLIC_INCIDENT);
  assert.equal(bandeauPublicIncident([]), null);
  // Aucune fuite de détail privé dans le bandeau.
  assert.ok(!/perdu|endommagé|agence|note/i.test(BANDEAU_PUBLIC_INCIDENT));
});

test("normaliserIncident remonte l'escalade calculée", () => {
  const incident = normaliserIncident({
    id: "i1", parcel_id: "p1", bordereau_id: null, type: "perdu", state: "ouvert",
    note: "absent du bordereau", resolution: "", opened_by_agency_id: "A",
    opened_by_id: "m1", opened_by_name: "Koffi", opened_at_iso: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    updated_by_name: "", resolved_at_iso: null
  });
  assert.equal(incident.parcelId, "p1");
  assert.equal(incident.openedByName, "Koffi");
  assert.equal(incident.alerte24h, true);
  assert.equal(incident.filePlateforme, false);
});

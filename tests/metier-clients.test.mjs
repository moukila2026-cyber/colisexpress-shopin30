/*
 * Tests du carnet de clients (LOT 3) : js/metier-clients.js — validation,
 * normalisation, mémorisation automatique depuis un colis et recherche.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  clientsDepuisColis,
  estTypeClient,
  nomClient,
  normaliserClient,
  rechercherClients,
  validerClient
} from "../js/metier-clients.js";

test("validerClient accepte une fiche valide et normalise le téléphone", () => {
  const res = validerClient({
    kind: "expediteur",
    firstName: " Awa ",
    lastName: "Traoré",
    phone: "+225 07-00-00-00-01",
    cni: "ci12345678",
    city: "Abidjan",
    notes: "préfère le matin"
  });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.valeur, {
    kind: "expediteur",
    firstName: "Awa",
    lastName: "Traoré",
    phone: "0700000001",
    cni: "CI12345678",
    city: "Abidjan",
    notes: "préfère le matin"
  });
});

test("validerClient refuse les fiches mal formées", () => {
  assert.match(validerClient({ kind: "inconnu", firstName: "A", lastName: "B", phone: "0700000001" }).error, /rôle/i);
  assert.match(validerClient({ kind: "expediteur", firstName: "", lastName: "B", phone: "0700000001" }).error, /prénom/i);
  assert.match(validerClient({ kind: "expediteur", firstName: "A", lastName: "B", phone: "123" }).error, /téléphone/i);
  assert.match(validerClient({ kind: "expediteur", firstName: "A", lastName: "B", phone: "0700000001", cni: "court" }).error, /CNI/);
  assert.match(validerClient({ kind: "expediteur", firstName: "A", lastName: "B", phone: "0700000001", city: "x".repeat(61) }).error, /ville/i);
  assert.match(validerClient({ kind: "expediteur", firstName: "A", lastName: "B", phone: "0700000001", notes: "x".repeat(501) }).error, /note/i);
  assert.ok(estTypeClient("destinataire") && !estTypeClient("autre"));
});

test("la CNI d'un destinataire est ignorée (jamais mémorisée)", () => {
  const res = validerClient({ kind: "destinataire", firstName: "Ibrahim", lastName: "Koné", phone: "0500000002", cni: "CI12345678" });
  assert.equal(res.error, undefined);
  assert.equal(res.valeur.cni, null);
});

test("normaliserClient et nomClient", () => {
  const client = normaliserClient({
    id: "c1",
    agency_id: "a1",
    kind: "expediteur",
    first_name: "Awa",
    last_name: "Traoré",
    phone: "0700000001",
    cni: "ci12345678",
    city: "Abidjan",
    notes: "",
    created_at_iso: "2026-01-01T00:00:00.000Z",
    updated_at_iso: "2026-01-02T00:00:00.000Z"
  });
  assert.equal(client.phone, "0700000001");
  assert.equal(client.cni, "CI12345678");
  assert.equal(nomClient(client), "Awa Traoré");
});

test("clientsDepuisColis mémorise l'expéditeur (avec CNI) et le destinataire", () => {
  const fiches = clientsDepuisColis({
    sender: { firstName: "Awa", lastName: "Traoré", phone: "0700000001", cni: "CI12345678" },
    recipient: { firstName: "Ibrahim", lastName: "Koné", phone: "0500000002" },
    originCity: "Abidjan",
    destinationCity: "Bouaké"
  });
  assert.equal(fiches.length, 2);
  const [expediteur, destinataire] = fiches;
  assert.deepEqual(expediteur, { kind: "expediteur", firstName: "Awa", lastName: "Traoré", phone: "0700000001", cni: "CI12345678", city: "Abidjan", notes: "" });
  assert.deepEqual(destinataire, { kind: "destinataire", firstName: "Ibrahim", lastName: "Koné", phone: "0500000002", cni: null, city: "Bouaké", notes: "" });

  // Téléphone invalide ou nom manquant : la fiche est écartée, jamais erronée.
  assert.equal(clientsDepuisColis({ sender: { firstName: "X", lastName: "Y", phone: "123" }, recipient: {} }).length, 0);
  assert.equal(clientsDepuisColis({}).length, 0);
});

test("rechercherClients : par téléphone (même partiel) et par nom, filtré par rôle", () => {
  const clients = [
    { id: "1", kind: "expediteur", firstName: "Awa", lastName: "Traoré", phone: "0700000001" },
    { id: "2", kind: "destinataire", firstName: "Ibrahim", lastName: "Koné", phone: "0500000002" },
    { id: "3", kind: "expediteur", firstName: "Mariam", lastName: "Diarra", phone: "0700000021" }
  ].map((client) => ({ ...client, city: "", notes: "", cni: null }));

  assert.equal(rechercherClients({ clients }).length, 3, "sans filtre : tout le carnet, trié par nom");
  assert.deepEqual(rechercherClients({ clients }).map((c) => c.id), ["1", "2", "3"]);
  assert.deepEqual(rechercherClients({ clients, recherche: "0500000002" }).map((c) => c.id), ["2"]);
  assert.deepEqual(rechercherClients({ clients, recherche: "07 00 00 00 21" }).map((c) => c.id), ["3"], "les espaces du téléphone sont ignorés");
  assert.deepEqual(rechercherClients({ clients, recherche: "000021" }).map((c) => c.id), ["3"], "recherche partielle sur les chiffres");
  assert.deepEqual(rechercherClients({ clients, recherche: "traore" }).map((c) => c.id), ["1"], "insensible à la casse et aux accents");
  assert.deepEqual(rechercherClients({ clients, kind: "expediteur" }).map((c) => c.id), ["1", "3"]);
  assert.deepEqual(rechercherClients({ clients, recherche: "0700000001", kind: "destinataire" }).map((c) => c.id), []);
});

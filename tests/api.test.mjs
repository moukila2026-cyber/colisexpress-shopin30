/*
 * Tests d'intégration de l'API COLIS EXPRESS (lib/app.js) sur Postgres :
 * PGlite (Postgres WASM) en base de test — mêmes requêtes SQL qu'en production.
 *
 * Couverture : session, inscription, création de colis (inscrit / non inscrite /
 * invalide), visibilité entre agences, suivi public sans données personnelles,
 * rattachement unique, progression des statuts, et refus d'accès.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.SEED_DEMO = "0";
delete process.env.DATABASE_URL;
// Photos de preuve : backend disque local dans un dossier temporaire.
process.env.PHOTOS_DIR = mkdtempSync(path.join(tmpdir(), "colis-photos-"));

const { buildApp } = await import("../lib/app.js");
const { query } = await import("../db/db.js");

const app = buildApp();
const server = app.listen(0);
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

function client() {
  let cookie = null;
  return {
    async call(method, path, body) {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
    get(path) { return this.call("GET", path); },
    post(path, body) { return this.call("POST", path, body ?? {}); },
    patch(path, body) { return this.call("PATCH", path, body); },
    async brut(urlPath) {
      const headers = cookie ? { Cookie: cookie } : {};
      const res = await fetch(`${BASE}${urlPath}`, { headers });
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, contentType: res.headers.get("content-type"), buffer };
    },
    deconnexion() { cookie = null; }
  };
}

let compteur = 0;
function compteUnique(prefixe) {
  compteur += 1;
  return `${prefixe}${compteur}@test.ci`;
}

async function creerAgence(clientHttp, nom, ville) {
  const res = await clientHttp.post("/api/register", {
    name: nom,
    city: ville,
    phone: "0700000001",
    email: compteUnique(nom.toLowerCase().replace(/\W/g, "")),
    password: "secret12"
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.agency;
}

function valeurs(colis) {
  return {
    senderFirstName: "Awa",
    senderLastName: "Traore",
    senderPhone: "0700000001",
    senderCni: "ci12345678",
    recipientFirstName: "Ibrahim",
    recipientLastName: "Kone",
    recipientPhone: "0500000002",
    packageNature: "Vêtements",
    weightKg: "2.5",
    priceFCFA: "3500",
    originCity: "Abidjan",
    destinationCity: "Bouaké",
    ...colis
  };
}

/* ----------------------------- session / compte ---------------------------- */

test("inscription, profil, déconnexion et reconnexion", async () => {
  const c = client();
  const agency = await creerAgence(c, "Agence Session", "Abidjan");
  assert.equal(agency.name, "Agence Session");

  const moi = await c.get("/api/me");
  assert.equal(moi.status, 200);
  assert.equal(moi.data.agency.id, agency.id);

  const modif = await c.patch("/api/me", { name: "Agence Session 2", city: "Bouaké", phone: "0500000002" });
  assert.equal(modif.status, 200);
  assert.equal(modif.data.agency.name, "Agence Session 2");

  await c.post("/api/logout");
  c.deconnexion();
  assert.equal((await c.get("/api/me")).status, 401);

  const reconnexion = await c.post("/api/login", { email: agency.email, password: "secret12" });
  assert.equal(reconnexion.status, 200);
  assert.equal((await c.get("/api/me")).status, 200);
});

test("e-mail déjà utilisé, mauvais mot de passe, session absente", async () => {
  const c2 = client();
  const email = compteUnique("doublon");
  const inscription = await c2.post("/api/register", {
    name: "Agence Doublon", city: "Abidjan", phone: "0700000001", email, password: "secret12"
  });
  assert.equal(inscription.status, 201);

  const c3 = client();
  const doublon = await c3.post("/api/register", {
    name: "Agence Bis", city: "Abidjan", phone: "0700000001", email, password: "autre12"
  });
  assert.equal(doublon.status, 409);
  assert.match(doublon.data.error, /déjà utilisée/);

  const mauvais = await c3.post("/api/login", { email, password: "faux" });
  assert.equal(mauvais.status, 401);

  assert.equal((await c3.get("/api/colis")).status, 401);
  assert.equal((await c3.get("/api/agences")).status, 401);
});

/* ------------------------------- création colis ---------------------------- */

test("création d'un colis vers une agence non inscrite", async () => {
  const c = client();
  const agency = await creerAgence(c, "Agence Create", "Abidjan");
  const res = await c.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash Koloko",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const parcel = res.data.parcel;
  assert.match(parcel.trackingCode, /^CLI-[A-Z0-9]{6}$/);
  assert.equal(parcel.ownerId, agency.id);
  assert.equal(parcel.status, "Enregistré");
  assert.equal(parcel.destinationAgencyId, null);
  assert.deepEqual(parcel.unregisteredDestinationAgency, { name: "Flash Koloko", city: "Korhogo", phone: "0700000009" });
  assert.equal(parcel.history.length, 1);
});

test("création vers une agence inscrite, et refus des cas invalides", async () => {
  const a = client();
  const b = client();
  const agenceA = await creerAgence(a, "Agence Alpha", "Abidjan");
  const agenceB = await creerAgence(b, "Agence Beta", "Bouaké");

  const ok = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id, declaredAgencyName: "", declaredAgencyCity: "", declaredAgencyPhone: "" })
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.parcel.destinationAgencyId, agenceB.id);

  const versSoi = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceA.id, declaredAgencyName: "", declaredAgencyCity: "", declaredAgencyPhone: "" })
  });
  assert.equal(versSoi.status, 400);

  const inconnue = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: "n'existe pas", declaredAgencyName: "", declaredAgencyCity: "", declaredAgencyPhone: "" })
  });
  assert.equal(inconnue.status, 400);

  const mauvaisTel = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "123"
    })
  });
  assert.equal(mauvaisTel.status, 400);

  const villeCourte = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "K",
      declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(villeCourte.status, 400);
});

/* --------------------------- visibilité / suivi ---------------------------- */

test("un colis n'est visible que par ses deux agences", async () => {
  const a = client();
  const b = client();
  const c = client();
  const agenceA = await creerAgence(a, "Agence VisiA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence VisiB", "Bouaké");
  await creerAgence(c, "Agence VisiC", "Korhogo");

  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "0700000009"
    })
  });
  const id = cree.data.parcel.id;

  const listeA = await a.get("/api/colis");
  assert.ok(listeA.data.parcels.some((p) => p.id === id));

  const listeB = await b.get("/api/colis");
  assert.ok(!listeB.data.parcels.some((p) => p.id === id));

  assert.equal((await b.get(`/api/colis/${id}`)).status, 404);
  assert.equal((await c.get(`/api/colis/${id}`)).status, 404);
  assert.equal((await a.get(`/api/colis/${id}`)).status, 200);

  // Après rattachement, l'agence B voit le colis.
  const attente = await a.post(`/api/colis/${id}/attach`, { agencyId: agenceB.id });
  assert.equal(attente.status, 200, JSON.stringify(attente.data));
  assert.equal((await b.get(`/api/colis/${id}`)).status, 200);
  const listeB2 = await b.get("/api/colis");
  assert.ok(listeB2.data.parcels.some((p) => p.id === id));
});

test("le suivi public ne contient aucune donnée personnelle", async () => {
  const a = client();
  await creerAgence(a, "Agence Public", "Abidjan");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "0700000009"
    })
  });
  const code = cree.data.parcel.trackingCode;

  const anonyme = client();
  const res = await anonyme.get(`/api/suivi/${code}`);
  assert.equal(res.status, 200);
  const tracking = res.data.tracking;
  assert.equal(tracking.code, code);
  assert.equal(tracking.status, "Enregistré");
  assert.deepEqual(Object.keys(tracking).sort(),
    ["code", "destinationCity", "history", "lastUpdatedAtISO", "originCity", "status"]);
  assert.ok(!("sender" in tracking) && !("recipient" in tracking) && !("colisId" in tracking));

  assert.equal((await anonyme.get("/api/suivi/CLI-XXXXXX")).status, 404);
});

/* ------------------------------- rattachement ------------------------------ */

test("le rattachement est unique, réservé à l'expéditeur, vers une agence inscrite", async () => {
  const a = client();
  const b = client();
  const c = client();
  const agenceA = await creerAgence(a, "Agence RatA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence RatB", "Bouaké");
  const agenceC = await creerAgence(c, "Agence RatC", "Korhogo");

  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "0700000009"
    })
  });
  const id = cree.data.parcel.id;

  assert.equal((await b.post(`/api/colis/${id}/attach`, { agencyId: agenceC.id })).status, 404, "une agence sans lien ne rattache pas");
  assert.equal((await a.post(`/api/colis/${id}/attach`, { agencyId: "inconnue" })).status, 400);
  assert.equal((await a.post(`/api/colis/${id}/attach`, { agencyId: agenceA.id })).status, 400, "pas vers soi-même");

  const ok = await a.post(`/api/colis/${id}/attach`, { agencyId: agenceB.id, destinationCity: "Bouaké" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.parcel.destinationAgencyId, agenceB.id);
  assert.equal(ok.data.parcel.status, "Enregistré", "le rattachement ne fait pas avancer le statut");
  assert.equal(ok.data.parcel.history.length, 2);

  const deuxieme = await a.post(`/api/colis/${id}/attach`, { agencyId: agenceC.id });
  assert.equal(deuxieme.status, 403, "rattachement unique");
});

/* -------------------------------- progression ------------------------------ */

test("la progression suit les étapes et refuse les mauvais acteurs", async () => {
  const a = client();
  const b = client();
  const agenceB = await creerAgence(b, "Agence ProgB", "Bouaké");
  await creerAgence(a, "Agence ProgA", "Abidjan");

  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id, declaredAgencyName: "", declaredAgencyCity: "", declaredAgencyPhone: "" })
  });
  const id = cree.data.parcel.id;

  // L'agence de destination ne peut pas valider les étapes d'expédition.
  assert.equal((await b.post(`/api/colis/${id}/progress`, {})).status, 403);

  const expedie = await a.post(`/api/colis/${id}/progress`, {});
  assert.equal(expedie.status, 200);
  assert.equal(expedie.data.parcel.status, "Expédié");
  assert.equal(expedie.data.parcel.history.length, 2);

  const transit = await a.post(`/api/colis/${id}/progress`, {});
  assert.equal(transit.status, 200);
  assert.equal(transit.data.parcel.status, "En transit");

  // Maintenant les étapes de destination appartiennent à l'agence B.
  assert.equal((await a.post(`/api/colis/${id}/progress`, {})).status, 403);
  const arrive = await b.post(`/api/colis/${id}/progress`, {});
  assert.equal(arrive.status, 200);
  assert.equal(arrive.data.parcel.status, "Arrivé à l'agence de destination");

  // Le retrait exige l'identité de la personne qui retire.
  assert.equal((await b.post(`/api/colis/${id}/progress`, {})).status, 400);
  const retire = await b.post(`/api/colis/${id}/progress`, {
    collectedBy: { name: "Ibrahim Kone", cni: "CI12345678" }
  });
  assert.equal(retire.status, 200, JSON.stringify(retire.data));
  assert.equal(retire.data.parcel.status, "Retiré");
  assert.equal(retire.data.parcel.collectedBy.name, "Ibrahim Kone");

  assert.equal((await b.post(`/api/colis/${id}/progress`, {})).status, 403, "colis déjà clôturé");
});

test("l'expéditeur valide lui-même les étapes de destination tant qu'aucune agence n'est rattachée", async () => {
  const a = client();
  await creerAgence(a, "Agence Solo", "Abidjan");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "",
      declaredAgencyName: "Flash",
      declaredAgencyCity: "Korhogo",
      declaredAgencyPhone: "0700000009"
    })
  });
  const id = cree.data.parcel.id;
  assert.equal((await a.post(`/api/colis/${id}/progress`, {})).data.parcel.status, "Expédié");
  assert.equal((await a.post(`/api/colis/${id}/progress`, {})).data.parcel.status, "En transit");
  const arrive = await a.post(`/api/colis/${id}/progress`, {});
  assert.equal(arrive.data.parcel.status, "Arrivé à l'agence de destination");
});

/* --------------------------- comptes agents (LOT 1) -------------------------- */

test("le gérant invite un agent, l'agent se connecte et trace ses écritures", async () => {
  const g = client();
  const agency = await creerAgence(g, "Agence Equipe", "Abidjan");

  // Le compte agence existant apparaît comme le gérant de l'équipe.
  const liste0 = await g.get("/api/agents");
  assert.equal(liste0.status, 200);
  assert.equal(liste0.data.agents.length, 1);
  assert.equal(liste0.data.agents[0].role, "gerant");
  assert.equal(liste0.data.agents[0].email, agency.email);

  // Validations de l'invitation.
  const invalide = await g.post("/api/agents", { name: "X", email: "pas-un-mail", phone: "07", password: "123" });
  assert.equal(invalide.status, 400);

  const invite = await g.post("/api/agents", {
    name: "Koffi N'Guessan",
    email: "koffi.equipe@test.ci",
    phone: "+225 07-00-00-00-11",
    password: "agent12"
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  const agent = invite.data.agent;
  assert.equal(agent.role, "agent");
  assert.equal(agent.active, true);
  assert.equal(agent.phone, "0700000011");
  assert.equal(agent.agencyId, agency.id);

  const doublon = await g.post("/api/agents", { name: "Autre Agent", email: "koffi.equipe@test.ci", password: "agent12" });
  assert.equal(doublon.status, 409);

  const mailG = await g.post("/api/agents", { name: "Usurpateur", email: agency.email, password: "agent12" });
  assert.equal(mailG.status, 409, "un e-mail de gérant ne peut pas devenir un agent");

  // Connexion par agent.
  const a = client();
  const connexion = await a.post("/api/login", { email: "koffi.equipe@test.ci", password: "agent12" });
  assert.equal(connexion.status, 200, JSON.stringify(connexion.data));
  assert.equal(connexion.data.member.role, "agent");
  assert.equal(connexion.data.member.name, "Koffi N'Guessan");
  assert.equal(connexion.data.agency.id, agency.id);

  const moi = await a.get("/api/me");
  assert.equal(moi.status, 200);
  assert.equal(moi.data.member.id, agent.id);
  assert.equal(moi.data.agency.id, agency.id);

  // Un agent ne gère pas l'équipe (garde serveur, pas seulement l'interface).
  const essaiListe = await a.post("/api/agents", { name: "Zoé", email: "zoe@test.ci", password: "secret12" });
  assert.equal(essaiListe.status, 403);
  const essaiPatch = await a.patch(`/api/agents/${agent.id}`, { active: false });
  assert.equal(essaiPatch.status, 403);

  // Chaque écriture d'étape trace l'agent acteur.
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationAgencyId: "", declaredAgencyName: "Flash", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" })
  });
  assert.equal(cree.status, 201, JSON.stringify(cree.data));
  assert.equal(cree.data.parcel.history[0].actorId, agent.id);
  assert.equal(cree.data.parcel.history[0].actorName, "Koffi N'Guessan");

  const avance = await a.post(`/api/colis/${cree.data.parcel.id}/progress`, {});
  assert.equal(avance.status, 200);
  const derniere = avance.data.parcel.history[avance.data.parcel.history.length - 1];
  assert.equal(derniere.status, "Expédié");
  assert.equal(derniere.actorId, agent.id);
  assert.equal(derniere.actorName, "Koffi N'Guessan");
});

test("un agent désactivé ne peut plus se connecter et perd sa session", async () => {
  const g = client();
  const agency = await creerAgence(g, "Agence Desactiv", "Abidjan");
  const invite = await g.post("/api/agents", {
    name: "Inès Konan",
    email: "ines.desactiv@test.ci",
    password: "agent12"
  });
  assert.equal(invite.status, 201);
  const agentId = invite.data.agent.id;

  const a = client();
  assert.equal((await a.post("/api/login", { email: "ines.desactiv@test.ci", password: "agent12" })).status, 200);
  assert.equal((await a.get("/api/me")).status, 200);

  // Désactivation par le gérant.
  const desactivation = await g.patch(`/api/agents/${agentId}`, { active: false });
  assert.equal(desactivation.status, 200);
  assert.equal(desactivation.data.agent.active, false);

  // La session existante meurt et la reconnexion est refusée.
  assert.equal((await a.get("/api/me")).status, 401);
  const reconnexion = await a.post("/api/login", { email: "ines.desactiv@test.ci", password: "agent12" });
  assert.equal(reconnexion.status, 401);
  assert.match(reconnexion.data.error, /désactivé/);

  // Réactivation = retour immédiat.
  assert.equal((await g.patch(`/api/agents/${agentId}`, { active: true })).status, 200);
  assert.equal((await a.post("/api/login", { email: "ines.desactiv@test.ci", password: "agent12" })).status, 200);

  // Le gérant ne peut pas se désactiver via la route agents (sa ligne n'existe pas dans la table).
  assert.equal((await g.patch(`/api/agents/${agency.id}`, { active: false })).status, 404);
});

test("les agents et l'historique restent cloisonnés entre agences", async () => {
  const g = client();
  await creerAgence(g, "Agence Cloison", "Abidjan");
  const invite = await g.post("/api/agents", { name: "Marc Test", email: "marc.cloison@test.ci", password: "agent12" });
  const agentId = invite.data.agent.id;

  const autre = client();
  await creerAgence(autre, "Agence Voisine", "Bouaké");
  const listeAutre = await autre.get("/api/agents");
  assert.equal(listeAutre.status, 200);
  assert.equal(listeAutre.data.agents.length, 1, "l'agence voisine ne voit que son gérant");
  assert.ok(!listeAutre.data.agents.some((agent) => agent.id === agentId));

  // Impossible de modifier un agent qui n'appartient pas à son agence.
  assert.equal((await autre.patch(`/api/agents/${agentId}`, { active: false })).status, 404);
});

test("le rattachement trace l'acteur mais le suivi public ne l'expose jamais", async () => {
  const g = client();
  await creerAgence(g, "Agence Preuve", "Abidjan");
  const invite = await g.post("/api/agents", { name: "Sarah Preuve", email: "sarah.preuve@test.ci", password: "agent12" });
  assert.equal(invite.status, 201);

  const a = client();
  await a.post("/api/login", { email: "sarah.preuve@test.ci", password: "agent12" });
  const b = client();
  const agenceB = await creerAgence(b, "Agence Preuve Dest", "Bouaké");

  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationAgencyId: "", declaredAgencyName: "Flash", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" })
  });
  const id = cree.data.parcel.id;

  const attache = await a.post(`/api/colis/${id}/attach`, { agencyId: agenceB.id });
  assert.equal(attache.status, 200);
  const etape = attache.data.parcel.history[attache.data.parcel.history.length - 1];
  assert.equal(etape.status, "Agence de retrait confirmée");
  assert.equal(etape.actorName, "Sarah Preuve");
  assert.equal(etape.actorId, invite.data.agent.id);

  // Suivi public anonyme : aucune trace de l'acteur dans l'historique.
  const code = cree.data.parcel.trackingCode;
  const anonyme = client();
  const res = await anonyme.get(`/api/suivi/${code}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.tracking.history.length >= 2);
  for (const [index, entry] of res.data.tracking.history.entries()) {
    assert.ok(!("actorId" in entry), `étape ${index} : actorId ne doit pas sortir en public`);
    assert.ok(!("actorName" in entry), `étape ${index} : actorName ne doit pas sortir en public`);
  }
  // Rien non plus dans la charge JSON brute.
  assert.equal(/Sarah Preuve|sarah\.preuve/.test(JSON.stringify(res.data)), false);
});

/* ---------------- grille tarifaire / paiement / caisse (LOT 2) ------------- */

function jourCleTest() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

test("la grille tarifaire se gère en CRUD réservé au gérant (sans suppression)", async () => {
  const g = client();
  await creerAgence(g, "Agence Tarifs", "Abidjan");
  assert.deepEqual((await g.get("/api/tarifs")).data.tarifs, [], "grille vide au départ");

  // Écritures réservées au gérant.
  const inv = await g.post("/api/agents", { name: "Agent Tarif", email: "agent.tarif@test.ci", password: "agent12" });
  assert.equal(inv.status, 201);
  const ag = client();
  await ag.post("/api/login", { email: "agent.tarif@test.ci", password: "agent12" });
  assert.equal((await ag.post("/api/tarifs", { originCity: "Abidjan", destinationCity: "Bouaké", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 2500 })).status, 403);
  assert.equal((await ag.get("/api/tarifs")).status, 200, "un agent peut lire la grille");

  // Créations valides et refusées.
  const valide = await g.post("/api/tarifs", { originCity: " Abidjan ", destinationCity: "Bouaké", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 2500 });
  assert.equal(valide.status, 201, JSON.stringify(valide.data));
  assert.equal(valide.data.tarif.originCity, "Abidjan");
  assert.equal(valide.data.tarif.priceFCFA, 2500);

  const toutes = await g.post("/api/tarifs", { originCity: "Abidjan", destinationCity: "", weightMinKg: 2, weightMaxKg: null, priceFCFA: 4000 });
  assert.equal(toutes.status, 201);
  assert.equal(toutes.data.tarif.destinationCity, "", "'' = toutes destinations");

  assert.equal((await g.post("/api/tarifs", { originCity: "A", destinationCity: "", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 100 })).status, 400);
  assert.equal((await g.post("/api/tarifs", { originCity: "Abidjan", destinationCity: "", weightMinKg: 0, weightMaxKg: 2, priceFCFA: -5 })).status, 400);

  // Mise à jour et mise hors grille (pas de suppression).
  const maj = await g.patch(`/api/tarifs/${valide.data.tarif.id}`, { priceFCFA: 2750 });
  assert.equal(maj.status, 200);
  assert.equal(maj.data.tarif.priceFCFA, 2750);
  const hors = await g.patch(`/api/tarifs/${valide.data.tarif.id}`, { active: false });
  assert.equal(hors.status, 200);
  assert.equal(hors.data.tarif.active, false);

  // Cloisonnement : une autre agence ne voit ni ne modifie cette grille.
  const b = client();
  await creerAgence(b, "Agence Voisine Tarifs", "Bouaké");
  assert.deepEqual((await b.get("/api/tarifs")).data.tarifs, []);
  assert.equal((await b.patch(`/api/tarifs/${valide.data.tarif.id}`, { priceFCFA: 1 })).status, 404);
  assert.equal((await b.patch("/api/tarifs/inexistant", { priceFCFA: 1 })).status, 404);
});

test("le prix du colis vient de la grille (autorité serveur), saisie libre sinon", async () => {
  const g = client();
  await creerAgence(g, "Agence Grille", "Abidjan");
  assert.equal((await g.post("/api/tarifs", { originCity: "Abidjan", destinationCity: "Bouaké", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 2500 })).status, 201);
  assert.equal((await g.post("/api/tarifs", { originCity: "Abidjan", destinationCity: "Bouaké", weightMinKg: 2, weightMaxKg: 5, priceFCFA: 3500 })).status, 201);

  // Prix soumis ≠ prix de la grille : le serveur impose la grille.
  const traverse = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", weightKg: "2.5", priceFCFA: "99999",
      destinationCity: "Bouaké",
      declaredAgencyName: "Flash Bouaké", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(traverse.status, 201, JSON.stringify(traverse.data));
  assert.equal(traverse.data.parcel.priceFCFA, 3500, "la grille tranche");

  const leger = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", weightKg: "1", priceFCFA: "1",
      destinationCity: "Bouaké",
      declaredAgencyName: "Flash Bouaké", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(leger.data.parcel.priceFCFA, 2500);

  // Aucune ligne applicable → saisie libre acceptée (compatibilité).
  const libre = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", weightKg: "3", priceFCFA: "4321",
      destinationCity: "Man",
      declaredAgencyName: "Flash Man", declaredAgencyCity: "Man", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(libre.status, 201);
  assert.equal(libre.data.parcel.priceFCFA, 4321);

  // Une agence sans grille fonctionne exactement comme avant le LOT 2.
  const sansGrille = client();
  await creerAgence(sansGrille, "Agence Sans Grille", "Korhogo");
  const legacy = await sansGrille.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", weightKg: "2.5", priceFCFA: "1234",
      declaredAgencyName: "Flash Test", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.data.parcel.priceFCFA, 1234);
});

test("l'état de paiement est validé à l'enregistrement et le paiement alimente la caisse", async () => {
  const g = client();
  await creerAgence(g, "Agence Paiement", "Abidjan");

  const paye = await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "paye", mode: "especes" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Paye", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });
  assert.equal(paye.status, 201, JSON.stringify(paye.data));
  assert.equal(paye.data.parcel.paymentStatus, "paye");
  assert.equal(paye.data.parcel.paidAmountFCFA, 3500);

  const arrivee = await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "arrivee" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Arrivee", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });
  assert.equal(arrivee.status, 201);
  assert.equal(arrivee.data.parcel.paymentStatus, "arrivee");
  assert.equal(arrivee.data.parcel.paidAmountFCFA, 0);

  const partiel = await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "partiel", paidAmountFCFA: 1000, mode: "mobile_money" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Partiel", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });
  assert.equal(partiel.status, 201);
  assert.equal(partiel.data.parcel.paymentStatus, "partiel");
  assert.equal(partiel.data.parcel.paidAmountFCFA, 1000);

  // Refus des incohérences.
  assert.equal((await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "partiel", paidAmountFCFA: 5000, mode: "especes" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Refus", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  })).status, 400);
  assert.equal((await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "paye" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Mode", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  })).status, 400, "payé au départ sans mode refusé");

  // Sans paiement = colis legacy accepté (aucun champ imposé).
  const legacy = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Legacy", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });
  assert.equal(legacy.status, 201);
  assert.equal("paymentStatus" in legacy.data.parcel, false);

  // Caisse du jour : payé + partiel encaissés par l'agence expéditrice.
  const caisse = await g.get(`/api/caisse?date=${jourCleTest()}`);
  assert.equal(caisse.status, 200);
  assert.equal(caisse.data.totaux.especes, 3500);
  assert.equal(caisse.data.totaux.mobile_money, 1000);
  assert.equal(caisse.data.totaux.total, 4500);
  assert.equal(caisse.data.encaissements.length, 2);
  assert.equal(caisse.data.encaissements[0].trackingCode, paye.data.parcel.trackingCode);
  assert.equal(caisse.data.encaissements[0].mode, "especes");
  assert.ok(caisse.data.encaissements[0].agentName, "l'agent acteur est journalisé");
});

test("l'agence de destination encaisse le reste, jamais au-delà, dans SA caisse", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence CodA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence CodB", "Bouaké");
  await creerAgence(c, "Agence CodC", "Korhogo");

  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    payment: { status: "arrivee" },
    values: valeurs({ destinationAgencyId: agenceB.id, priceFCFA: "3500" })
  });
  assert.equal(cree.status, 201, JSON.stringify(cree.data));
  const id = cree.data.parcel.id;

  // Reste visible côté destination.
  const caisseB = await b.get(`/api/caisse?date=${jourCleTest()}`);
  assert.ok(caisseB.data.restes.some((r) => r.id === id));
  assert.equal(caisseB.data.restes.find((r) => r.id === id).resteFCFA, 3500);

  // Une agence sans lien n'encaisse rien.
  assert.equal((await c.post(`/api/colis/${id}/encaisser`, { amountFCFA: 1000, mode: "especes" })).status, 404);

  // Bornes du montant.
  assert.equal((await b.post(`/api/colis/${id}/encaisser`, { amountFCFA: 4000, mode: "especes" })).status, 400);
  assert.equal((await b.post(`/api/colis/${id}/encaisser`, { amountFCFA: 0, mode: "especes" })).status, 400);
  assert.equal((await b.post(`/api/colis/${id}/encaisser`, { amountFCFA: 1000, mode: "cheque" })).status, 400);

  // Encaissement complet à la remise.
  const encaisse = await b.post(`/api/colis/${id}/encaisser`, { amountFCFA: 3500, mode: "especes" });
  assert.equal(encaisse.status, 201, JSON.stringify(encaisse.data));
  assert.equal(encaisse.data.parcel.paymentStatus, "regle");
  assert.equal(encaisse.data.parcel.paidAmountFCFA, 3500);
  assert.equal((await b.post(`/api/colis/${id}/encaisser`, { amountFCFA: 100, mode: "especes" })).status, 400);

  // L'encaissement revient à la caisse de B, pas à celle de A.
  const apresB = await b.get(`/api/caisse?date=${jourCleTest()}`);
  assert.ok(apresB.data.encaissements.some((e) => e.parcelId === id && e.amountFCFA === 3500));
  const apresA = await a.get(`/api/caisse?date=${jourCleTest()}`);
  assert.ok(!apresA.data.encaissements.some((e) => e.parcelId === id));
});

test("la clôture de caisse valide le total compté, une seule fois par jour", async () => {
  const g = client();
  await creerAgence(g, "Agence Cloture", "Abidjan");

  await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "paye", mode: "especes" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "2500", declaredAgencyName: "Flash Cloture", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });
  await g.post("/api/colis", {
    agencyNotRegistered: true,
    payment: { status: "paye", mode: "mobile_money" },
    values: valeurs({ destinationAgencyId: "", priceFCFA: "3500", declaredAgencyName: "Flash Cloture", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009" })
  });

  const jour = jourCleTest();
  assert.equal((await g.post("/api/caisse/cloture", { date: "15/10/2026", countedTotalFCFA: 6000 })).status, 400, "format de date");

  const cloture = await g.post("/api/caisse/cloture", { date: jour, countedTotalFCFA: 6000 });
  assert.equal(cloture.status, 201, JSON.stringify(cloture.data));
  assert.equal(cloture.data.cloture.countedTotalFCFA, 6000);
  assert.equal(cloture.data.cloture.computedTotalFCFA, 6000);
  assert.equal(cloture.data.cloture.ecartFCFA, 0);

  // Écart signalé quand le compté diffère, mais seule la caisse de l'agence compte.
  assert.equal((await g.post("/api/caisse/cloture", { date: jour, countedTotalFCFA: 6000 })).status, 409, "une seule clôture par jour");

  const autre = client();
  await creerAgence(autre, "Agence Cloture B", "Bouaké");
  const clotureAutre = await autre.post("/api/caisse/cloture", { date: jour, countedTotalFCFA: 500 });
  assert.equal(clotureAutre.status, 201);
  assert.equal(clotureAutre.data.cloture.computedTotalFCFA, 0, "sa caisse est vide");
  assert.equal(clotureAutre.data.cloture.ecartFCFA, 500, "l'écart est enregistré");

  // La caisse du jour renvoie la clôture existante.
  const caisse = await g.get(`/api/caisse?date=${jour}`);
  assert.equal(caisse.data.cloture.dateKey, jour);
  assert.equal(caisse.data.cloture.countedTotalFCFA, 6000);
});

/* --------------------- carnet de clients + devis public (LOT 3) ------------ */

test("le carnet se remplit automatiquement à l'enregistrement d'un colis (upsert)", async () => {
  const g = client();
  await creerAgence(g, "Agence Carnet", "Abidjan");
  assert.deepEqual((await g.get("/api/clients")).data.clients, [], "carnet vide au départ");

  const cree = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", senderFirstName: "Awa", senderLastName: "Traoré",
      senderPhone: "0700000001", senderCni: "ci12345678",
      recipientFirstName: "Ibrahim", recipientLastName: "Koné", recipientPhone: "0500000002",
      declaredAgencyName: "Flash Carnet", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(cree.status, 201, JSON.stringify(cree.data));

  const carnet = await g.get("/api/clients");
  assert.equal(carnet.status, 200);
  assert.equal(carnet.data.clients.length, 2, "l'expéditeur et le destinataire sont mémorisés");
  const expediteur = carnet.data.clients.find((c) => c.kind === "expediteur");
  const destinataire = carnet.data.clients.find((c) => c.kind === "destinataire");
  assert.equal(expediteur.phone, "0700000001");
  assert.equal(expediteur.cni, "CI12345678");
  assert.equal(expediteur.city, "Abidjan", "ville de départ mémorisée");
  assert.equal(destinataire.phone, "0500000002");
  assert.equal(destinataire.cni, null, "jamais de CNI destinataire");
  assert.equal(destinataire.city, "Bouaké");

  // Même expéditeur sur un second colis : pas de doublon, la fiche est complétée.
  const second = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", senderPhone: "+225 07 00 00 00 01",
      recipientFirstName: "Zié", recipientLastName: "Kouassi", recipientPhone: "0100000003",
      declaredAgencyName: "Flash Zié", declaredAgencyCity: "Man", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(second.status, 201);
  const apres = await g.get("/api/clients");
  assert.equal(apres.data.clients.length, 3, "upsert : l'expéditeur n'est pas dupliqué");
  const expediteur2 = apres.data.clients.find((c) => c.kind === "expediteur" && c.phone === "0700000001");
  assert.equal(expediteur2.id, expediteur.id);
  assert.equal(expediteur2.cni, "CI12345678", "une CNI déjà renseignée n'est jamais effacée");
});

test("carnet : création manuelle, recherche, fiche avec historique, modification", async () => {
  const g = client();
  await creerAgence(g, "Agence Fiche", "Abidjan");

  // Validations serveur.
  assert.equal((await g.post("/api/clients", { kind: "autre", firstName: "A", lastName: "B", phone: "0700000001" })).status, 400);
  assert.equal((await g.post("/api/clients", { kind: "expediteur", firstName: "A", lastName: "B", phone: "123" })).status, 400);

  const cree = await g.post("/api/clients", {
    kind: "expediteur", firstName: "Mariam", lastName: "Diarra",
    phone: "+225 07-00-00-00-21", cni: "ci87654321", city: "Abidjan", notes: "cliente du marché"
  });
  assert.equal(cree.status, 201, JSON.stringify(cree.data));
  assert.equal(cree.data.cree, true);
  assert.equal(cree.data.client.phone, "0700000021");
  const id = cree.data.client.id;

  // Upsert manuel : même rôle + téléphone → mise à jour, pas de doublon.
  const upsert = await g.post("/api/clients", { kind: "expediteur", firstName: "Mariam", lastName: "Diarra-Sow", phone: "0700000021" });
  assert.equal(upsert.status, 200);
  assert.equal(upsert.data.cree, false);
  assert.equal(upsert.data.client.id, id);
  assert.equal(upsert.data.client.lastName, "Diarra-Sow");
  assert.equal(upsert.data.client.cni, "CI87654321", "la CNI existante est conservée");

  // Recherche par téléphone (format libre) et par rôle.
  const parTel = await g.get("/api/clients?recherche=07%2000%2000%2000%2021");
  assert.equal(parTel.data.clients.length, 1);
  const parNom = await g.get("/api/clients?recherche=diarra");
  assert.equal(parNom.data.clients.length, 1);
  assert.equal((await g.get("/api/clients?kind=inconnu")).status, 400);

  // Fiche + historique : un colis enregistré pour cette cliente apparaît.
  const colis = await g.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", senderFirstName: "Mariam", senderLastName: "Diarra-Sow",
      senderPhone: "0700000021", senderCni: "CI87654321",
      declaredAgencyName: "Flash Fiche", declaredAgencyCity: "Bouaké", declaredAgencyPhone: "0700000009"
    })
  });
  assert.equal(colis.status, 201);
  const fiche = await g.get(`/api/clients/${id}`);
  assert.equal(fiche.status, 200);
  assert.equal(fiche.data.client.id, id);
  assert.equal(fiche.data.historique.length, 1);
  assert.equal(fiche.data.historique[0].trackingCode, colis.data.parcel.trackingCode);
  assert.deepEqual(fiche.data.historique[0].roles, ["expediteur"]);

  // Modification, puis collision refusée.
  const maj = await g.patch(`/api/clients/${id}`, { city: "Yamoussoukro", notes: "" });
  assert.equal(maj.status, 200);
  assert.equal(maj.data.client.city, "Yamoussoukro");
  const autre = await g.post("/api/clients", { kind: "destinataire", firstName: "Paul", lastName: "Koffi", phone: "0500000099" });
  assert.equal(autre.status, 201);
  const collision = await g.patch(`/api/clients/${autre.data.client.id}`, { kind: "expediteur", phone: "0700000021" });
  assert.equal(collision.status, 409);

  assert.equal((await g.get("/api/clients/inexistant")).status, 404);
  assert.equal((await g.patch("/api/clients/inexistant", { city: "X" })).status, 404);
});

test("le carnet est cloisonné : jamais visible d'une agence à l'autre", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence Carnet A", "Abidjan");
  await creerAgence(b, "Agence Carnet B", "Bouaké");

  const cree = await a.post("/api/clients", { kind: "expediteur", firstName: "Awa", lastName: "Traoré", phone: "0700000001" });
  assert.equal(cree.status, 201);
  const id = cree.data.client.id;

  assert.deepEqual((await b.get("/api/clients")).data.clients, []);
  assert.equal((await b.get(`/api/clients/${id}`)).status, 404);
  assert.equal((await b.patch(`/api/clients/${id}`, { notes: "piraté" })).status, 404);

  // Un colis de B vers A ne mémorise le client que dans le carnet de B.
  await b.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", originCity: "Bouaké", senderPhone: "0500000011",
      declaredAgencyName: "Flash B", declaredAgencyCity: "Abidjan", declaredAgencyPhone: "0700000009"
    })
  });
  const carnetB = await b.get("/api/clients");
  assert.equal(carnetB.data.clients.length, 2, "expéditeur + destinataire du colis de B");
  const carnetA = await a.get("/api/clients");
  assert.equal(carnetA.data.clients.length, 1, "le carnet de A ne bouge pas");

  // Sans session : refus.
  const anonyme = client();
  assert.equal((await anonyme.get("/api/clients")).status, 401);
});

test("le devis public est anonyme, calcule depuis les grilles actives et ne demande rien de personnel", async () => {
  const g = client();
  await creerAgence(g, "Agence Devisville", "Devisville");
  assert.equal((await g.post("/api/tarifs", { originCity: "Devisville", destinationCity: "Cibleville", weightMinKg: 0, weightMaxKg: 2, priceFCFA: 1500 })).status, 201);
  assert.equal((await g.post("/api/tarifs", { originCity: "Devisville", destinationCity: "Cibleville", weightMinKg: 2, weightMaxKg: null, priceFCFA: 3000 })).status, 201);
  const desactive = await g.post("/api/tarifs", { originCity: "Devisville", destinationCity: "Horsville", weightMinKg: 0, weightMaxKg: null, priceFCFA: 900 });
  assert.equal((await g.patch(`/api/tarifs/${desactive.data.tarif.id}`, { active: false })).status, 200);

  const anonyme = client();
  const devis = await anonyme.post("/api/devis", { originCity: " devisville ", destinationCity: "Cibleville", weightKg: 1.5, packageNature: "Vêtements" });
  assert.equal(devis.status, 200, JSON.stringify(devis.data));
  assert.equal(devis.data.devis.offres.length, 1);
  const offre = devis.data.devis.offres[0];
  assert.equal(offre.priceFCFA, 1500);
  assert.deepEqual(offre.agence, { name: "Agence Devisville", city: "Devisville", phone: "0700000001" });
  assert.deepEqual(Object.keys(devis.data.devis).sort(), ["destinationCity", "offres", "originCity", "packageNature", "weightKg"]);

  // Axe hors grille (ligne désactivée) : aucune offre, jamais d'erreur.
  const hors = await anonyme.post("/api/devis", { originCity: "Devisville", destinationCity: "Horsville", weightKg: 1 });
  assert.equal(hors.status, 200);
  assert.deepEqual(hors.data.devis.offres, []);

  // Validations : villes, poids.
  assert.equal((await anonyme.post("/api/devis", { originCity: "D", destinationCity: "Cibleville", weightKg: 1 })).status, 400);
  assert.equal((await anonyme.post("/api/devis", { originCity: "Devisville", destinationCity: "Cibleville", weightKg: 0 })).status, 400);
  assert.equal((await anonyme.post("/api/devis", { originCity: "Devisville", destinationCity: "Cibleville", weightKg: 5000 })).status, 400);

  // Aucune donnée personnelle ni identifiant interne dans la réponse.
  const brut = JSON.stringify(devis.data);
  assert.ok(!brut.includes("password") && !brut.includes("@") && !brut.includes("agencyId") && !brut.includes("agency_id"));
});

/* ------------- bordereaux, photos, incidents, souffrance (LOT 4) ----------- */

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function joursAvant(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

/** Antidate la dernière étape d'historique (et updated_at) d'un colis. */
async function antidaterArrivee(id, jours) {
  const { rows } = await query("SELECT history FROM parcels WHERE id = $1", [id]);
  const history = typeof rows[0].history === "string" ? JSON.parse(rows[0].history) : rows[0].history;
  history[history.length - 1].date = joursAvant(jours);
  await query(`UPDATE parcels SET history = $1, updated_at = now() - interval '${jours} days' WHERE id = $2`, [
    JSON.stringify(history), id
  ]);
}

test("bordereau : création, émargements par acteur, contrôle d'arrivée, écart → incident automatique", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence BordA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence BordB", "Bouaké");
  await creerAgence(c, "Agence BordC", "Korhogo");

  const ids = [];
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const cree = await a.post("/api/colis", {
      agencyNotRegistered: false,
      values: valeurs({ destinationAgencyId: agenceB.id, recipientPhone: `0500000${100 + i}` })
    });
    assert.equal(cree.status, 201, JSON.stringify(cree.data));
    ids.push(cree.data.parcel.id);
    codes.push(cree.data.parcel.trackingCode);
  }

  // Validations serveur à la création.
  assert.equal((await a.post("/api/bordereaux", { carrierName: "Gbaka", carrierPhone: "0700000055", parcelIds: [] })).status, 400);
  assert.equal((await a.post("/api/bordereaux", { carrierName: "Gbaka", carrierPhone: "123", parcelIds: ids })).status, 400);
  assert.equal((await b.post("/api/bordereaux", { carrierName: "Gbaka", carrierPhone: "0700000055", parcelIds: [ids[0]] })).status, 400, "seul l'expéditeur borde ses colis");

  const ok = await a.post("/api/bordereaux", {
    carrierName: "Gbaka Express",
    carrierPhone: "+225 07-00-00-00-55",
    vehicleRef: "car Bouaké 07 h",
    parcelIds: ids
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const bordereau = ok.data.bordereau;
  assert.match(bordereau.code, /^BDR-[A-Z0-9]{6}$/);
  assert.equal(bordereau.status, "Préparé");
  assert.equal(bordereau.parcelCount, 3);
  assert.equal(bordereau.toAgencyId, agenceB.id);
  assert.equal(bordereau.carrierPhone, "0700000055");

  // Un colis déjà bordé ne repart pas dans un autre lot.
  assert.equal((await a.post("/api/bordereaux", { carrierName: "Autre Car", carrierPhone: "0700000055", parcelIds: [ids[0]] })).status, 400);

  // Visibilité : les deux agences concernées seulement.
  assert.equal((await c.get(`/api/bordereaux/${bordereau.id}`)).status, 404);
  const vuB = await b.get(`/api/bordereaux/${bordereau.id}`);
  assert.equal(vuB.status, 200);
  assert.equal(vuB.data.parcels.length, 3);
  assert.equal(vuB.data.actions.role, "destinataire");
  assert.equal(vuB.data.actions.prochaineEtape, null, "la destination n'émarge pas la remise");
  assert.deepEqual((await c.get("/api/bordereaux")).data.bordereaux, []);
  assert.equal((await a.get("/api/bordereaux")).data.bordereaux[0].role, "emetteur");

  // Émargements verrouillés par acteur.
  assert.equal((await b.post(`/api/bordereaux/${bordereau.id}/remettre`, {})).status, 403);
  const remis = await a.post(`/api/bordereaux/${bordereau.id}/remettre`, { etape: "Remis" });
  assert.equal(remis.status, 200);
  assert.equal(remis.data.bordereau.status, "Remis");
  assert.ok(remis.data.bordereau.handedOverAt);

  // La remise au transporteur expédie les colis et trace le bordereau.
  const colis0 = await a.get(`/api/colis/${ids[0]}`);
  assert.equal(colis0.data.parcel.status, "Expédié");
  assert.equal(colis0.data.parcel.bordereauId, bordereau.id);
  const etapeRemise = colis0.data.parcel.history[colis0.data.parcel.history.length - 1];
  assert.equal(etapeRemise.status, "Expédié");
  assert.match(etapeRemise.note, new RegExp(bordereau.code));

  assert.equal((await a.post(`/api/bordereaux/${bordereau.id}/remettre`, { etape: "Arrivé" })).status, 400, "l'étape suivante est imposée");
  const enRoute = await a.post(`/api/bordereaux/${bordereau.id}/remettre`, {});
  assert.equal(enRoute.data.bordereau.status, "En route");
  assert.equal((await a.get(`/api/colis/${ids[1]}`)).data.parcel.status, "En transit", "le lot qui roule met les colis en transit");

  assert.equal((await a.post(`/api/bordereaux/${bordereau.id}/remettre`, {})).status, 403, "l'arrivée appartient à la destination");
  assert.equal((await b.post(`/api/bordereaux/${bordereau.id}/remettre`, {})).data.bordereau.status, "Arrivé");

  // Contrôle d'arrivée en cases à cocher.
  assert.equal((await a.post(`/api/bordereaux/${bordereau.id}/controle`, { absentParcelIds: [] })).status, 403);
  const controle = await b.post(`/api/bordereaux/${bordereau.id}/controle`, { absentParcelIds: [ids[2]] });
  assert.equal(controle.status, 201, JSON.stringify(controle.data));
  assert.equal(controle.data.bordereau.status, "Écart");
  assert.deepEqual(controle.data.bordereau.missingParcelIds, [ids[2]]);
  assert.equal(controle.data.colisAvances, 2, "les colis présents sont confirmés arrivés");
  assert.equal(controle.data.incidentsCrees, 1, "l'absent ouvre un incident automatique");

  assert.equal((await b.get(`/api/colis/${ids[0]}`)).data.parcel.status, "Arrivé à l'agence de destination");
  assert.equal((await b.get(`/api/colis/${ids[2]}`)).data.parcel.status, "En transit", "l'absent n'avance pas");
  assert.equal((await b.post(`/api/bordereaux/${bordereau.id}/controle`, { absentParcelIds: [] })).status, 403, "le contrôle ne se rejoue pas");

  // Incident automatique visible par les deux agences, avec le bordereau en preuve.
  const incA = await a.get("/api/incidents");
  const incB = await b.get("/api/incidents");
  assert.equal(incA.data.incidents.length, 1);
  assert.equal(incB.data.incidents.length, 1);
  const incident = incA.data.incidents[0];
  assert.equal(incident.type, "perdu");
  assert.equal(incident.state, "ouvert");
  assert.equal(incident.parcel.id, ids[2]);
  assert.equal(incident.bordereauId, bordereau.id);
  assert.match(incident.note, new RegExp(bordereau.code));
  assert.deepEqual((await c.get("/api/incidents")).data.incidents, [], "une agence sans lien ne voit rien");

  // Suivi public du colis absent : bandeau sobre, aucun détail privé.
  const suivi = await c.get(`/api/suivi/${codes[2]}`);
  assert.equal(suivi.data.tracking.notice, "Une vérification est en cours sur ce colis.");
  assert.ok(!JSON.stringify(suivi.data).includes("Absent au contrôle"), "la note de l'incident ne fuit pas en public");

  // Suivi public du bordereau : aucune donnée personnelle, résultat du contrôle.
  const publicBdr = await c.get(`/api/suivi-bordereau/${bordereau.code}`);
  assert.equal(publicBdr.status, 200);
  const brutBdr = JSON.stringify(publicBdr.data);
  assert.ok(!brutBdr.includes("0700000055"), "le téléphone du transporteur n'est jamais public");
  assert.ok(!brutBdr.includes("Awa") && !brutBdr.includes("Ibrahim") && !brutBdr.includes("CI12345678"));
  assert.equal(publicBdr.data.bordereau.status, "Écart");
  assert.equal(publicBdr.data.bordereau.carrierName, "Gbaka Express");
  assert.equal(publicBdr.data.bordereau.parcels.length, 3);
  assert.equal(publicBdr.data.bordereau.parcels.filter((p) => p.present === true).length, 2);
  assert.equal(publicBdr.data.bordereau.parcels.filter((p) => p.present === false).length, 1);
  assert.equal((await c.get("/api/suivi-bordereau/BDR-XXXXXX")).status, 404);
});

test("bordereau vers une destination non rattachée : l'expéditeur déclare l'arrivée et contrôle", async () => {
  const a = client();
  await creerAgence(a, "Agence SoloBord", "Abidjan");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationAgencyId: "", destinationCity: "Korhogo", declaredAgencyName: "Flash Solo", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009" })
  });
  const id = cree.data.parcel.id;

  const ok = await a.post("/api/bordereaux", { carrierName: "Car Korhogo", carrierPhone: "0700000066", parcelIds: [id] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.bordereau.toAgencyId, null);
  assert.equal(ok.data.bordereau.toCity, "Korhogo");
  const bdr = ok.data.bordereau.id;

  assert.equal((await a.post(`/api/bordereaux/${bdr}/remettre`, {})).data.bordereau.status, "Remis");
  assert.equal((await a.post(`/api/bordereaux/${bdr}/remettre`, {})).data.bordereau.status, "En route");
  assert.equal((await a.post(`/api/bordereaux/${bdr}/remettre`, {})).data.bordereau.status, "Arrivé", "l'expéditeur déclare l'arrivée si rien n'est rattaché");
  const controle = await a.post(`/api/bordereaux/${bdr}/controle`, { absentParcelIds: [] });
  assert.equal(controle.data.bordereau.status, "Contrôlé");
  assert.equal(controle.data.colisAvances, 1);
  assert.equal(controle.data.incidentsCrees, 0);
  assert.equal((await a.get(`/api/colis/${id}`)).data.parcel.status, "Arrivé à l'agence de destination");
});

test("incidents : ouverture, transitions, cloisonnement, bandeau public, escalade 24 h / 7 j", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence IncA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence IncB", "Bouaké");
  await creerAgence(c, "Agence IncC", "Korhogo");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id })
  });
  const id = cree.data.parcel.id;
  const code = cree.data.parcel.trackingCode;

  assert.equal((await c.post(`/api/colis/${id}/incidents`, { type: "perdu", note: "vu nulle part" })).status, 404, "une agence sans lien n'ouvre rien");
  assert.equal((await a.post(`/api/colis/${id}/incidents`, { type: "vole", note: "xx" })).status, 400);
  assert.equal((await a.post(`/api/colis/${id}/incidents`, { type: "perdu", note: "" })).status, 400);

  const ouvert = await b.post(`/api/colis/${id}/incidents`, { type: "retard", note: "Le car a trois jours de retard, client informé." });
  assert.equal(ouvert.status, 201, JSON.stringify(ouvert.data));
  assert.equal(ouvert.data.incident.state, "ouvert");
  assert.equal((await a.post(`/api/colis/${id}/incidents`, { type: "perdu", note: "doublon" })).status, 409, "un seul incident non résolu à la fois");

  // Bandeau public sobre : ni type, ni note, ni agence.
  const suivi = await c.get(`/api/suivi/${code}`);
  assert.equal(suivi.data.tracking.notice, "Une vérification est en cours sur ce colis.");
  const brutSuivi = JSON.stringify(suivi.data);
  assert.ok(!brutSuivi.includes("car a trois jours"));
  assert.ok(!brutSuivi.includes("IncB"));

  // Transitions d'état.
  const incId = ouvert.data.incident.id;
  assert.equal((await c.patch(`/api/incidents/${incId}`, { state: "recherches" })).status, 404, "cloisonnement");
  assert.equal((await a.patch(`/api/incidents/${incId}`, { state: "resolu" })).status, 400, "résolution sans explication refusée");
  assert.equal((await a.patch(`/api/incidents/${incId}`, { state: "ouvert" })).status, 400, "jamais de retour à ouvert");
  assert.equal((await a.patch(`/api/incidents/${incId}`, { state: "recherches" })).data.incident.state, "recherches");

  // Escalade : ouvert > 24 h → alerte ; > 7 j → file plateforme (lot 6).
  await query("UPDATE incidents SET opened_at_iso = $1 WHERE id = $2", [joursAvant(2), incId]);
  const esc = (await a.get("/api/incidents")).data.incidents.find((item) => item.id === incId);
  assert.equal(esc.alerte24h, true);
  assert.equal(esc.filePlateforme, false);
  await query("UPDATE incidents SET opened_at_iso = $1 WHERE id = $2", [joursAvant(8), incId]);
  const esc2 = (await b.get("/api/incidents?state=recherches")).data.incidents.find((item) => item.id === incId);
  assert.equal(esc2.filePlateforme, true);
  assert.deepEqual((await b.get("/api/incidents?state=ouvert")).data.incidents, []);
  assert.equal((await b.get("/api/incidents?state=invalide")).status, 400);

  // Résolution : bandeau public disparu, incident conservé, immuable.
  const resolu = await b.patch(`/api/incidents/${incId}`, { state: "resolu", resolution: "Colis arrivé par le car suivant, remis au destinataire." });
  assert.equal(resolu.data.incident.state, "resolu");
  assert.ok(resolu.data.incident.resolvedAtISO);
  assert.equal((await a.patch(`/api/incidents/${incId}`, { state: "recherches" })).status, 409, "résolu = immuable");
  const suivi2 = await c.get(`/api/suivi/${code}`);
  assert.equal("notice" in suivi2.data.tracking, false);
  assert.equal((await a.get("/api/incidents?state=resolu")).data.incidents.length, 1);

  // Un nouvel incident est possible après résolution.
  assert.equal((await a.post(`/api/colis/${id}/incidents`, { type: "endommage", note: "Carton écrasé constaté ce jour." })).status, 201);
});

test("photos de preuve : 2 par étape, acteurs verrouillés, accès privé, jamais supprimables", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence PhotoA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence PhotoB", "Bouaké");
  await creerAgence(c, "Agence PhotoC", "Korhogo");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id })
  });
  const id = cree.data.parcel.id;

  // Validations : étape, type de contenu, data URL.
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "retrait", image: PNG_1PX })).status, 400);
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: "data:text/plain;base64,Ym9uam91cg==" })).status, 400);
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: "pas-une-image" })).status, 400);

  // Acteurs : prise en charge = expéditeur, arrivée = destination.
  assert.equal((await b.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: PNG_1PX })).status, 403);
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "arrivee", image: PNG_1PX })).status, 403);
  assert.equal((await c.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: PNG_1PX })).status, 404, "agence sans lien");

  const p1 = await a.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: PNG_1PX });
  assert.equal(p1.status, 201, JSON.stringify(p1.data));
  assert.equal(p1.data.photo.etape, "prise_en_charge");
  assert.equal(p1.data.photo.contentType, "image/png");
  assert.ok(p1.data.photo.sizeBytes > 0);
  assert.ok(p1.data.photo.agentName, "l'agent acteur est tracé");
  assert.equal("storageKey" in p1.data.photo, false, "la clé de stockage ne sort jamais de l'API");
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: PNG_1PX })).status, 201);
  assert.equal((await a.post(`/api/colis/${id}/photos`, { etape: "prise_en_charge", image: PNG_1PX })).status, 400, "2 max par étape");
  assert.equal((await b.post(`/api/colis/${id}/photos`, { etape: "arrivee", image: PNG_1PX })).status, 201);

  // Métadonnées : les deux agences, jamais la troisième.
  assert.equal((await a.get(`/api/colis/${id}/photos`)).data.photos.length, 3);
  assert.equal((await b.get(`/api/colis/${id}/photos`)).data.photos.length, 3);
  assert.equal((await c.get(`/api/colis/${id}/photos`)).status, 404);

  // Contenu binaire : session requise, agences concernées seulement.
  const anonyme = client();
  assert.equal((await anonyme.brut(`/api/photos/${p1.data.photo.id}`)).status, 401, "jamais public");
  assert.equal((await c.brut(`/api/photos/${p1.data.photo.id}`)).status, 404);
  const contenu = await b.brut(`/api/photos/${p1.data.photo.id}`);
  assert.equal(contenu.status, 200);
  assert.match(contenu.contentType, /image\/png/);
  assert.ok(contenu.buffer.length > 0);

  // Aucune suppression possible (chaîne de preuve).
  assert.equal((await a.call("DELETE", `/api/photos/${p1.data.photo.id}`)).status, 404);
  assert.equal((await a.call("DELETE", `/api/colis/${id}/photos`)).status, 404);
});

test("souffrance : liste > 7 jours, retour à l'expéditeur tracé, frais de magasinage en caisse", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence SouffA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence SouffB", "Bouaké");
  await creerAgence(c, "Agence SouffC", "Korhogo");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    payment: { status: "arrivee" },
    values: valeurs({ destinationAgencyId: agenceB.id, priceFCFA: "3500" })
  });
  const id = cree.data.parcel.id;
  await a.post(`/api/colis/${id}/progress`, {});
  await a.post(`/api/colis/${id}/progress`, {});
  const arrive = await b.post(`/api/colis/${id}/progress`, {});
  assert.equal(arrive.data.parcel.status, "Arrivé à l'agence de destination");

  // Rien en souffrance avant 7 jours.
  assert.deepEqual((await b.get("/api/souffrance")).data.souffrance, []);
  await antidaterArrivee(id, 8);

  const souffranceB = await b.get("/api/souffrance");
  assert.equal(souffranceB.data.souffrance.length, 1);
  assert.equal(souffranceB.data.souffrance[0].id, id);
  assert.ok(souffranceB.data.souffrance[0].jours >= 8);
  assert.equal((await a.get("/api/souffrance")).data.souffrance.length, 1, "l'expéditeur voit aussi la souffrance");
  assert.deepEqual((await c.get("/api/souffrance")).data.souffrance, []);

  // Retour : gardes d'acteur, d'état et de mode de paiement.
  assert.equal((await c.post(`/api/colis/${id}/retour`, { etape: "decider" })).status, 404);
  assert.equal((await a.post(`/api/colis/${id}/retour`, { etape: "decider" })).status, 403, "l'expéditeur ne décide pas quand la destination est rattachée");
  assert.equal((await b.post(`/api/colis/${id}/retour`, { etape: "decider", fraisMagasinageFCFA: 1500, mode: "cheque" })).status, 400);
  assert.equal((await b.post(`/api/colis/${id}/retour`, { etape: "recevoir" })).status, 403, "la réception appartient à l'expéditeur");

  const decider = await b.post(`/api/colis/${id}/retour`, { etape: "decider", fraisMagasinageFCFA: 1500, mode: "especes" });
  assert.equal(decider.status, 200, JSON.stringify(decider.data));
  assert.equal(decider.data.parcel.retourStatus, "en_cours");
  const derniere = decider.data.parcel.history[decider.data.parcel.history.length - 1];
  assert.equal(derniere.status, "Retour à l'expéditeur décidé");
  assert.match(derniere.note, /magasinage/);
  assert.equal(decider.data.parcel.status, "Arrivé à l'agence de destination", "les 5 statuts ne changent pas");

  // Les frais de magasinage alimentent la caisse du jour de B.
  const caisse = await b.get(`/api/caisse?date=${jourCleTest()}`);
  const ligne = caisse.data.encaissements.find((e) => e.parcelId === id);
  assert.ok(ligne, "frais de magasinage encaissés");
  assert.equal(ligne.amountFCFA, 1500);
  assert.equal(ligne.label, "Frais de magasinage");

  // Pas de double décision ; réception par l'expéditeur.
  assert.equal((await b.post(`/api/colis/${id}/retour`, { etape: "decider" })).status, 409);
  const recevoir = await a.post(`/api/colis/${id}/retour`, { etape: "recevoir" });
  assert.equal(recevoir.status, 200);
  assert.equal(recevoir.data.parcel.retourStatus, "termine");
  const fin = recevoir.data.parcel.history[recevoir.data.parcel.history.length - 1];
  assert.equal(fin.status, "Colis retourné à l'expéditeur");
  assert.equal((await a.post(`/api/colis/${id}/retour`, { etape: "recevoir" })).status, 400);
  assert.equal((await b.post(`/api/colis/${id}/retour`, { etape: "decider" })).status, 409, "déjà retourné");
  assert.deepEqual((await b.get("/api/souffrance")).data.souffrance, [], "un retour terminé sort de la souffrance");
});

test("alertes « colis qui dorment » : 48 h sans mouvement, 72 h non retiré, 7 j non rattaché", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence AlertA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence AlertB", "Bouaké");

  // Colis 1 : expédié, sans mouvement depuis 3 jours.
  const c1 = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id, recipientPhone: "0500000111" })
  });
  await a.post(`/api/colis/${c1.data.parcel.id}/progress`, {});
  await query("UPDATE parcels SET updated_at = now() - interval '3 days' WHERE id = $1", [c1.data.parcel.id]);

  // Colis 2 : destination non rattachée depuis 8 jours.
  const c2 = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", recipientPhone: "0500000112",
      declaredAgencyName: "Flash Alert", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000009"
    })
  });
  await query("UPDATE parcels SET created_at = now() - interval '8 days', created_at_iso = $1, updated_at = now() - interval '8 days' WHERE id = $2", [
    joursAvant(8), c2.data.parcel.id
  ]);

  // Colis 3 : arrivé non retiré depuis 4 jours (72 h, pas encore 7 j).
  const c3 = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id, recipientPhone: "0500000113" })
  });
  await a.post(`/api/colis/${c3.data.parcel.id}/progress`, {});
  await a.post(`/api/colis/${c3.data.parcel.id}/progress`, {});
  await b.post(`/api/colis/${c3.data.parcel.id}/progress`, {});
  await antidaterArrivee(c3.data.parcel.id, 4);

  const alertes = await a.get("/api/alertes");
  assert.equal(alertes.status, 200);
  const groupes = alertes.data.alertes;
  assert.deepEqual(groupes.sans_mouvement.map((item) => item.id), [c1.data.parcel.id]);
  assert.deepEqual(groupes.non_rattache.map((item) => item.id), [c2.data.parcel.id]);
  assert.deepEqual(groupes.non_retire.map((item) => item.id), [c3.data.parcel.id]);
  assert.deepEqual(groupes.souffrance.map((item) => item.id), [], "4 jours : pas encore en souffrance");
  assert.ok(alertes.data.total >= 3);

  // La destination voit les signaux de SES colis.
  const alertesB = await b.get("/api/alertes");
  assert.deepEqual(alertesB.data.alertes.non_retire.map((item) => item.id), [c3.data.parcel.id]);
  assert.deepEqual(alertesB.data.alertes.non_rattache, [], "le colis non rattaché appartient à A seule");

  // Au 8e jour, le colis non retiré bascule aussi en souffrance.
  await antidaterArrivee(c3.data.parcel.id, 9);
  const apres = await b.get("/api/alertes");
  assert.deepEqual(apres.data.alertes.souffrance.map((item) => item.id), [c3.data.parcel.id]);
  assert.equal((await b.get("/api/souffrance")).data.souffrance.length, 1);
});

test("limite Hobby Vercel : les rewrites ?action=… sont redépliés vers les routes imbriquées", async () => {
  const a = client();
  await creerAgence(a, "Agence PliAction", "Abidjan");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationCity: "Man", declaredAgencyName: "Flash Pli", declaredAgencyCity: "Man", declaredAgencyPhone: "0700000188" })
  });
  const id = cree.data.parcel.id;

  // La forme repliée (celle que Vercel sert après rewrite) avance le colis.
  const via = await a.post(`/api/colis/${id}?action=progress`, {});
  assert.equal(via.status, 200, JSON.stringify(via.data));
  assert.equal(via.data.parcel.status, "Expédié");

  // L'URL directe fonctionne toujours telle quelle (local, npm start, tests).
  const direct = await a.post(`/api/colis/${id}/progress`, {});
  assert.equal(direct.status, 200);
  assert.equal(direct.data.parcel.status, "En transit");

  // Une action inconnue ne crée aucune route.
  assert.equal((await a.post(`/api/colis/${id}?action=inconnue`, {})).status, 404);
});

test.after(() => {
  server.close();
});

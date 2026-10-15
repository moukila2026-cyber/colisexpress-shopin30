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

/* --------------------------- notifications (LOT 5) ------------------------- */

const { TRANSPORTS, envoyerNotification } = await import("../lib/notifications.js");

/** Journal d'une agence (la lecture déclenche aussi le balayage des échéances). */
async function journal(clientHttp, filtre = () => true) {
  const res = await clientHttp.get("/api/notifications");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.notifications.filter(filtre);
}

const DONNEES_PERSONNELLES_TEST = ["Awa", "Traore", "Ibrahim", "Kone", "0700000001", "0500000002", "CI12345678", "ci12345678"];

function aucuneDonneePersonnelle(valeur, contexte) {
  const brut = JSON.stringify(valeur);
  for (const sensible of DONNEES_PERSONNELLES_TEST) {
    assert.ok(!brut.includes(sensible), `${contexte} : « ${sensible} » ne doit jamais sortir dans une notification`);
  }
}

test("notifications : incident ouvert → les deux agences, journal cloisonné, sans donnée personnelle", async () => {
  const a = client();
  const b = client();
  const c = client();
  await creerAgence(a, "Agence NotifA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence NotifB", "Bouaké");
  await creerAgence(c, "Agence NotifC", "Korhogo");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id })
  });
  const id = cree.data.parcel.id;
  const code = cree.data.parcel.trackingCode;

  // Session obligatoire.
  assert.equal((await client().get("/api/notifications")).status, 401);
  assert.equal((await client().post("/api/notifications/lecture", { toutes: true })).status, 401);

  // Journal vide au départ, mode simulation par défaut.
  const vide = await a.get("/api/notifications");
  assert.deepEqual(vide.data.notifications, []);
  assert.equal(vide.data.nonLues, 0);
  assert.equal(vide.data.configuration.canal, "simulation");
  assert.equal(vide.data.configuration.simulation, true);

  const ouvert = await b.post(`/api/colis/${id}/incidents`, {
    type: "retard",
    note: "Ibrahim Kone a appelé au 0500000002, très inquiet."
  });
  assert.equal(ouvert.status, 201, JSON.stringify(ouvert.data));

  for (const agence of [a, b]) {
    const liste = await journal(agence);
    assert.equal(liste.length, 1, "une notification par agence concernée");
    const [notification] = liste;
    assert.equal(notification.type, "incident_ouvert");
    assert.equal(notification.canal, "simulation");
    assert.equal(notification.statut, "simule", "aucun envoi réel sans configuration");
    assert.equal(notification.lu, false);
    assert.equal(notification.parcelId, id);
    assert.equal(notification.incidentId, ouvert.data.incident.id);
    assert.equal(notification.lien, `colis.html?id=${id}`);
    assert.match(notification.message, new RegExp(code));
    assert.match(notification.message, /Retard/);
    aucuneDonneePersonnelle(notification, "incident_ouvert");
    assert.ok(!JSON.stringify(notification).includes("inquiet"), "la note libre ne sort jamais");
  }
  assert.deepEqual(await journal(c), [], "une agence sans lien ne reçoit rien");

  // Compteur léger (badge de la barre latérale) puis marquage « lu » cloisonné.
  assert.equal((await a.get("/api/notifications?resume=1")).data.nonLues, 1);
  const notifA = (await journal(a))[0];
  assert.equal((await c.post("/api/notifications/lecture", { ids: [notifA.id] })).data.nonLues, 0);
  assert.equal((await a.get("/api/notifications?resume=1")).data.nonLues, 1, "une autre agence ne marque jamais lu à sa place");
  assert.equal((await a.post("/api/notifications/lecture", {})).status, 400);
  assert.equal((await a.post("/api/notifications/lecture", { ids: "pas-une-liste" })).status, 400);
  const lu = await a.post("/api/notifications/lecture", { ids: [notifA.id] });
  assert.equal(lu.status, 200);
  assert.equal(lu.data.nonLues, 0);
  assert.equal((await journal(a))[0].lu, true);
  assert.equal((await b.get("/api/notifications?resume=1")).data.nonLues, 1, "B garde sa propre notification non lue");

  // Forme repliée par le rewrite Vercel, équivalente ; aucune suppression.
  const replie = await b.post("/api/notifications?action=lecture", { toutes: true });
  assert.equal(replie.status, 200, JSON.stringify(replie.data));
  assert.equal(replie.data.nonLues, 0);
  assert.equal((await a.call("DELETE", "/api/notifications")).status, 404);
  assert.equal((await a.call("DELETE", `/api/notifications/${notifA.id}`)).status, 404);
});

test("notifications : bordereau arrivé puis écart au contrôle → les deux agences, incident automatique notifié", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence NotifBordA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence NotifBordB", "Bouaké");
  const ids = [];
  const codes = [];
  for (let i = 0; i < 2; i += 1) {
    const cree = await a.post("/api/colis", {
      agencyNotRegistered: false,
      values: valeurs({ destinationAgencyId: agenceB.id, recipientPhone: `0500000${200 + i}` })
    });
    ids.push(cree.data.parcel.id);
    codes.push(cree.data.parcel.trackingCode);
  }
  const ok = await a.post("/api/bordereaux", { carrierName: "Gbaka Express", carrierPhone: "0700000055", parcelIds: ids });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const bordereau = ok.data.bordereau;
  await a.post(`/api/bordereaux/${bordereau.id}/remettre`, {});
  await a.post(`/api/bordereaux/${bordereau.id}/remettre`, {});
  assert.deepEqual(await journal(a, (n) => n.bordereauId === bordereau.id), [], "rien avant l'arrivée du lot");

  assert.equal((await b.post(`/api/bordereaux/${bordereau.id}/remettre`, {})).data.bordereau.status, "Arrivé");
  for (const agence of [a, b]) {
    const arrivee = await journal(agence, (n) => n.type === "bordereau_arrive");
    assert.equal(arrivee.length, 1);
    assert.equal(arrivee[0].bordereauId, bordereau.id);
    assert.equal(arrivee[0].lien, `bordereaux.html?id=${bordereau.id}`);
    assert.match(arrivee[0].message, new RegExp(`${bordereau.code} \\(Abidjan → Bouaké, 2 colis\\)`));
  }

  const controle = await b.post(`/api/bordereaux/${bordereau.id}/controle`, { absentParcelIds: [ids[1]] });
  assert.equal(controle.status, 201, JSON.stringify(controle.data));
  for (const agence of [a, b]) {
    const liste = await journal(agence);
    const ecart = liste.filter((n) => n.type === "bordereau_ecart");
    assert.equal(ecart.length, 1, "l'écart est notifié une fois à chaque agence");
    assert.match(ecart[0].message, new RegExp(codes[1]));
    assert.ok(!ecart[0].message.includes(codes[0]), "seuls les absents sont cités");
    const automatique = liste.filter((n) => n.type === "incident_ouvert");
    assert.equal(automatique.length, 1, "l'incident automatique est notifié");
    assert.equal(automatique[0].parcelId, ids[1]);
    assert.equal(automatique[0].bordereauId, bordereau.id);
    assert.match(automatique[0].message, /automatiquement/);
    aucuneDonneePersonnelle(liste, "bordereau");
    const brut = JSON.stringify(liste);
    assert.ok(!brut.includes("0700000055") && !brut.includes("Gbaka"), "ni téléphone ni nom du transporteur");
  }
});

test("notifications : souffrance puis retour décidé/reçu → les deux agences, une seule fois", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence NotifSouffA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence NotifSouffB", "Bouaké");
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id })
  });
  const id = cree.data.parcel.id;
  await a.post(`/api/colis/${id}/progress`, {});
  await a.post(`/api/colis/${id}/progress`, {});
  await b.post(`/api/colis/${id}/progress`, {});
  assert.deepEqual(await journal(b, (n) => n.parcelId === id), [], "arrivé à l'instant : rien à signaler");
  await antidaterArrivee(id, 8);

  // Le balayage déclenché par B notifie aussi A (compteur sans balayage).
  const typesB = (await journal(b, (n) => n.parcelId === id)).map((n) => n.type).sort();
  assert.deepEqual(typesB, ["alerte_non_retire", "colis_souffrance"]);
  assert.equal((await a.get("/api/notifications?resume=1")).data.nonLues, 2, "les deux agences concernées sont notifiées");

  // Balayages répétés (tableau de bord, journal) : jamais de doublon.
  await b.get("/api/alertes");
  await a.get("/api/alertes");
  await b.get("/api/alertes");
  assert.equal((await journal(a, (n) => n.parcelId === id)).length, 2);
  assert.equal((await journal(b, (n) => n.parcelId === id)).length, 2);
  const souffrance = (await journal(a, (n) => n.type === "colis_souffrance"))[0];
  assert.match(souffrance.message, /depuis 8 jours/);
  aucuneDonneePersonnelle(souffrance, "souffrance");

  assert.equal((await b.post(`/api/colis/${id}/retour`, { etape: "decider" })).status, 200);
  assert.equal((await a.post(`/api/colis/${id}/retour`, { etape: "recevoir" })).status, 200);
  for (const agence of [a, b]) {
    const types = (await journal(agence, (n) => n.parcelId === id)).map((n) => n.type);
    assert.equal(types.filter((t) => t === "retour_decide").length, 1);
    assert.equal(types.filter((t) => t === "retour_recu").length, 1);
    assert.equal(types.length, 4, "retour terminé : l'épisode de souffrance est clos, rien de nouveau");
  }
});

test("notifications : échéances (escalade 24 h, colis qui dorment) détectées au fil de l'eau, une fois par épisode", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence NotifEchA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence NotifEchB", "Bouaké");

  // Colis 1 : expédié, sans mouvement depuis 3 jours, incident ouvert il y a 2 jours.
  const c1 = await a.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId: agenceB.id, recipientPhone: "0500000311" })
  });
  const id1 = c1.data.parcel.id;
  await a.post(`/api/colis/${id1}/progress`, {});
  const incident = await a.post(`/api/colis/${id1}/incidents`, { type: "retard", note: "Car en panne à Yamoussoukro." });
  await query("UPDATE incidents SET opened_at_iso = $1 WHERE id = $2", [joursAvant(2), incident.data.incident.id]);
  await query("UPDATE parcels SET updated_at = now() - interval '3 days' WHERE id = $1", [id1]);

  // Colis 2 : destination non rattachée depuis 8 jours (concerne A seule).
  const c2 = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({
      destinationAgencyId: "", recipientPhone: "0500000312",
      declaredAgencyName: "Flash Notif", declaredAgencyCity: "Korhogo", declaredAgencyPhone: "0700000019"
    })
  });
  const id2 = c2.data.parcel.id;
  await query("UPDATE parcels SET created_at = now() - interval '8 days', created_at_iso = $1, updated_at = now() - interval '8 days' WHERE id = $2", [
    joursAvant(8), id2
  ]);

  // Le tableau de bord (GET /api/alertes, rafraîchi toutes les 20 s) déclenche le balayage
  // et renvoie le compteur de non lues (badge mis à jour sans requête de plus).
  const tableauDeBord = await a.get("/api/alertes");
  assert.equal(tableauDeBord.status, 200);
  assert.equal(tableauDeBord.data.notificationsNonLues, 4, "incident ouvert + escalade + sans mouvement + non rattaché");
  const typesA = (await journal(a)).map((n) => `${n.type}:${n.parcelId}`).sort();
  assert.deepEqual(typesA, [
    `alerte_non_rattache:${id2}`,
    `alerte_sans_mouvement:${id1}`,
    `incident_escalade:${id1}`,
    `incident_ouvert:${id1}`
  ].sort());
  const typesB = (await journal(b)).map((n) => n.type).sort();
  assert.deepEqual(typesB, ["alerte_sans_mouvement", "incident_escalade", "incident_ouvert"], "B n'est pas concernée par le colis non rattaché");
  const escalade = (await journal(b, (n) => n.type === "incident_escalade"))[0];
  assert.match(escalade.message, /ouvert depuis 2 jours/);
  assert.ok(!escalade.message.includes("Yamoussoukro"), "la note de l'incident ne sort pas");

  // Balayages répétés : aucune nouvelle notification.
  for (let i = 0; i < 3; i += 1) await b.get("/api/alertes");
  assert.equal((await journal(a)).length, 4);
  assert.equal((await journal(b)).length, 3);

  // Nouvel épisode : le colis bouge puis redort → nouvelle notification « sans mouvement ».
  await a.post(`/api/colis/${id1}/progress`, {});
  await query("UPDATE parcels SET updated_at = now() - interval '3 days' WHERE id = $1", [id1]);
  const sansMouvement = await journal(a, (n) => n.type === "alerte_sans_mouvement");
  assert.equal(sansMouvement.length, 2, "un colis qui redort est renotifié");
  assert.match(sansMouvement[0].message, /« En transit » sans mouvement/);
});

test("notifications : fonction d'envoi unique — dédoublonnage, panne journalisée, jamais bloquante, transport branchable", async () => {
  const a = client();
  const agence = await creerAgence(a, "Agence NotifEnvoi", "Abidjan");
  const base = {
    agencyId: agence.id, type: "retour_recu", titre: "Essai", message: "Message d'essai sans donnée personnelle.",
    lien: "", cle: `essai:${agence.id}:1`
  };

  const premier = await envoyerNotification(base);
  assert.deepEqual({ canal: premier.canal, statut: premier.statut }, { canal: "simulation", statut: "simule" });
  assert.equal(await envoyerNotification(base), null, "même clé : jamais notifiée deux fois");

  // Transport en panne : statut « echec » journalisé, aucune exception, aucun détail sensible.
  const enPanne = {
    simulation: { ...TRANSPORTS.simulation, envoyer: async () => { throw new Error("connexion refusée https://exemple.invalid?token=secret-123"); } }
  };
  const echec = await envoyerNotification({ ...base, cle: `essai:${agence.id}:2` }, { transports: enPanne });
  assert.equal(echec.statut, "echec");

  // Transport branché ET configuré : envoi réel vers les coordonnées professionnelles de l'agence.
  const envois = [];
  const branche = {
    ...TRANSPORTS,
    whatsapp: { ...TRANSPORTS.whatsapp, envoyer: async (envoi) => { envois.push(envoi); return { statut: "envoye" }; } }
  };
  const env = { NOTIFICATIONS_CANAL: "whatsapp", WHATSAPP_API_URL: "https://exemple.invalid", WHATSAPP_API_TOKEN: "jeton-test" };
  const reel = await envoyerNotification({ ...base, cle: `essai:${agence.id}:3` }, { transports: branche, env });
  assert.deepEqual({ canal: reel.canal, statut: reel.statut }, { canal: "whatsapp", statut: "envoye" });
  assert.equal(envois.length, 1);
  assert.equal(envois[0].destinataire.id, agence.id);
  assert.equal(envois[0].destinataire.phone, "0700000001", "coordonnées de l'agence, jamais d'un client");
  assert.equal(envois[0].message, base.message);

  const liste = await journal(a);
  assert.deepEqual(liste.map((n) => n.statut).sort(), ["echec", "envoye", "simule"]);
  const ligneEchec = liste.find((n) => n.statut === "echec");
  assert.match(ligneEchec.erreur, /Échec de l'envoi/);
  assert.ok(!JSON.stringify(liste).includes("secret-123"), "aucun détail technique sensible journalisé");
  assert.ok(!JSON.stringify(await a.get("/api/notifications")).includes("jeton-test"));

  // Journal indisponible : l'opération métier aboutit quand même.
  const cree = await a.post("/api/colis", {
    agencyNotRegistered: true,
    values: valeurs({ destinationCity: "Man", declaredAgencyName: "Flash Panne", declaredAgencyCity: "Man", declaredAgencyPhone: "0700000177" })
  });
  await query("ALTER TABLE notifications RENAME TO notifications_hors_service");
  try {
    const ouvert = await a.post(`/api/colis/${cree.data.parcel.id}/incidents`, { type: "bloque", note: "Colis retenu au contrôle routier." });
    assert.equal(ouvert.status, 201, "une panne de notification ne bloque jamais l'opération");
  } finally {
    await query("ALTER TABLE notifications_hors_service RENAME TO notifications");
  }
});

/* -------------------- LOT 6 — plans, quotas, portefeuille, console ------------------- */

const { createPlatformToken, createSessionToken, hashPassword } = await import("../lib/auth.js");
const { ouvrirPeriode } = await import("../lib/facturation.js");

let adminsCrees = 0;
/** Compte plateforme créé directement en base (en production : npm run plateforme-admin). */
async function consolePlateforme() {
  adminsCrees += 1;
  const id = `admin-test-${adminsCrees}`;
  const email = `console${adminsCrees}@plateforme.test`;
  await query(
    "INSERT INTO plateforme_admins (id, email, name, password_hash, active, created_at_iso) VALUES ($1, $2, $3, $4, TRUE, $5)",
    [id, email, `Console Test ${adminsCrees}`, hashPassword("console-secret-123"), new Date().toISOString()]
  );
  const p = client();
  const connexion = await p.post("/api/plateforme/connexion", { email, password: "console-secret-123" });
  assert.equal(connexion.status, 200, JSON.stringify(connexion.data));
  return { p, id, email };
}

async function facturation(clientHttp) {
  const res = await clientHttp.get("/api/facturation");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.facturation;
}

async function fixerCompteur(agencyId, colis) {
  await query("UPDATE facturation_periodes SET colis_comptes = $2 WHERE agency_id = $1", [agencyId, colis]);
}

function nouveauColis(clientHttp, destinationAgencyId, i = 0) {
  return clientHttp.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId, recipientPhone: `0500000${300 + i}` })
  });
}

test("abonnement : Gratuit par défaut, 50 colis inclus puis 30 FCFA prépayés, refus net (402) sans solde", async () => {
  const a = client();
  const b = client();
  const agenceA = await creerAgence(a, "Agence QuotaA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence QuotaB", "Bouaké");

  const initiale = await facturation(a);
  assert.equal(initiale.plan, "gratuit");
  assert.equal(initiale.periode.compteur, 0);
  assert.equal(initiale.periode.quotaEffectif, 50);
  assert.equal(initiale.portefeuille.soldeFCFA, 0);
  assert.deepEqual(initiale.echeances, [], "le Gratuit n'a pas d'abonnement");
  assert.deepEqual(Object.keys(initiale.plans), ["gratuit", "pro", "reseau"]);
  assert.equal(initiale.peutModifier, true);

  const premier = await nouveauColis(a, agenceB.id);
  assert.equal(premier.status, 201, JSON.stringify(premier.data));
  assert.deepEqual(premier.data.facturation, { periode: initiale.periode.cle, type: "inclus", montantFCFA: 0 });

  // 50 colis déjà enregistrés ce mois-ci : le 51e demande 30 FCFA prépayés.
  await fixerCompteur(agenceA.id, 50);
  const refuse = await nouveauColis(a, agenceB.id, 1);
  assert.equal(refuse.status, 402);
  assert.equal(refuse.data.quotaAtteint, true);
  assert.match(refuse.data.error, /quota du plan Gratuit est atteint \(50 colis/);
  assert.match(refuse.data.error, /solde : 0 FCFA/);
  assert.equal((await a.get("/api/colis")).data.parcels.length, 1, "aucun colis créé");
  assert.equal((await facturation(a)).periode.compteur, 50, "le rang réservé est rendu");

  const { p } = await consolePlateforme();
  const recharge = await p.post("/api/plateforme/credit", { agencyId: agenceA.id, montantFCFA: 60, reference: "MM-QUOTA-1" });
  assert.equal(recharge.status, 201, JSON.stringify(recharge.data));
  assert.equal(recharge.data.soldeFCFA, 60);

  const horsForfait1 = await nouveauColis(a, agenceB.id, 2);
  assert.equal(horsForfait1.status, 201, JSON.stringify(horsForfait1.data));
  assert.deepEqual(horsForfait1.data.facturation, { periode: initiale.periode.cle, type: "depassement", montantFCFA: 30, soldeApresFCFA: 30 });
  const horsForfait2 = await nouveauColis(a, agenceB.id, 3);
  assert.equal(horsForfait2.data.facturation.soldeApresFCFA, 0);
  assert.equal((await nouveauColis(a, agenceB.id, 4)).status, 402, "portefeuille vide : refus");

  const etat = await facturation(a);
  assert.equal(etat.periode.compteur, 52);
  assert.equal(etat.periode.depassements, 2);
  assert.equal(etat.portefeuille.soldeFCFA, 0);
  const [m1, m2, m3] = etat.portefeuille.mouvements;
  assert.deepEqual([m1.type, m1.montantFCFA, m1.soldeApresFCFA], ["depassement", -30, 0]);
  assert.equal(m1.libelle, `Colis hors forfait — ${horsForfait2.data.parcel.trackingCode}`);
  assert.equal(m1.parcelId, horsForfait2.data.parcel.id);
  assert.deepEqual([m2.type, m2.montantFCFA, m2.soldeApresFCFA], ["depassement", -30, 30]);
  assert.deepEqual([m3.type, m3.montantFCFA, m3.soldeApresFCFA, m3.reference], ["recharge", 60, 60, "MM-QUOTA-1"]);
  assert.match(m3.acteurNom, /Console Test/);

  // Résumé léger (formulaire « Nouveau colis ») et aucune route de suppression.
  const resume = await a.get("/api/facturation?resume=1");
  assert.equal(resume.data.resume.prochainColis.type, "depassement");
  assert.match(resume.data.resume.alerte, /portefeuille insuffisant/);
  const suppression = await fetch(`${BASE}/api/facturation`, { method: "DELETE" });
  assert.equal(suppression.status, 404);
});

test("la destination ne paie jamais, et un solde impayé ne bloque jamais un colis en cours", async () => {
  const a = client();
  const b = client();
  const agenceA = await creerAgence(a, "Agence InfiniA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence InfiniB", "Bouaké");
  // La destination est elle-même au quota, portefeuille vide.
  await facturation(b);
  await fixerCompteur(agenceB.id, 50);

  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const cree = await nouveauColis(a, agenceB.id, 10 + i);
    assert.equal(cree.status, 201, JSON.stringify(cree.data));
    ids.push(cree.data.parcel.id);
  }
  assert.equal((await facturation(b)).periode.compteur, 50, "les colis reçus ne sont jamais comptés à la destination");
  assert.equal((await facturation(a)).periode.compteur, 2);

  // L'expéditrice passe au Pro sans solde, échéance dépassée : quota ramené à 50,
  // portefeuille vide — la CRÉATION est refusée…
  assert.equal((await a.post("/api/facturation/plan", { plan: "pro" })).status, 200);
  await query("UPDATE facturation_periodes SET echeance_iso = $2, colis_comptes = 60 WHERE agency_id = $1", [agenceA.id, joursAvant(1)]);
  const etatA = await facturation(a);
  assert.equal(etatA.periode.abonnement.enRetard, true);
  assert.equal(etatA.periode.quotaEffectif, 50);
  const refuse = await nouveauColis(a, agenceB.id, 20);
  assert.equal(refuse.status, 402);
  assert.match(refuse.data.error, /impayé après son échéance/);

  // … mais tout ce qui est en cours continue, des deux côtés.
  assert.equal((await a.get("/api/colis")).status, 200);
  assert.equal((await a.get(`/api/colis/${ids[0]}`)).status, 200);
  assert.equal((await a.post(`/api/colis/${ids[0]}/progress`, {})).status, 200, "progression garantie");
  const lot = await a.post("/api/bordereaux", { carrierName: "UTB", carrierPhone: "0700000077", parcelIds: [ids[1]] });
  assert.equal(lot.status, 201, JSON.stringify(lot.data));
  assert.equal((await a.post(`/api/bordereaux/${lot.data.bordereau.id}/remettre`, {})).status, 200);
  assert.equal((await a.post(`/api/bordereaux/${lot.data.bordereau.id}/remettre`, {})).status, 200);
  assert.equal((await b.post(`/api/bordereaux/${lot.data.bordereau.id}/remettre`, {})).status, 200, "arrivée déclarée par la destination");
  assert.equal((await b.post(`/api/bordereaux/${lot.data.bordereau.id}/controle`, { absentParcelIds: [] })).status, 201, "contrôle garanti");
  const retrait = await b.post(`/api/colis/${ids[1]}/progress`, { collectedBy: { name: "Destinataire Test", cni: "CI99887766" } });
  assert.equal(retrait.status, 200, JSON.stringify(retrait.data));
  assert.equal(retrait.data.parcel.status, "Retiré", "retrait garanti");
  const code = (await a.get(`/api/colis/${ids[1]}`)).data.parcel.trackingCode;
  assert.equal((await client().get(`/api/suivi/${code}`)).status, 200, "suivi public garanti");

  const etatB = await facturation(b);
  assert.equal(etatB.periode.compteur, 50);
  assert.equal(etatB.portefeuille.soldeFCFA, 0);
  assert.deepEqual(etatB.portefeuille.mouvements, [], "rien n'a jamais été prélevé à la destination");
});

test("abonnement Pro : gérant seul, prélèvement automatique, échéance, retour au Gratuit le mois suivant", async () => {
  const g = client();
  const agence = await creerAgence(g, "Agence ProG", "Abidjan");
  const { p } = await consolePlateforme();
  const invite = await g.post("/api/agents", { name: "Agent Pro", email: compteUnique("agentpro"), password: "agent12" });
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  const agent = client();
  assert.equal((await agent.post("/api/login", { email: invite.data.agent.email, password: "agent12" })).status, 200);

  assert.equal((await p.post("/api/plateforme/credit", { agencyId: agence.id, montantFCFA: 12000, reference: "MM-PRO-1" })).status, 201);
  const lectureAgent = await facturation(agent);
  assert.equal(lectureAgent.peutModifier, false, "l'agent lit l'abonnement sans pouvoir le modifier");
  const interdit = await agent.post("/api/facturation/plan", { plan: "pro" });
  assert.equal(interdit.status, 403);
  assert.match(interdit.data.error, /Seul le gérant/);
  assert.equal((await agent.post("/api/facturation/abonnement", {})).status, 403);

  const pro = await g.post("/api/facturation/plan", { plan: "pro" });
  assert.equal(pro.status, 200, JSON.stringify(pro.data));
  assert.equal(pro.data.effet, "immediat");
  assert.equal(pro.data.facturation.plan, "pro");
  assert.equal(pro.data.facturation.periode.quotaEffectif, 500);
  assert.equal(pro.data.facturation.periode.abonnement.statut, "paye", "prélevé tout de suite : le solde suffit");
  assert.equal(pro.data.facturation.portefeuille.soldeFCFA, 2000);
  assert.deepEqual(
    [pro.data.facturation.portefeuille.mouvements[0].type, pro.data.facturation.portefeuille.mouvements[0].montantFCFA],
    ["abonnement", -10000]
  );
  assert.match(pro.data.facturation.portefeuille.mouvements[0].libelle, /^Abonnement Pro — /);
  assert.equal((await g.post("/api/facturation/abonnement", {})).status, 400, "rien à régler");
  assert.match((await g.post("/api/facturation/plan", { plan: "pro" })).data.error, /déjà au plan Pro/);
  assert.match((await g.post("/api/facturation/plan", { plan: "reseau" })).data.error, /sur devis/);

  // Retour au Gratuit : programmé au mois suivant (le mois payé reste acquis), annulable.
  const retour = await g.post("/api/facturation/plan", { plan: "gratuit" });
  assert.equal(retour.data.effet, "periode_suivante");
  assert.equal(retour.data.facturation.plan, "pro");
  assert.equal(retour.data.facturation.planSuivant, "gratuit");
  assert.deepEqual(retour.data.facturation.echeances, [], "plus d'échéance après un retour programmé");
  const annule = await g.post("/api/facturation?action=plan", { plan: "pro" });
  assert.equal(annule.status, 200, "forme repliée Vercel /api/facturation?action=plan");
  assert.equal(annule.data.effet, "annulation");
  assert.equal(annule.data.facturation.planSuivant, null);
  assert.equal(annule.data.facturation.echeances[0].statut, "a_venir");

  // Le retour programmé s'applique à l'ouverture du mois suivant.
  await g.post("/api/facturation/plan", { plan: "gratuit" });
  const debutMoisSuivant = new Date(annule.data.facturation.periode.finISO);
  const suivante = await ouvrirPeriode(agence.id, new Date(debutMoisSuivant.getTime() + 3600000));
  assert.equal(suivante.plan, "gratuit");
  assert.equal(suivante.quota, 50);
  assert.equal(suivante.abonnement_statut, "sans_frais");
  const { rows } = await query("SELECT plan, plan_suivant FROM agencies WHERE id = $1", [agence.id]);
  assert.deepEqual(rows[0], { plan: "gratuit", plan_suivant: null });

  // Pro sans solde : abonnement dû (échéance J+7), règlement refusé puis automatique à la recharge.
  const c = client();
  const agenceC = await creerAgence(c, "Agence ProC", "Bouaké");
  const proC = await c.post("/api/facturation/plan", { plan: "pro" });
  assert.equal(proC.data.facturation.periode.abonnement.statut, "du");
  assert.equal(proC.data.facturation.periode.abonnement.enRetard, false);
  const delai = new Date(proC.data.facturation.periode.abonnement.echeanceISO).getTime() - Date.now();
  assert.ok(delai > 6.9 * 86400000 && delai <= 7 * 86400000, "échéance à 7 jours");
  assert.equal(proC.data.facturation.echeances[0].statut, "a_regler");
  const insuffisant = await c.post("/api/facturation/abonnement", {});
  assert.equal(insuffisant.status, 402);
  assert.match(insuffisant.data.error, /il manque 10000 FCFA/);
  const rechargeC = await p.post("/api/plateforme/credit", { agencyId: agenceC.id, montantFCFA: 10000, reference: "MM-PRO-2" });
  assert.equal(rechargeC.data.abonnementRegle, true);
  assert.equal(rechargeC.data.soldeFCFA, 0, "solde final après règlement automatique");
  assert.equal((await facturation(c)).periode.abonnement.statut, "paye");
});

test("console plateforme : compte séparé, file > 7 j, litiges, agences et volumes, Réseau négocié et recharge", async () => {
  const a = client();
  const b = client();
  const agenceA = await creerAgence(a, "Agence ConsoleA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence ConsoleB", "Bouaké");
  const { p, id: adminId, email } = await consolePlateforme();

  // Séparation stricte des comptes et des sessions.
  assert.equal((await client().post("/api/plateforme/connexion", { email, password: "faux" })).status, 401);
  assert.equal((await client().post("/api/plateforme/connexion", { email: "inconnu@plateforme.test", password: "x" })).status, 401);
  assert.equal((await client().post("/api/plateforme/connexion", { email: agenceA.email, password: "secret12" })).status, 401, "un compte agence n'ouvre pas la console");
  assert.equal((await a.get("/api/plateforme")).status, 401, "session agence refusée sur la console");
  assert.equal((await p.get("/api/me")).status, 401, "session plateforme refusée sur les routes agence");
  assert.equal((await p.get("/api/colis")).status, 401);
  const jetonAgence = createSessionToken(agenceA.id);
  assert.equal((await fetch(`${BASE}/api/plateforme`, { headers: { Cookie: `ce_plateforme=${jetonAgence}` } })).status, 401, "jeton d'agence placé dans le cookie plateforme");
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { Cookie: `ce_session=${createPlatformToken(adminId)}` } })).status, 401, "jeton plateforme placé dans le cookie agence");
  assert.equal((await client().post("/api/plateforme?action=connexion", { email, password: "console-secret-123" })).status, 200, "forme repliée Vercel");

  // Données : un incident perdu ouvert il y a 8 jours (file > 7 j) et un litige récent.
  const colis1 = (await nouveauColis(a, agenceB.id, 40)).data.parcel;
  const colis2 = (await nouveauColis(a, agenceB.id, 41)).data.parcel;
  const perdu = await a.post(`/api/colis/${colis1.id}/incidents`, { type: "perdu", note: "Recherche en cours, Awa Traore prévenue au 0700000001." });
  assert.equal(perdu.status, 201, JSON.stringify(perdu.data));
  await query("UPDATE incidents SET opened_at_iso = $2 WHERE id = $1", [perdu.data.incident.id, joursAvant(8)]);
  const litige = await b.post(`/api/colis/${colis2.id}/incidents`, { type: "conteste", note: "Le destinataire conteste le contenu." });
  assert.equal(litige.status, 201, JSON.stringify(litige.data));

  const vue = await p.get("/api/plateforme");
  assert.equal(vue.status, 200, JSON.stringify(vue.data));
  assert.equal(vue.data.admin.id, adminId);
  const fiche = (id) => vue.data.agences.find((agence) => agence.id === id);
  assert.equal(fiche(agenceA.id).periode.compteur, 2);
  assert.equal(fiche(agenceA.id).volumes.envoyesMois, 2);
  assert.equal(fiche(agenceB.id).volumes.recusMois, 2);
  assert.equal(fiche(agenceB.id).periode.compteur, 0, "la destination n'est pas comptée");
  assert.equal(fiche(agenceA.id).incidentsOuverts, 2);
  const enFile = vue.data.fileIncidents.find((incident) => incident.id === perdu.data.incident.id);
  assert.ok(enFile, "incident ouvert depuis 8 jours dans la file plateforme");
  assert.ok(enFile.jours >= 8);
  assert.equal(enFile.parcel.trackingCode, colis1.trackingCode);
  assert.equal(enFile.expediteur.name, "Agence ConsoleA");
  assert.equal(enFile.destination.name, "Agence ConsoleB");
  assert.ok(!vue.data.fileIncidents.some((incident) => incident.id === litige.data.incident.id), "un litige récent n'est pas dans la file > 7 j");
  assert.ok(vue.data.litiges.some((incident) => incident.id === litige.data.incident.id), "les incidents « contesté » forment les litiges");
  assert.ok(vue.data.indicateurs.litigesOuverts >= 1 && vue.data.indicateurs.incidentsFile >= 1);
  assert.ok(vue.data.volumes.parMois.length >= 1 && vue.data.volumes.parStatut.length >= 1);
  const brut = JSON.stringify(vue.data);
  for (const champ of ["\"sender\"", "\"recipient\"", "Ibrahim", "ci12345678", "CI12345678", "0500000340"]) {
    assert.ok(!brut.includes(champ), `la console ne projette pas « ${champ} » (données clients)`);
  }

  // Plan Réseau négocié : quota illimité, abonnement dû puis réglé par la recharge.
  assert.equal((await p.post("/api/plateforme/plan", { agencyId: agenceB.id, plan: "vip" })).status, 400);
  assert.equal((await p.post("/api/plateforme/plan", { agencyId: "inconnue", plan: "pro" })).status, 404);
  const reseau = await p.post("/api/plateforme/plan", { agencyId: agenceB.id, plan: "reseau", quotaMensuel: "", prixMensuelFCFA: 45000 });
  assert.equal(reseau.status, 200, JSON.stringify(reseau.data));
  assert.equal(reseau.data.facturation.plan, "reseau");
  assert.equal(reseau.data.facturation.periode.quotaEffectif, null);
  assert.deepEqual(
    [reseau.data.facturation.periode.abonnement.statut, reseau.data.facturation.periode.abonnement.montantFCFA],
    ["du", 45000]
  );
  assert.match((await b.post("/api/facturation/plan", { plan: "gratuit" })).data.error, /géré par Shopin30/);
  for (const corps of [{ montantFCFA: 0, reference: "MM-1" }, { montantFCFA: 100, reference: "" }, { montantFCFA: 2_000_000, reference: "MM-1" }]) {
    assert.equal((await p.post("/api/plateforme/credit", { agencyId: agenceB.id, ...corps })).status, 400);
  }
  assert.equal((await a.post("/api/plateforme/credit", { agencyId: agenceA.id, montantFCFA: 999999, reference: "MM-HACK" })).status, 401, "une agence ne se crédite jamais elle-même");
  const credit = await p.post("/api/plateforme/credit", { agencyId: agenceB.id, montantFCFA: 50000, reference: "MM-777" });
  assert.equal(credit.status, 201, JSON.stringify(credit.data));
  assert.equal(credit.data.abonnementRegle, true);
  assert.equal(credit.data.soldeFCFA, 5000);
  const etatB = await facturation(b);
  assert.deepEqual(etatB.portefeuille.mouvements.map((m) => [m.type, m.montantFCFA]), [["abonnement", -45000], ["recharge", 50000]]);
  await fixerCompteur(agenceB.id, 10_000);
  assert.equal((await nouveauColis(b, agenceA.id, 42)).status, 201, "Réseau illimité : jamais de refus de quota");

  // Compte désactivé ou déconnecté : console fermée.
  await query("UPDATE plateforme_admins SET active = FALSE WHERE id = $1", [adminId]);
  assert.equal((await p.get("/api/plateforme")).status, 401);
  await query("UPDATE plateforme_admins SET active = TRUE WHERE id = $1", [adminId]);
  assert.equal((await p.get("/api/plateforme")).status, 401, "le cookie a été effacé avec le refus");
  const p2 = client();
  assert.equal((await p2.post("/api/plateforme/connexion", { email, password: "console-secret-123" })).status, 200);
  assert.equal((await p2.post("/api/plateforme/deconnexion", {})).status, 200);
  assert.equal((await p2.get("/api/plateforme")).status, 401);
});

test("facturation en concurrence : compteur et portefeuille restent exacts, jamais de solde négatif", async () => {
  const a = client();
  const b = client();
  const agenceA = await creerAgence(a, "Agence ConcurA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence ConcurB", "Bouaké");
  const { p } = await consolePlateforme();
  await facturation(a);
  await fixerCompteur(agenceA.id, 50);
  await p.post("/api/plateforme/credit", { agencyId: agenceA.id, montantFCFA: 90, reference: "MM-CONC-1" });

  const resultats = await Promise.all([0, 1, 2, 3, 4].map((i) => nouveauColis(a, agenceB.id, 50 + i)));
  const statuts = resultats.map((r) => r.status).sort();
  assert.deepEqual(statuts, [201, 201, 201, 402, 402], "exactement 3 colis hors forfait prépayés (90 FCFA)");
  const etat = await facturation(a);
  assert.equal(etat.portefeuille.soldeFCFA, 0);
  assert.equal(etat.periode.compteur, 53);
  assert.equal(etat.periode.depassements, 3);
  assert.equal(etat.portefeuille.mouvements.filter((m) => m.type === "depassement").length, 3);
  const { rows } = await query("SELECT min(solde_apres_fcfa)::int AS mini FROM portefeuille_mouvements WHERE agency_id = $1", [agenceA.id]);
  assert.ok(rows[0].mini >= 0);
});

/* ------------------- LOT 7 — suivi personnalisé et paiements SasPay ------------------- */

const { logoDemoPng } = await import("../db/logo-demo.js");
const { configurationPaiements, signerWebhook } = await import("../lib/paiements.js");
const http = await import("node:http");

async function colisAvecReste(clientHttp, destinationAgencyId, i = 0) {
  const res = await clientHttp.post("/api/colis", {
    agencyNotRegistered: false,
    values: valeurs({ destinationAgencyId, recipientPhone: `0500000${600 + i}` }),
    payment: { status: "arrivee" }
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.parcel.paidAmountFCFA ?? 0, 0);
  return res.data.parcel;
}

async function encaissementsDuJour(clientHttp) {
  const res = await clientHttp.get("/api/caisse");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.encaissements;
}

test("suivi personnalisé : réglages du gérant, logo vérifié, habillage public sans donnée personnelle", async () => {
  const g = client();
  const b = client();
  const agence = await creerAgence(g, "Agence MarqueA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence MarqueB", "Bouaké");
  const invite = await g.post("/api/agents", { name: "Agent Marque", email: compteUnique("agentmarque"), password: "agent12" });
  const agent = client();
  assert.equal((await agent.post("/api/login", { email: invite.data.agent.email, password: "agent12" })).status, 200);

  const initiale = await g.get("/api/marque");
  assert.equal(initiale.status, 200);
  assert.deepEqual(
    [initiale.data.marque.active, initiale.data.marque.logo, initiale.data.marque.nom, initiale.data.peutModifier],
    [false, false, "Agence MarqueA", true]
  );
  assert.equal((await agent.call("PUT", "/api/marque", { active: true })).status, 403, "gérant uniquement");

  const logo = logoDemoPng().toString("base64");
  for (const [corps, motif] of [
    [{ active: true, couleur: "red;}</style>" }, /#RRGGBB/],
    [{ active: true, logo: { type: "image/svg+xml", donnees: Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64") } }, /PNG, JPEG ou WebP/],
    [{ active: true, logo: { type: "image/png", donnees: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64") } }, /ne correspond pas/],
    [{ active: true, logo: { type: "image/png", donnees: Buffer.concat([logoDemoPng(), Buffer.alloc(310 * 1024)]).toString("base64") } }, /300 Ko/],
    [{ active: true, logo: { type: "image/png", donnees: "<<pas du base64>>" } }, /illisible/]
  ]) {
    const refus = await g.call("PUT", "/api/marque", corps);
    assert.equal(refus.status, 400, JSON.stringify(refus.data));
    assert.match(refus.data.error, motif);
  }

  const parcel = await colisAvecReste(g, agenceB.id, 1);
  const anonyme = client();
  assert.equal((await anonyme.get(`/api/suivi/${parcel.trackingCode}`)).data.tracking.marque, undefined, "désactivée par défaut");
  assert.equal((await anonyme.brut(`/api/suivi/${parcel.trackingCode}/logo`)).status, 404);

  const active = await g.call("PUT", "/api/marque", { active: true, nom: "MarqueA Express", couleur: "#1D3A8A", couleur2: "#f5b301", logo: { type: "image/png", donnees: logo } });
  assert.equal(active.status, 200, JSON.stringify(active.data));
  assert.deepEqual(
    [active.data.marque.active, active.data.marque.nom, active.data.marque.couleur, active.data.marque.logo],
    [true, "MarqueA Express", "#1d3a8a", true]
  );

  const suivi = (await anonyme.get(`/api/suivi/${parcel.trackingCode}`)).data.tracking;
  assert.deepEqual(
    { ...suivi.marque, version: "" },
    { nom: "MarqueA Express", couleur: "#1d3a8a", couleur2: "#f5b301", couleurTexte: "#ffffff", logo: true, version: "" }
  );
  aucuneDonneePersonnelle(suivi, "suivi personnalisé");
  assert.ok(!JSON.stringify(suivi).includes(agence.email) && !JSON.stringify(suivi).includes("marques/"), "ni e-mail ni clé de stockage");
  const image = await anonyme.brut(`/api/suivi/${parcel.trackingCode}/logo`);
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "image/png");
  assert.ok(image.buffer.equals(logoDemoPng()), "le logo servi est celui téléversé");
  assert.equal((await anonyme.brut(`/api/suivi/${parcel.trackingCode}?action=logo`)).status, 200, "forme repliée Vercel");
  assert.equal((await g.brut("/api/marque?logo=1")).status, 200, "aperçu du logo pour l'agence");

  // Les colis d'une agence non personnalisée gardent l'apparence par défaut.
  const colisB = await colisAvecReste(b, agence.id, 2);
  assert.equal((await anonyme.get(`/api/suivi/${colisB.trackingCode}`)).data.tracking.marque, undefined);

  // Logo retiré, puis personnalisation désactivée.
  const sansLogo = await g.call("PUT", "/api/marque", { active: true, nom: "MarqueA Express", logo: null });
  assert.equal(sansLogo.data.marque.logo, false);
  assert.equal((await anonyme.brut(`/api/suivi/${parcel.trackingCode}/logo`)).status, 404);
  await g.call("PUT", "/api/marque", { active: false });
  assert.equal((await anonyme.get(`/api/suivi/${parcel.trackingCode}`)).data.tracking.marque, undefined);
});

test("LOT 8 : le paiement en ligne d'un colis est refusé (403) — l'agence encaisse au guichet, la caisse ne change pas", async () => {
  const a = client();
  const b = client();
  await creerAgence(a, "Agence PaieA", "Abidjan");
  const agenceB = await creerAgence(b, "Agence PaieB", "Bouaké");
  const parcel = await colisAvecReste(a, agenceB.id, 3);

  const config = await b.get("/api/paiements");
  assert.deepEqual([config.data.configuration.mode, config.data.configuration.actif], ["simulation", true]);

  for (const clientHttp of [a, b]) {
    const refus = await clientHttp.post("/api/paiements", { objet: "colis", parcelId: parcel.id });
    assert.equal(refus.status, 403, JSON.stringify(refus.data));
    assert.match(refus.data.error, /guichet/);
    assert.match(refus.data.error, /abonnement et les recharges/);
  }
  assert.equal((await b.post("/api/paiements", { objet: "colis" })).status, 403, "même sans colis indiqué : règle métier avant validation");
  const { rows: aucun } = await query("SELECT count(*)::int AS n FROM paiements_en_ligne WHERE parcel_id = $1", [parcel.id]);
  assert.equal(aucun[0].n, 0, "aucune session créée");
  assert.deepEqual(await encaissementsDuJour(b), []);

  // L'encaissement au guichet (LOT 2) ne change pas.
  const guichet = await b.post(`/api/colis/${parcel.id}/encaisser`, { amountFCFA: 3500, mode: "mobile_money" });
  assert.equal(guichet.status, 201, JSON.stringify(guichet.data));
  const caisse = await encaissementsDuJour(b);
  assert.equal(caisse.length, 1);
  assert.deepEqual([caisse[0].amountFCFA, caisse[0].mode], [3500, "mobile_money"]);
  assert.deepEqual([guichet.data.parcel.paymentStatus, guichet.data.parcel.paidAmountFCFA], ["regle", 3500]);

  // Lignes historiques LOT 7 (objet « colis ») : lisibles, et un paiement déjà
  // confirmé reste appliqué une seule fois (le webhook ne plante pas dessus).
  const parcel2 = await colisAvecReste(a, agenceB.id, 4);
  const idHisto = "histo-colis-1";
  await query(
    `INSERT INTO paiements_en_ligne (id, agency_id, objet, parcel_id, montant_fcfa, libelle, mode, session_id, checkout_url, retour_chemin,
       statut, simulation_statut, acteur_id, acteur_nom, created_at_iso)
     VALUES ($1, $2, 'colis', $3, 3500, 'Reste à payer — historique', 'simulation', $4, '/paiement-simulation.html?id=histo', '/colis.html?id=x',
       'en_attente', 'PAID', $2, 'Historique', $5)`,
    [idHisto, agenceB.id, parcel2.id, `sim_${idHisto}`, new Date().toISOString()]
  );
  const historique = await b.get(`/api/paiements?parcelId=${parcel2.id}`);
  assert.equal(historique.status, 200);
  assert.deepEqual(historique.data.paiements.map((p) => [p.objet, p.statut]), [["colis", "en_attente"]]);
  for (let i = 0; i < 2; i += 1) {
    const verif = await b.post("/api/paiements/verifier", { id: idHisto });
    assert.equal(verif.status, 200, JSON.stringify(verif.data));
    assert.equal(verif.data.paiement.statut, "paye");
  }
  const caisse2 = await encaissementsDuJour(b);
  assert.equal(caisse2.length, 2, "ligne historique appliquée une seule fois");
  assert.equal(caisse2.find((e) => e.label?.startsWith("Paiement SasPay"))?.amountFCFA, 3500);
  assert.equal((await fetch(`${BASE}/api/paiements`, { method: "DELETE" })).status, 404);
});

test("paiement en ligne (simulation) : abonnement dû et recharge du portefeuille, réservés au gérant", async () => {
  const g = client();
  await creerAgence(g, "Agence PaieAbo", "Abidjan");
  const invite = await g.post("/api/agents", { name: "Agent Abo", email: compteUnique("agentabo"), password: "agent12" });
  const agent = client();
  await agent.post("/api/login", { email: invite.data.agent.email, password: "agent12" });
  assert.equal((await g.post("/api/facturation/plan", { plan: "pro" })).data.facturation.periode.abonnement.statut, "du");

  assert.equal((await agent.post("/api/paiements", { objet: "abonnement" })).status, 403);
  assert.equal((await agent.post("/api/paiements", { objet: "recharge", montantFCFA: 1000 })).status, 403);
  const abonnement = await g.post("/api/paiements", { objet: "abonnement" });
  assert.equal(abonnement.status, 201, JSON.stringify(abonnement.data));
  assert.equal(abonnement.data.paiement.montantFCFA, 10000);
  assert.match(abonnement.data.paiement.libelle, /^Abonnement Pro — /);
  assert.equal(abonnement.data.paiement.retour, `/abonnement.html?paiement=${abonnement.data.paiement.id}`);
  assert.equal((await g.post("/api/paiements/simulation", { id: abonnement.data.paiement.id, resultat: "succes" })).data.paiement.statut, "paye");

  const etat = await facturation(g);
  assert.equal(etat.periode.abonnement.statut, "paye", "abonnement réglé dès la confirmation");
  assert.equal(etat.portefeuille.soldeFCFA, 0);
  const [debit, credit] = etat.portefeuille.mouvements;
  assert.deepEqual([debit.type, debit.montantFCFA], ["abonnement", -10000]);
  assert.deepEqual([credit.type, credit.montantFCFA, credit.acteurNom], ["recharge", 10000, "SasPay"]);
  assert.match(credit.libelle, /^Paiement SasPay — Abonnement Pro — .* \(simulation\)$/);
  assert.equal((await g.post("/api/paiements", { objet: "abonnement" })).status, 400, "plus rien à régler");

  assert.equal((await g.post("/api/paiements", { objet: "recharge", montantFCFA: 50 })).status, 400);
  const recharge = await g.post("/api/paiements", { objet: "recharge", montantFCFA: 2500 });
  await g.post("/api/paiements/simulation", { id: recharge.data.paiement.id, resultat: "succes" });
  assert.equal((await facturation(g)).portefeuille.soldeFCFA, 2500);
});

/** Faux SasPay : POST /checkout-sessions/, GET …/status/, GET /payments/…/verify/ (contrats de la doc). */
function fauxSaspay() {
  const etat = { requetes: [], sessions: new Map(), transactions: new Map(), erreurCreation: null, n: 0 };
  const serveur = http.createServer(async (req, res) => {
    let corps = "";
    for await (const morceau of req) corps += morceau;
    etat.requetes.push({ methode: req.method, chemin: req.url, autorisation: req.headers.authorization, corps: corps ? JSON.parse(corps) : null });
    const repondre = (code, donnees) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(donnees));
    };
    if (req.method === "POST" && req.url === "/api/v1/checkout-sessions/") {
      if (etat.erreurCreation) return repondre(etat.erreurCreation, { success: false, error: { message: "Clé invalide.", code: "invalid_key" }, code: etat.erreurCreation });
      etat.n += 1;
      const id = `sess-${etat.n}`;
      etat.sessions.set(id, { id, slug: `slug-${etat.n}`, status: "PENDING", transaction_id: null, transaction_status: null, transaction_reference: null });
      return repondre(201, { success: true, data: { id, checkout_url: `https://pay.saspay.me/checkout/test-${etat.n}`, status: "PENDING", transaction: null }, code: 201 });
    }
    let m = req.url.match(/^\/api\/v1\/checkout-sessions\/([^/]+)\/status\/$/);
    if (req.method === "GET" && m) {
      const session = etat.sessions.get(decodeURIComponent(m[1]));
      return session ? repondre(200, session) : repondre(404, { message: "Introuvable.", code: "not_found" });
    }
    m = req.url.match(/^\/api\/v1\/payments\/([^/]+)\/verify\/$/);
    if (req.method === "GET" && m) {
      const transaction = etat.transactions.get(decodeURIComponent(m[1]));
      return transaction ? repondre(200, { success: true, data: transaction, code: 200 }) : repondre(404, { message: "Transaction introuvable.", code: "not_found" });
    }
    return repondre(404, { message: "Route inconnue." });
  });
  return new Promise((resolve) => {
    serveur.listen(0, "127.0.0.1", () => resolve({ etat, serveur, url: `http://127.0.0.1:${serveur.address().port}/api/v1` }));
  });
}

async function envoyerWebhook(corps, { secret = "whsec_test_colis", horodatage = Math.floor(Date.now() / 1000), signature, chemin = "/api/paiements/webhook" } = {}) {
  const brut = JSON.stringify(corps);
  const res = await fetch(`${BASE}${chemin}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature ?? signerWebhook({ corpsBrut: brut, horodatage: String(horodatage), secret }),
      "X-Webhook-Timestamp": String(horodatage),
      "X-Webhook-Event": corps.event
    },
    body: brut
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test("SasPay en mode TEST : session hébergée sans donnée client, mode de frais transmis, webhook HMAC vérifié, application après vérification serveur", async () => {
  const faux = await fauxSaspay();
  const variables = {
    SASPAY_SECRET_KEY: "sk_test_colisexpress_cle",
    SASPAY_API_URL: faux.url,
    SASPAY_WEBHOOK_SECRET: "whsec_test_colis",
    SASPAY_MODE_FRAIS: "DEDUCTED",
    APP_URL: "https://colisexpress.example"
  };
  Object.assign(process.env, variables);
  try {
    const a = client();
    const agenceA = await creerAgence(a, "Agence SasA", "Abidjan");
    const configuration = (await a.get("/api/paiements")).data.configuration;
    assert.deepEqual([configuration.mode, configuration.actif], ["test", true]);
    assert.ok(!JSON.stringify(configuration).includes("sk_test_colisexpress_cle"), "la clé n'est jamais renvoyée");

    assert.equal((await a.post("/api/paiements", { objet: "colis", parcelId: "x" })).status, 403, "jamais de colis, même en mode TEST");
    const cree = await a.post("/api/paiements", { objet: "recharge", montantFCFA: 3500 });
    assert.equal(cree.status, 201, JSON.stringify(cree.data));
    const paiement = cree.data.paiement;
    assert.equal(paiement.mode, "test");
    assert.equal(paiement.checkoutUrl, "https://pay.saspay.me/checkout/test-1");
    const creation = faux.etat.requetes.find((r) => r.methode === "POST");
    assert.equal(creation.chemin, "/api/v1/checkout-sessions/");
    assert.equal(creation.autorisation, "Bearer sk_test_colisexpress_cle");
    assert.deepEqual(
      [creation.corps.amount, creation.corps.currency, creation.corps.country, creation.corps.customer_name, creation.corps.customer_email, creation.corps.fee_charge_mode],
      ["3500.00", "XOF", "CI", "Agence SasA", agenceA.email, "DEDUCTED"],
      "le « client » de la session est l'agence ; SASPAY_MODE_FRAIS → fee_charge_mode"
    );
    assert.deepEqual(creation.corps.metadata, { paiement_id: paiement.id, objet: "recharge" });
    assert.equal(creation.corps.return_url, `https://colisexpress.example/abonnement.html?paiement=${paiement.id}`);
    aucuneDonneePersonnelle(creation.corps, "session SasPay");

    assert.equal((await a.post("/api/paiements/simulation", { id: paiement.id, resultat: "succes" })).status, 409, "aucune simulation avec une clé configurée");
    assert.equal((await a.post("/api/paiements/verifier", { id: paiement.id })).data.paiement.statut, "en_attente");

    // Sécurité du webhook : secret absent, signature fausse, horodatage périmé.
    const evenement = { event: "transaction.success", data: { id: "txn-1", status: "SUCCESS", amount: "3500.00", currency: "XOF", msisdn: "2250700000099" } };
    delete process.env.SASPAY_WEBHOOK_SECRET;
    assert.equal((await envoyerWebhook(evenement)).status, 503);
    process.env.SASPAY_WEBHOOK_SECRET = variables.SASPAY_WEBHOOK_SECRET;
    assert.equal((await envoyerWebhook(evenement, { signature: "0".repeat(64) })).status, 403);
    assert.equal((await envoyerWebhook(evenement, { secret: "autre-secret" })).status, 403);
    assert.equal((await envoyerWebhook(evenement, { horodatage: Math.floor(Date.now() / 1000) - 600 })).status, 403, "rejeu refusé (> 300 s)");

    // Webhook valide mais session encore en attente chez SasPay : rien n'est appliqué.
    assert.equal((await envoyerWebhook(evenement)).status, 200);
    assert.equal((await a.get(`/api/paiements?id=${paiement.id}`)).data.paiement.statut, "en_attente", "le contenu du webhook ne suffit jamais");
    // Session payée mais montant vérifié différent : rien n'est appliqué.
    faux.etat.sessions.set("sess-1", { id: "sess-1", status: "PAID", transaction_id: "txn-1", transaction_status: "SUCCESS", transaction_reference: "ref-1" });
    faux.etat.transactions.set("txn-1", { id: "txn-1", status: "SUCCESS", requested_amount: "100.00", debited_amount: "100.00", net_amount: "98.50", fee_charge_mode: "DEDUCTED", currency: "XOF", reference: "TXN-TEST-1" });
    assert.equal((await envoyerWebhook(evenement)).status, 200);
    assert.equal((await a.get(`/api/paiements?id=${paiement.id}`)).data.paiement.statut, "en_attente");
    assert.equal((await facturation(a)).portefeuille.soldeFCFA, 0);
    // Vérification conforme en DEDUCTED (net reversé 3447.50 < 3500) : appliqué
    // au montant demandé, une seule fois même si le webhook est rejoué.
    faux.etat.transactions.set("txn-1", { id: "txn-1", status: "SUCCESS", requested_amount: "3500.00", debited_amount: "3500.00", net_amount: "3447.50", fee_charge_mode: "DEDUCTED", currency: "XOF", reference: "TXN-TEST-1" });
    const recu = await envoyerWebhook(evenement, { chemin: "/api/paiements?action=webhook" });
    assert.equal(recu.status, 200, "forme repliée Vercel, corps brut conservé");
    assert.equal(recu.data.verifies, 1);
    assert.equal((await envoyerWebhook(evenement)).status, 200);
    const final = (await a.get(`/api/paiements?id=${paiement.id}`)).data.paiement;
    assert.deepEqual([final.statut, final.transactionReference], ["paye", "TXN-TEST-1"]);
    const etat = await facturation(a);
    assert.equal(etat.portefeuille.soldeFCFA, 3500, "crédité du montant demandé, pas du net après frais");
    assert.equal(etat.portefeuille.mouvements.filter((m) => m.acteurNom === "SasPay").length, 1, "appliqué une seule fois");
    const { rows: journalWebhooks } = await query("SELECT * FROM paiements_webhooks");
    assert.ok(journalWebhooks.length >= 4);
    assert.ok(!JSON.stringify(journalWebhooks).includes("2250700000099"), "le numéro débité n'est jamais conservé");

    // Mode ADD_ON : le client paie 3500 + frais, le marchand reçoit 3500 — conforme aussi.
    process.env.SASPAY_MODE_FRAIS = "ADD_ON";
    const cree2 = await a.post("/api/paiements", { objet: "recharge", montantFCFA: 2000 });
    assert.equal(cree2.status, 201, JSON.stringify(cree2.data));
    assert.equal(faux.etat.requetes.filter((r) => r.methode === "POST").at(-1).corps.fee_charge_mode, "ADD_ON");
    faux.etat.sessions.set("sess-2", { id: "sess-2", status: "PAID", transaction_id: "txn-2", transaction_status: "SUCCESS", transaction_reference: "ref-2" });
    faux.etat.transactions.set("txn-2", { id: "txn-2", status: "SUCCESS", requested_amount: "2000.00", debited_amount: "2030.00", net_amount: "2000.00", fee_charge_mode: "ADD_ON", currency: "XOF", reference: "TXN-TEST-2" });
    assert.equal((await a.post("/api/paiements/verifier", { id: cree2.data.paiement.id })).data.paiement.statut, "paye");
    assert.equal((await facturation(a)).portefeuille.soldeFCFA, 5500);

    // Sans SASPAY_MODE_FRAIS : fee_charge_mode absent (réglage du compte).
    delete process.env.SASPAY_MODE_FRAIS;
    const cree3 = await a.post("/api/paiements", { objet: "recharge", montantFCFA: 1500 });
    assert.equal(cree3.status, 201);
    assert.equal("fee_charge_mode" in faux.etat.requetes.filter((r) => r.methode === "POST").at(-1).corps, false);

    // Prestataire en erreur : message clair, aucune session orpheline en attente.
    faux.etat.erreurCreation = 401;
    const refus = await a.post("/api/paiements", { objet: "recharge", montantFCFA: 7777 });
    assert.equal(refus.status, 502);
    assert.match(refus.data.error, /refusé la configuration/);
    const { rows: annules } = await query("SELECT statut FROM paiements_en_ligne WHERE montant_fcfa = 7777");
    assert.deepEqual(annules.map((r) => r.statut), ["annule"]);
  } finally {
    for (const nom of Object.keys(variables)) delete process.env[nom];
    faux.serveur.close();
  }
});

test("garde-fous de paiement (LOT 8) : matrice VERCEL_ENV × clé × simulation, sans jamais révéler la clé", async () => {
  const cas = [
    // [env, mode attendu, commentaire]
    [{}, "simulation", "local sans base : simulation par défaut"],
    [{ DATABASE_URL: "postgres://x" }, "desactive", "vraie base hors Vercel sans clé"],
    [{ DATABASE_URL: "postgres://x", PAIEMENTS_SIMULATION: "1" }, "simulation", "simulation explicite hors production"],
    [{ SASPAY_SECRET_KEY: "sk_test_abc" }, "test", "clé de test en local"],
    [{ SASPAY_SECRET_KEY: "sk_live_abc", DATABASE_URL: "postgres://x" }, "live", "clé réelle sur une vraie base hors Vercel"],
    [{ SASPAY_SECRET_KEY: "sk_live_abc" }, "desactive", "clé réelle sans base réelle : jamais d'argent réel sur une base de test"],
    [{ VERCEL_ENV: "production", DATABASE_URL: "postgres://x", SASPAY_SECRET_KEY: "sk_live_abc" }, "live", "production + clé réelle"],
    [{ VERCEL_ENV: "production", DATABASE_URL: "postgres://x", SASPAY_SECRET_KEY: "sk_test_abc" }, "desactive", "clé de test en production"],
    [{ VERCEL_ENV: "production", DATABASE_URL: "postgres://x", PAIEMENTS_SIMULATION: "1" }, "desactive", "simulation en production"],
    [{ VERCEL_ENV: "production", DATABASE_URL: "postgres://x" }, "desactive", "production sans clé"],
    [{ VERCEL_ENV: "preview", DATABASE_URL: "postgres://preview", SASPAY_SECRET_KEY: "sk_test_abc" }, "test", "préversion + clé de test"],
    [{ VERCEL_ENV: "preview", DATABASE_URL: "postgres://preview", SASPAY_SECRET_KEY: "sk_live_abc" }, "desactive", "clé réelle en préversion"],
    [{ VERCEL_ENV: "preview", DATABASE_URL: "postgres://preview", PAIEMENTS_SIMULATION: "1" }, "simulation", "simulation en préversion"],
    [{ VERCEL_ENV: "development", SASPAY_SECRET_KEY: "sk_live_abc" }, "desactive", "clé réelle en développement"],
    [{ SASPAY_SECRET_KEY: "pk_abc_secret" }, "desactive", "clé mal formée"]
  ];
  for (const [env, attendu, commentaire] of cas) {
    const config = configurationPaiements(env);
    assert.equal(config.mode, attendu, commentaire);
    assert.equal(config.actif, attendu !== "desactive", commentaire);
    assert.ok(config.raison.length > 10, `raison explicite : ${commentaire}`);
    assert.ok(!/sk_(test|live)_abc|pk_abc_secret/.test(config.raison), "la valeur de la clé n'apparaît jamais");
  }
  assert.match(configurationPaiements({ VERCEL_ENV: "production", DATABASE_URL: "postgres://x", SASPAY_SECRET_KEY: "sk_test_abc" }).raison, /sk_live_/);
  assert.match(configurationPaiements({ VERCEL_ENV: "preview", SASPAY_SECRET_KEY: "sk_live_abc" }).raison, /préversion/);
  assert.equal(configurationPaiements({ SASPAY_SECRET_KEY: "sk_test_abc", SASPAY_MODE_FRAIS: "deducted" }).modeFrais, "DEDUCTED");
  assert.equal(configurationPaiements({ SASPAY_SECRET_KEY: "sk_test_abc", SASPAY_MODE_FRAIS: "n'importe" }).modeFrais, null);

  process.env.SASPAY_SECRET_KEY = "cle-mal-formee";
  try {
    const g = client();
    await creerAgence(g, "Agence PaieOff", "Abidjan");
    const config = await g.get("/api/paiements");
    assert.equal(config.data.configuration.actif, false);
    assert.ok(!JSON.stringify(config.data).includes("cle-mal-formee"));
    const refus = await g.post("/api/paiements", { objet: "recharge", montantFCFA: 1000 });
    assert.equal(refus.status, 503);
    assert.match(refus.data.error, /invalide/);
  } finally {
    delete process.env.SASPAY_SECRET_KEY;
  }
});

/* ------------------------------ LOT 8 — sessions ------------------------------ */

const { etatSecretSession, LONGUEUR_MIN_SECRET_SESSION } = await import("../lib/auth.js");

test("SESSION_SECRET (LOT 8) : exigée (32 caractères) dès qu'une vraie base ou la production est en jeu, jamais de secret de secours", async () => {
  assert.equal(LONGUEUR_MIN_SECRET_SESSION, 32);
  assert.deepEqual([etatSecretSession({}).ok, etatSecretSession({}).exige], [true, false], "démo locale : rien d'exigé");
  assert.equal(etatSecretSession({ DATABASE_URL: "postgres://x" }).ok, false, "vraie base sans secret");
  assert.equal(etatSecretSession({ DATABASE_URL: "postgres://x", SESSION_SECRET: "court" }).ok, false, "vraie base, secret trop court");
  assert.equal(etatSecretSession({ VERCEL_ENV: "production", SESSION_SECRET: "x".repeat(31) }).ok, false, "production, 31 caractères");
  assert.equal(etatSecretSession({ VERCEL_ENV: "production", SESSION_SECRET: "x".repeat(32) }).ok, true);
  assert.equal(etatSecretSession({ DATABASE_URL: "postgres://x", SESSION_SECRET: "x".repeat(40) }).ok, true);
  assert.ok(!etatSecretSession({ DATABASE_URL: "postgres://x", SESSION_SECRET: "ma-valeur-trop-courte" }).raison.includes("ma-valeur"), "la valeur n'apparaît jamais");

  const g = client();
  const agence = await creerAgence(g, "Agence Secret", "Abidjan");
  const { p, email } = await consolePlateforme();

  // Simule la production (VERCEL_ENV) sans SESSION_SECRET, puis avec une trop courte.
  const avant = process.env.SESSION_SECRET;
  for (const secret of [undefined, "trop-court"]) {
    process.env.VERCEL_ENV = "production";
    if (secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secret;
    try {
      const connexion = await client().post("/api/login", { email: agence.email, password: "secret12" });
      assert.equal(connexion.status, 503, JSON.stringify(connexion.data));
      assert.match(connexion.data.error, /SESSION_SECRET/);
      assert.match(connexion.data.error, secret === undefined ? /absente/ : /trop courte/);
      assert.equal((await g.get("/api/me")).status, 503, "route agence authentifiée refusée (cookie signé par le secret démo jamais accepté)");
      assert.equal((await g.get("/api/colis")).status, 503);
      assert.equal((await p.get("/api/plateforme")).status, 503, "console refusée aussi");
      assert.equal((await client().post("/api/plateforme/connexion", { email, password: "console-secret-123" })).status, 503);
      assert.equal((await client().post("/api/register", { name: "Agence X", city: "Abidjan", phone: "0700000001", email: compteUnique("sec"), password: "secret12" })).status, 503);
      assert.equal((await fetch(`${BASE}/api/suivi/CLI-ABSENT`)).status, 404, "le suivi public, sans session, fonctionne toujours");
      assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
    } finally {
      delete process.env.VERCEL_ENV;
      if (avant === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = avant;
    }
  }
  // Retour au mode démo : tout refonctionne.
  assert.equal((await g.get("/api/me")).status, 200);
  assert.equal((await p.get("/api/plateforme")).status, 200);
});

/* ------------------ LOT 8 — amorçage du premier administrateur ------------------ */

test("amorçage console (LOT 8) : fermé si un administrateur existe, jeton exigé et comparé, mot de passe ≥ 12, création atomique puis fermeture définitive", async () => {
  const JETON = "jeton-amorcage-de-test-0123456789abcdef";
  // Des administrateurs ont été créés par les tests précédents : amorçage fermé.
  process.env.PLATEFORME_PREMIER_ADMIN_JETON = JETON;
  try {
    assert.deepEqual((await client().get("/api/plateforme/amorcage")).data, { disponible: false, motif: "ferme" });
    const refuseFerme = await client().post("/api/plateforme/amorcage", { jeton: JETON, email: "a@shopin30.ci", nom: "Admin", password: "motdepasse-long-12" });
    assert.equal(refuseFerme.status, 409);

    // Plus aucun administrateur actif (désactivation, jamais de suppression).
    await query("UPDATE plateforme_admins SET active = FALSE");
    assert.deepEqual((await client().get("/api/plateforme/amorcage")).data, { disponible: true, motif: "ouvert" });
    assert.deepEqual((await client().get("/api/plateforme?action=amorcage")).data, { disponible: true, motif: "ouvert" }, "forme repliée Vercel");

    // Jeton absent ou trop court dans l'environnement : indisponible.
    process.env.PLATEFORME_PREMIER_ADMIN_JETON = "court";
    assert.deepEqual((await client().get("/api/plateforme/amorcage")).data, { disponible: false, motif: "jeton_absent" });
    assert.equal((await client().post("/api/plateforme/amorcage", { jeton: "court", email: "a@shopin30.ci", nom: "Admin", password: "motdepasse-long-12" })).status, 409);
    process.env.PLATEFORME_PREMIER_ADMIN_JETON = JETON;

    const base = { email: "premier@shopin30.ci", nom: "Première admin", password: "motdepasse-long-12" };
    const faux = await client().post("/api/plateforme/amorcage", { ...base, jeton: `${JETON}x` });
    assert.equal(faux.status, 403);
    assert.ok(!JSON.stringify(faux.data).includes(JETON), "le jeton n'est jamais renvoyé");
    assert.equal((await client().post("/api/plateforme/amorcage", { ...base, jeton: JETON, password: "court-11car" })).status, 400);
    assert.equal((await client().post("/api/plateforme/amorcage", { ...base, jeton: JETON, email: "pas-un-mail" })).status, 400);
    assert.equal((await client().post("/api/plateforme/amorcage", { ...base, jeton: JETON, nom: "A" })).status, 400);
    const { rows: aucun } = await query("SELECT count(*)::int AS n FROM plateforme_admins WHERE active = TRUE");
    assert.equal(aucun[0].n, 0, "aucune création sur un refus");

    // Double création concurrente : une seule réussit.
    const concurrents = await Promise.all(
      [1, 2, 3].map((i) => client().post("/api/plateforme/amorcage", { ...base, email: `premier${i}@shopin30.ci`, jeton: JETON }))
    );
    const codes = concurrents.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409, 409], JSON.stringify(concurrents.map((r) => r.data)));
    const gagnant = concurrents.find((r) => r.status === 201);
    assert.match(gagnant.data.aFaire, /PLATEFORME_PREMIER_ADMIN_JETON/);
    const { rows: actifs } = await query("SELECT email FROM plateforme_admins WHERE active = TRUE");
    assert.equal(actifs.length, 1);
    assert.equal(actifs[0].email, gagnant.data.admin.email);
    const { rows: verrou } = await query("SELECT admin_id FROM plateforme_amorcage");
    assert.deepEqual(verrou.map((v) => v.admin_id), [gagnant.data.admin.id]);

    // Le compte créé ouvre la console ; l'amorçage est fermé pour toujours.
    const p = client();
    assert.equal((await p.post("/api/plateforme/connexion", { email: gagnant.data.admin.email, password: base.password })).status, 200);
    assert.equal((await p.get("/api/plateforme")).status, 200);
    assert.deepEqual((await client().get("/api/plateforme/amorcage")).data, { disponible: false, motif: "ferme" });
    await query("UPDATE plateforme_admins SET active = FALSE");
    assert.deepEqual((await client().get("/api/plateforme/amorcage")).data, { disponible: false, motif: "ferme" }, "même sans administrateur actif, l'amorçage ayant servi reste fermé");
    assert.equal((await client().post("/api/plateforme/amorcage", { ...base, email: "encore@shopin30.ci", jeton: JETON })).status, 409);
  } finally {
    delete process.env.PLATEFORME_PREMIER_ADMIN_JETON;
    await query("UPDATE plateforme_admins SET active = TRUE");
  }
});

test.after(() => {
  server.close();
});

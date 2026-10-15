/*
 * Tests d'intégration de l'API COLIS EXPRESS (lib/app.js) sur Postgres :
 * PGlite (Postgres WASM) en base de test — mêmes requêtes SQL qu'en production.
 *
 * Couverture : session, inscription, création de colis (inscrit / non inscrite /
 * invalide), visibilité entre agences, suivi public sans données personnelles,
 * rattachement unique, progression des statuts, et refus d'accès.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.SEED_DEMO = "0";
delete process.env.DATABASE_URL;

const { buildApp } = await import("../lib/app.js");

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

test.after(() => {
  server.close();
});

-- Schéma COLIS EXPRESS — Postgres (Neon ou tout autre Postgres 14+).
-- Idempotent : chaque instruction peut être rejouée sans risque.

CREATE TABLE IF NOT EXISTS agencies (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  city          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parcels (
  id                              TEXT PRIMARY KEY,
  tracking_code                   TEXT NOT NULL UNIQUE,
  owner_id                        TEXT NOT NULL REFERENCES agencies(id),
  owner_agency_name               TEXT NOT NULL DEFAULT '',
  owner_agency_city               TEXT NOT NULL DEFAULT '',
  destination_agency_id           TEXT REFERENCES agencies(id),
  destination_agency_name         TEXT NOT NULL DEFAULT '',
  destination_agency_city         TEXT NOT NULL DEFAULT '',
  unregistered_destination_agency JSONB,
  sender                          JSONB NOT NULL,
  recipient                       JSONB NOT NULL,
  package_nature                  TEXT NOT NULL,
  weight_kg                       DOUBLE PRECISION NOT NULL,
  price_fcfa                      INTEGER NOT NULL,
  origin_city                     TEXT NOT NULL,
  destination_city                TEXT NOT NULL,
  status                          TEXT NOT NULL,
  history                         JSONB NOT NULL DEFAULT '[]',
  collected_by                    JSONB,
  destination_agency_attached_at  TEXT,
  destination_agency_attached_by  TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso                  TEXT NOT NULL,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parcels_owner       ON parcels (owner_id);
CREATE INDEX IF NOT EXISTS idx_parcels_destination ON parcels (destination_agency_id);

-- LOT 1 — comptes agents nommés : 1 compte (agences) = 1 agence, plusieurs
-- agents. Le gérant EST le compte agence (agencies.email/password inchangés) ;
-- cette table stocke les agents invités par le gérant. Idempotent et additive.
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  agency_id      TEXT NOT NULL REFERENCES agencies(id),
  name           TEXT NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('gerant', 'agent')),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_agency ON agents (agency_id);

-- LOT 2 — grille tarifaire : axe (ville départ → ville arrivée ou toutes
-- destinations) × tranche de poids → prix FCFA, par agence. Pas de
-- suppression : la mise hors grille se fait par active = FALSE.
CREATE TABLE IF NOT EXISTS tarifs (
  id               TEXT PRIMARY KEY,
  agency_id        TEXT NOT NULL REFERENCES agencies(id),
  origin_city      TEXT NOT NULL,
  destination_city TEXT NOT NULL DEFAULT '',  -- '' = toutes destinations
  weight_min_kg    DOUBLE PRECISION NOT NULL,
  weight_max_kg    DOUBLE PRECISION,          -- NULL = sans limite (« +10 kg »)
  price_fcfa       INTEGER NOT NULL CHECK (price_fcfa >= 0),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tarifs_agency ON tarifs (agency_id);

-- LOT 2 — état de paiement du colis (colonnes additives, NULL = colis
-- antérieur au LOT 2, « non renseigné » côté interface).
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS payment_status   TEXT;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS paid_amount_fcfa INTEGER;

-- LOT 2 — journal des encaissements (caisse du jour par agence).
CREATE TABLE IF NOT EXISTS encaissements (
  id              TEXT PRIMARY KEY,
  parcel_id       TEXT NOT NULL REFERENCES parcels(id),
  agency_id       TEXT NOT NULL REFERENCES agencies(id),
  agent_id        TEXT,
  agent_name      TEXT NOT NULL DEFAULT '',
  amount_fcfa     INTEGER NOT NULL CHECK (amount_fcfa > 0),
  mode            TEXT NOT NULL CHECK (mode IN ('especes', 'mobile_money')),
  date_key        TEXT NOT NULL,              -- AAAA-MM-JJ (Afrique/Abidjan)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_encaissements_agency_date ON encaissements (agency_id, date_key);

-- LOT 3 — carnet de clients : expéditeurs et destinataires mémorisés par
-- agence (nom, téléphone, CNI expéditeur, ville). Données privées : visibles
-- uniquement par l'agence propriétaire. Unicité (agence, rôle, téléphone) :
-- la mémorisation automatique à l'enregistrement d'un colis est un upsert.
-- Pas de suppression : le carnet est la mémoire de l'agence.
CREATE TABLE IF NOT EXISTS clients (
  id             TEXT PRIMARY KEY,
  agency_id      TEXT NOT NULL REFERENCES agencies(id),
  kind           TEXT NOT NULL CHECK (kind IN ('expediteur', 'destinataire')),
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  cni            TEXT,                        -- CNI expéditeur (jamais destinataire)
  city           TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  UNIQUE (agency_id, kind, phone)
);

CREATE INDEX IF NOT EXISTS idx_clients_agency ON clients (agency_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone  ON clients (phone);

-- LOT 2 — clôtures de caisse : une par agence et par jour, total compté
-- validé par l'agent face au total calculé par le serveur.
CREATE TABLE IF NOT EXISTS caisse_closures (
  id                   TEXT PRIMARY KEY,
  agency_id            TEXT NOT NULL REFERENCES agencies(id),
  date_key             TEXT NOT NULL,
  counted_total_fcfa   INTEGER NOT NULL CHECK (counted_total_fcfa >= 0),
  computed_total_fcfa  INTEGER NOT NULL,
  ecart_fcfa           INTEGER NOT NULL,
  agent_id             TEXT,
  agent_name           TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso       TEXT NOT NULL,
  UNIQUE (agency_id, date_key)
);

-- LOT 4 — bordereaux d'acheminement : regrouper 1 à 200 colis expédiés
-- ensemble (transporteur, véhicule/ligne), avec émargement à chaque bout.
-- Statuts : Préparé → Remis → En route → Arrivé → Contrôlé (ou Écart si des
-- colis manquent au contrôle — chaque absent ouvre un incident automatique).
-- Pas de suppression : le bordereau est une pièce de la chaîne de preuve.
CREATE TABLE IF NOT EXISTS bordereaux (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,      -- BDR-XXXXXX
  from_agency_id     TEXT NOT NULL REFERENCES agencies(id),
  from_agency_name   TEXT NOT NULL DEFAULT '',
  from_city          TEXT NOT NULL DEFAULT '',
  to_agency_id       TEXT REFERENCES agencies(id),  -- NULL = destination non rattachée
  to_agency_name     TEXT NOT NULL DEFAULT '',
  to_city            TEXT NOT NULL DEFAULT '',
  carrier_name       TEXT NOT NULL,
  carrier_phone      TEXT NOT NULL DEFAULT '',
  vehicle_ref        TEXT NOT NULL DEFAULT '',
  parcel_count       INTEGER NOT NULL CHECK (parcel_count BETWEEN 1 AND 200),
  status             TEXT NOT NULL DEFAULT 'Préparé',
  handed_over_at     TEXT,
  handed_over_by     TEXT,
  departed_at        TEXT,
  arrived_at         TEXT,
  arrived_by         TEXT,
  checked_at         TEXT,
  checked_by         TEXT,
  missing_parcel_ids JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso     TEXT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bordereaux_from ON bordereaux (from_agency_id);
CREATE INDEX IF NOT EXISTS idx_bordereaux_to   ON bordereaux (to_agency_id);

-- Composition du bordereau : jamais modifiée après création (la preuve est
-- figée à la remise au transporteur).
CREATE TABLE IF NOT EXISTS bordereau_parcels (
  bordereau_id TEXT NOT NULL REFERENCES bordereaux(id),
  parcel_id    TEXT NOT NULL REFERENCES parcels(id),
  PRIMARY KEY (bordereau_id, parcel_id)
);

-- Un colis appartient au plus à un bordereau (colonne additive, NULL = hors
-- bordereau : les colis existants continuent de fonctionner comme avant).
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS bordereau_id TEXT REFERENCES bordereaux(id);

-- LOT 4 — photos de preuve (prise en charge / arrivée) : 2 maximum par étape,
-- image/* uniquement, contenu stocké HORS de Postgres (lib/photos.js : disque
-- local ou Vercel Blob), accès limité aux deux agences du colis, jamais
-- supprimables par les agences. La base ne garde que les métadonnées.
CREATE TABLE IF NOT EXISTS photos (
  id             TEXT PRIMARY KEY,
  parcel_id      TEXT NOT NULL REFERENCES parcels(id),
  etape          TEXT NOT NULL CHECK (etape IN ('prise_en_charge', 'arrivee')),
  storage_key    TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  agency_id      TEXT NOT NULL REFERENCES agencies(id),
  agent_id       TEXT,
  agent_name     TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_parcel ON photos (parcel_id, etape);

-- LOT 4 — incidents : état LATÉRAL du colis (jamais dans la chaîne des 5
-- statuts, un colis perdu peut être retrouvé). Visible par les deux agences ;
-- le suivi public n'affiche qu'un bandeau sobre, sans aucun détail.
CREATE TABLE IF NOT EXISTS incidents (
  id                   TEXT PRIMARY KEY,
  parcel_id            TEXT NOT NULL REFERENCES parcels(id),
  bordereau_id         TEXT REFERENCES bordereaux(id),
  type                 TEXT NOT NULL CHECK (type IN ('perdu', 'endommage', 'retard', 'conteste', 'bloque')),
  state                TEXT NOT NULL DEFAULT 'ouvert' CHECK (state IN ('ouvert', 'recherches', 'resolu')),
  note                 TEXT NOT NULL DEFAULT '',
  resolution           TEXT NOT NULL DEFAULT '',
  opened_by_agency_id  TEXT NOT NULL REFERENCES agencies(id),
  opened_by_id         TEXT,
  opened_by_name       TEXT NOT NULL DEFAULT '',
  opened_at_iso        TEXT NOT NULL,
  updated_by_name      TEXT NOT NULL DEFAULT '',
  resolved_at_iso      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidents_parcel ON incidents (parcel_id);
CREATE INDEX IF NOT EXISTS idx_incidents_state  ON incidents (state);

-- LOT 4 — retour à l'expéditeur des colis en souffrance (colonnes additives,
-- NULL = colis jamais concerné). Le trajet retour est tracé dans l'historique
-- du colis ; les frais de magasinage éventuels vont dans la caisse.
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS retour_status          TEXT;   -- 'en_cours' | 'termine'
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS retour_started_at      TEXT;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS retour_completed_at    TEXT;

-- LOT 4 — libellé d'un encaissement (colonne additive) : distingue les
-- frais de magasinage (retour d'un colis en souffrance) du prix d'un colis.
ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

-- LOT 5 — journal des notifications : une ligne par agence destinataire et
-- par événement (incident ouvert / escalade 24 h, bordereau arrivé / écart au
-- contrôle, colis en souffrance, retour à l'expéditeur décidé / reçu, colis
-- qui dorment). MODE SIMULATION par défaut (statut 'simule') : aucun envoi
-- réel sans configuration (lib/notifications.js). La clé de dédoublonnage
-- garantit une seule notification par événement et par agence, même quand
-- les échéances sont détectées par plusieurs balayages. Titre et message ne
-- contiennent aucune donnée personnelle. Pas de suppression : on marque lu.
CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  agency_id      TEXT NOT NULL REFERENCES agencies(id),   -- destinataire (une des deux agences concernées)
  type           TEXT NOT NULL,
  titre          TEXT NOT NULL,
  message        TEXT NOT NULL,
  lien           TEXT NOT NULL DEFAULT '',                -- lien interne relatif (colis.html?id=…, bordereaux.html?id=…)
  parcel_id      TEXT REFERENCES parcels(id),
  bordereau_id   TEXT REFERENCES bordereaux(id),
  incident_id    TEXT REFERENCES incidents(id),
  canal          TEXT NOT NULL DEFAULT 'simulation',      -- simulation | whatsapp | sms | email
  statut         TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'simule', 'envoye', 'echec')),
  erreur         TEXT NOT NULL DEFAULT '',
  dedup_key      TEXT NOT NULL UNIQUE,
  lu             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_agency ON notifications (agency_id, created_at);

-- LOT 6 — plans, quotas, portefeuille, console plateforme (additif, idempotent).
-- Plan de l'agence : 'gratuit' (50 colis/mois, puis 30 FCFA prépayés),
-- 'pro' (10 000 FCFA/mois, 500 colis), 'reseau' (sur devis : quota et prix
-- négociés, quota NULL = illimité). `plan_suivant` = retour au Gratuit
-- programmé au début du mois suivant. Le portefeuille ne peut jamais être
-- négatif (contrainte) : les colis hors forfait sont PRÉPAYÉS.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'gratuit'
  CHECK (plan IN ('gratuit', 'pro', 'reseau'));
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS plan_suivant TEXT
  CHECK (plan_suivant IS NULL OR plan_suivant IN ('gratuit', 'pro'));
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS quota_negocie INTEGER;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS prix_negocie_fcfa INTEGER;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS portefeuille_fcfa INTEGER NOT NULL DEFAULT 0
  CHECK (portefeuille_fcfa >= 0);

-- Une ligne par agence et par mois (« AAAA-MM ») : plan et quota figés à
-- l'ouverture, compteur atomique des colis créés par l'agence EXPÉDITRICE
-- (l'agence de destination ne paie jamais), abonnement et échéance.
CREATE TABLE IF NOT EXISTS facturation_periodes (
  agency_id          TEXT NOT NULL REFERENCES agencies(id),
  periode            TEXT NOT NULL,
  plan               TEXT NOT NULL,
  quota              INTEGER,                              -- NULL = illimité (Réseau)
  colis_comptes      INTEGER NOT NULL DEFAULT 0 CHECK (colis_comptes >= 0),
  colis_depassement  INTEGER NOT NULL DEFAULT 0 CHECK (colis_depassement >= 0),
  abonnement_fcfa    INTEGER NOT NULL DEFAULT 0,
  abonnement_statut  TEXT NOT NULL DEFAULT 'sans_frais'
                     CHECK (abonnement_statut IN ('sans_frais', 'du', 'paye')),
  echeance_iso       TEXT,
  paye_le_iso        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso     TEXT NOT NULL,
  PRIMARY KEY (agency_id, periode)
);

-- Journal immuable du portefeuille (aucune route de modification ni de
-- suppression) : montant signé (+ crédit, − débit) et solde après opération.
CREATE TABLE IF NOT EXISTS portefeuille_mouvements (
  id                TEXT PRIMARY KEY,
  agency_id         TEXT NOT NULL REFERENCES agencies(id),
  type              TEXT NOT NULL CHECK (type IN ('recharge', 'depassement', 'abonnement', 'ajustement')),
  montant_fcfa      INTEGER NOT NULL,
  solde_apres_fcfa  INTEGER NOT NULL,
  periode           TEXT,
  parcel_id         TEXT,
  libelle           TEXT NOT NULL,
  reference         TEXT,
  acteur_nom        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portefeuille_mouvements_agency_idx
  ON portefeuille_mouvements (agency_id, created_at DESC);

-- Comptes de la console plateforme (Shopin30) : SÉPARÉS des agences et des
-- agents (table, route de connexion et cookie distincts). Créés par
-- `npm run plateforme-admin` en production (variables d'environnement),
-- par le seed en démo.
CREATE TABLE IF NOT EXISTS plateforme_admins (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso  TEXT NOT NULL
);

-- LOT 7 — suivi personnalisé par agence (additif, idempotent). Facultatif et
-- désactivé par défaut : nom affiché, couleurs « #rrggbb » (contrôlées côté
-- serveur), logo PNG/JPEG/WebP stocké via lib/photos.js (la clé de stockage
-- n'est jamais exposée ; le logo public passe par /api/suivi/:code/logo).
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_nom TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_couleur TEXT
  CHECK (marque_couleur IS NULL OR marque_couleur ~ '^#[0-9a-f]{6}$');
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_couleur_2 TEXT
  CHECK (marque_couleur_2 IS NULL OR marque_couleur_2 ~ '^#[0-9a-f]{6}$');
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_logo_cle TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_logo_type TEXT
  CHECK (marque_logo_type IS NULL OR marque_logo_type IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS marque_maj_iso TEXT;

-- LOT 7 — paiements en ligne (SasPay, paiement hébergé). Un paiement n'est
-- appliqué (caisse ou portefeuille) qu'une fois vérifié auprès du prestataire ;
-- `effet_applique` bascule dans la même instruction que l'écriture métier
-- (application unique, même si retour navigateur et webhook arrivent ensemble).
-- Mode figé à la création : simulation (sans clé), test (sk_test_), live.
CREATE TABLE IF NOT EXISTS paiements_en_ligne (
  id                     TEXT PRIMARY KEY,
  agency_id              TEXT NOT NULL REFERENCES agencies(id),
  objet                  TEXT NOT NULL CHECK (objet IN ('colis', 'abonnement', 'recharge')),
  parcel_id              TEXT REFERENCES parcels(id),
  periode                TEXT,
  montant_fcfa           INTEGER NOT NULL CHECK (montant_fcfa > 0),
  libelle                TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode IN ('simulation', 'test', 'live')),
  session_id             TEXT UNIQUE,
  checkout_url           TEXT,
  retour_chemin          TEXT,
  statut                 TEXT NOT NULL DEFAULT 'en_attente'
                         CHECK (statut IN ('en_attente', 'paye', 'echec', 'expire', 'annule')),
  simulation_statut      TEXT CHECK (simulation_statut IS NULL OR simulation_statut IN ('PENDING', 'PAID', 'FAILED')),
  transaction_id         TEXT,
  transaction_reference  TEXT,
  effet_applique         BOOLEAN NOT NULL DEFAULT FALSE,
  acteur_id              TEXT,
  acteur_nom             TEXT,
  confirme_le_iso        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso         TEXT NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paiements_en_ligne_agency_idx ON paiements_en_ligne (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paiements_en_ligne_transaction_idx ON paiements_en_ligne (transaction_id);

-- Journal minimal des webhooks dont la signature est VALIDE (événement et
-- identifiant de transaction seulement : jamais le numéro débité).
CREATE TABLE IF NOT EXISTS paiements_webhooks (
  id              TEXT PRIMARY KEY,
  evenement       TEXT NOT NULL,
  transaction_id  TEXT,
  recu_le_iso     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LOT 8 — amorçage du premier administrateur de la console sans terminal.
-- Une seule ligne possible (clé fixe) : la création du premier compte est
-- atomique même si deux demandes arrivent en parallèle ; une fois la ligne
-- posée, l'amorçage est définitivement fermé (aucune suppression).
CREATE TABLE IF NOT EXISTS plateforme_amorcage (
  cle             TEXT PRIMARY KEY,
  admin_id        TEXT REFERENCES plateforme_admins(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_iso  TEXT NOT NULL
);

-- LOT 9/11 — journal des exécutions de la tâche quotidienne (Vercel Cron).
-- Lue par le panneau « Mise en service » de la console ; remplie au LOT 11.
CREATE TABLE IF NOT EXISTS taches_executions (
  id               TEXT PRIMARY KEY,
  declencheur      TEXT NOT NULL DEFAULT 'cron',
  demarree_le_iso  TEXT NOT NULL,
  terminee_le_iso  TEXT,
  duree_ms         INTEGER,
  statut           TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'ok', 'partiel', 'erreur')),
  resultats        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

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

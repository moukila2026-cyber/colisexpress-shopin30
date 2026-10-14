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

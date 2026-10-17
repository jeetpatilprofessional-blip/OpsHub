CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text UNIQUE,
  password_hash text NOT NULL,
  global_role text NOT NULL DEFAULT 'Member' CHECK (global_role IN ('Public', 'Member', 'Manager', 'Admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text UNIQUE;

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Live',
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  modules text[] NOT NULL DEFAULT '{}',
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  roles text[] NOT NULL DEFAULT '{Public,Member,Manager,Admin}',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  release integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_memberships (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('Public', 'Member', 'Manager', 'Admin')),
  PRIMARY KEY (site_id, user_id)
);

CREATE TABLE IF NOT EXISTS site_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('inventory', 'requests', 'approvals', 'assignments', 'consumption', 'returns', 'repairs')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_records_lookup ON site_records(site_id, resource, created_at DESC);

CREATE TABLE IF NOT EXISTS site_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL,
  actor text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id, version)
);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_isolation ON sites;
CREATE POLICY site_isolation ON sites
  USING (id::text = current_setting('opshub.site_id', true))
  WITH CHECK (id::text = current_setting('opshub.site_id', true));

ALTER TABLE site_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_isolation ON site_memberships;
CREATE POLICY membership_isolation ON site_memberships
  USING (site_id::text = current_setting('opshub.site_id', true) OR user_id::text = current_setting('opshub.user_id', true))
  WITH CHECK (site_id::text = current_setting('opshub.site_id', true));

ALTER TABLE site_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_isolation ON site_records;
CREATE POLICY record_isolation ON site_records
  USING (site_id::text = current_setting('opshub.site_id', true))
  WITH CHECK (site_id::text = current_setting('opshub.site_id', true));

ALTER TABLE site_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_releases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS release_isolation ON site_releases;
CREATE POLICY release_isolation ON site_releases
  USING (site_id::text = current_setting('opshub.site_id', true))
  WITH CHECK (site_id::text = current_setting('opshub.site_id', true));
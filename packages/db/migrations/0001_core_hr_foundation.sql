-- =============================================================================
-- 0001 — Core HR foundation
-- Feature: 001-core-hr-foundation   Requirements: REQ-001..REQ-010, RULE-001..003
--
-- SQL is authoritative. Migrations are hand-written, not generated, because the
-- security model (RLS policies, grants, exclusion constraints) lives here and
-- must be reviewable line by line in a diff.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- exclusion constraint on (uuid, daterange)
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- -----------------------------------------------------------------------------
-- Application role.
--
-- The app does NOT connect as the table owner. Owners bypass RLS unless FORCE is
-- used, and even with FORCE, a non-owner role with no DDL is a second line of
-- defence and the thing that makes the audit-log immutability grant meaningful.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    CREATE ROLE hrms_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Tenant context.
--
-- Set transaction-locally at the start of every request. Policies read it.
-- Application code NEVER writes "WHERE tenant_id = ?" — if it did, forgetting it
-- once would be the breach. Here, forgetting it returns zero rows.
--
-- current_tenant() returns NULL when unset, and every policy compares with "=",
-- which is NULL-safe-false. Unset therefore means ZERO rows, never all rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$$;

-- =============================================================================
-- Tables
-- =============================================================================

CREATE TABLE tenant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  region       text NOT NULL CHECK (region IN ('eu','in')),  -- COMP-40 residency
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- The tenant registry is itself tenant-scoped: without this, any tenant reads
-- the full customer list AND can rewrite another tenant's residency region.
-- Provisioning is an owner-role operation; the app gets SELECT of its own row.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_only ON tenant USING (id = current_tenant());

-- The human. Survives employments; a rehire reuses this row (Q-02).
CREATE TABLE person (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  legal_name       text NOT NULL CHECK (length(btrim(legal_name)) > 0),
  preferred_name   text,
  pronouns         text,
  -- No CURRENT_DATE here: a non-immutable CHECK is a pg_restore hazard.
  -- The >= 16 years rule is a business rule and lives in packages/core.
  date_of_birth    date CHECK (date_of_birth > '1900-01-01'),
  personal_email   citext,
  personal_phone   text,
  emergency_contact text,
  profile_photo_url text,
  -- Encrypted at the application layer before it reaches this column (SEC-04).
  -- Never logged, masked in UI (PRIV-07).
  national_id_ref  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE employment_status AS ENUM
  ('pre_hire','active','on_leave','notice','exited','cancelled');

CREATE TABLE employment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  employee_number  text NOT NULL,
  work_email       citext,
  hire_date        date NOT NULL,
  exit_date        date,
  status           employment_status NOT NULL DEFAULT 'pre_hire',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_exit_after_hire CHECK (exit_date IS NULL OR exit_date >= hire_date),
  CONSTRAINT employment_number_unique UNIQUE (tenant_id, employee_number),
  CONSTRAINT employment_work_email_unique UNIQUE (tenant_id, work_email),
  -- Referenced by the composite manager FK below. Foreign-key checks run with
  -- the referencing table's privileges and BYPASS RLS, so without the tenant
  -- component a manager pointer into another tenant is silently accepted.
  CONSTRAINT employment_tenant_id_unique UNIQUE (tenant_id, id)
);

-- Only ONE non-terminal employment per person per tenant (Q-01).
-- Enforced by a partial unique index, not by application code.
CREATE UNIQUE INDEX employment_one_open_per_person
  ON employment (tenant_id, person_id)
  WHERE status IN ('pre_hire','active','on_leave','notice');

CREATE TYPE employment_type AS ENUM
  ('full_time','part_time','fixed_term','intern','contractor');

-- Effective-dated org tree. Reorganisations are historical facts: "how many were
-- in Payments on 1 July" must stay answerable after Payments merges into Commerce.
-- Stable identity. Never changes, never closed. Everything points HERE.
CREATE TABLE org_unit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_unit_code_unique UNIQUE (tenant_id, code)
);

-- Effective-dated attributes. A reorganisation appends a version; it does NOT
-- create a new org unit, so employment_version rows keep pointing at a live
-- identity and headcount survives the reorg.
CREATE TABLE org_unit_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  parent_id    uuid REFERENCES org_unit(id),
  name         text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  decided_by   uuid NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  CONSTRAINT ouv_interval CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT ouv_no_self_parent CHECK (parent_id IS DISTINCT FROM org_unit_id)
);
ALTER TABLE org_unit_version
  ADD CONSTRAINT org_unit_version_no_overlap
  EXCLUDE USING gist (
    org_unit_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
CREATE INDEX ouv_point_in_time ON org_unit_version (tenant_id, org_unit_id, valid_from, valid_to);
CREATE INDEX ouv_parent ON org_unit_version (tenant_id, parent_id, valid_from, valid_to);

CREATE TYPE job_position_status AS ENUM ('open','filled','closed');

-- Same identity/version split as org_unit, for the same reason.
CREATE TABLE job_position (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_position_code_unique UNIQUE (tenant_id, code)
);

CREATE TABLE job_position_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  position_id  uuid NOT NULL REFERENCES job_position(id),
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  title        text NOT NULL,
  headcount    integer NOT NULL DEFAULT 1 CHECK (headcount > 0),
  -- Salary BAND only. Individual amounts never live in Core HR
  -- (docs/07-fairness-and-transparency.md: bands are visible, individuals are not).
  salary_band  text,
  status       job_position_status NOT NULL DEFAULT 'open',
  valid_from   date NOT NULL,
  valid_to     date,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT jpv_interval CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
ALTER TABLE job_position_version
  ADD CONSTRAINT job_position_version_no_overlap
  EXCLUDE USING gist (
    position_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
-- NOTE: vacancy is DERIVED (headcount minus filled assignments on the as-of date),
-- never stored. A stored vacancy count drifts within a week.

-- -----------------------------------------------------------------------------
-- The temporal core (RULE-001).
--
-- Append-only. Business time [valid_from, valid_to) — half-open, dates not
-- timestamps. System time recorded_at. Rows are NEVER updated except to close
-- valid_to, and NEVER deleted.
-- -----------------------------------------------------------------------------
CREATE TABLE employment_version (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenant(id),
  employment_id                   uuid NOT NULL REFERENCES employment(id),
  valid_from                      date NOT NULL,
  valid_to                        date,
  -- System time. [recorded_at, superseded_at) answers "what did we know at T".
  -- Closing a version APPENDS a replacement and stamps superseded_at on the old
  -- row; valid_to is never overwritten, because valid_to IS the answer to the
  -- system-time question and rewriting it destroys the only record of what we
  -- believed. Required to reproduce a payroll run after a retroactive change.
  recorded_at                     timestamptz NOT NULL DEFAULT now(),
  superseded_at                   timestamptz,
  org_unit_id                     uuid NOT NULL REFERENCES org_unit(id),
  position_id                     uuid REFERENCES job_position(id),
  job_title                       text NOT NULL,
  manager_employment_id           uuid,
  secondary_manager_employment_id uuid,
  employment_type                 employment_type NOT NULL,
  work_location                   text,
  cost_centre                     text,
  -- decided_by and reason are NOT NULL by design, not by oversight.
  -- A change to a person that nobody had to justify in words is exactly the
  -- change nobody can explain a year later.
  decided_by                      uuid NOT NULL,
  reason                          text NOT NULL CHECK (length(btrim(reason)) > 0),
  idempotency_key                 text,
  CONSTRAINT ev_interval CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT ev_not_self_manager CHECK (manager_employment_id IS DISTINCT FROM employment_id),
  CONSTRAINT ev_not_self_secondary CHECK (secondary_manager_employment_id IS DISTINCT FROM employment_id),
  -- Composite: the manager must be in the SAME tenant. Enforced by the database
  -- so no application code has to remember.
  CONSTRAINT ev_manager_same_tenant
    FOREIGN KEY (tenant_id, manager_employment_id) REFERENCES employment (tenant_id, id),
  CONSTRAINT ev_secondary_manager_same_tenant
    FOREIGN KEY (tenant_id, secondary_manager_employment_id) REFERENCES employment (tenant_id, id)
);

-- Non-overlap enforced by the DATABASE, not by application code.
-- Empty ranges (valid_from = valid_to, produced by a retroactive supersede) do
-- not participate in &&, which is exactly what RULE-001 needs.
-- Without this, a concurrency race silently double-counts a person in two org
-- units and every downstream headcount is wrong.
-- Only system-live rows participate: superseded rows are history, and history
-- is allowed to overlap the present.
ALTER TABLE employment_version
  ADD CONSTRAINT employment_version_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);

CREATE UNIQUE INDEX ev_idempotency
  ON employment_version (tenant_id, employment_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND superseded_at IS NULL;

-- Covering index for the point-in-time query (RULE-002) — the hot path.
CREATE INDEX ev_point_in_time
  ON employment_version (tenant_id, employment_id, valid_from, valid_to);
CREATE INDEX ev_org_unit_asof
  ON employment_version (tenant_id, org_unit_id, valid_from, valid_to);
CREATE INDEX ev_manager
  ON employment_version (tenant_id, manager_employment_id, valid_from, valid_to);

-- =============================================================================
-- Platform tables — the compliance and transparency promises, as schema
-- =============================================================================

-- COMP-53. Append-only: UPDATE and DELETE are revoked from hrms_app below.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  actor_id       uuid,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    uuid,
  at             timestamptz NOT NULL DEFAULT now(),
  ip             inet,
  -- PII-redacted before write (PRIV-07). Asserted by test.
  before_data    jsonb,
  after_data     jsonb,
  -- Sensitive READS are audited, not only writes (COMP-53).
  sensitive_read boolean NOT NULL DEFAULT false
);
CREATE INDEX audit_log_resource ON audit_log (tenant_id, resource_type, resource_id, at DESC);
CREATE INDEX audit_log_actor ON audit_log (tenant_id, actor_id, at DESC);

-- docs/07-fairness-and-transparency.md Part 2. Visible to the subject by default.
CREATE TABLE transparency_ledger (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  subject_employment_id uuid NOT NULL REFERENCES employment(id),
  what                  text NOT NULL,
  decided_by            uuid NOT NULL,
  -- Denormalised on purpose: the ledger is a historical record, not a join.
  -- If the decider is later deleted, the entry must still say who decided.
  decided_by_name       text NOT NULL,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  reason                text NOT NULL CHECK (length(btrim(reason)) > 0),
  effective_from        date,
  ai_involved           boolean NOT NULL DEFAULT false,
  ai_basis              text,
  -- Part 5: a manager changing the record of someone who manages THEM is
  -- permitted but flagged, and visible to HR.
  reciprocal            boolean NOT NULL DEFAULT false,
  CONSTRAINT ledger_ai_basis_required
    CHECK (NOT ai_involved OR (ai_basis IS NOT NULL AND length(btrim(ai_basis)) > 0))
);
CREATE INDEX ledger_subject ON transparency_ledger (tenant_id, subject_employment_id, decided_at DESC);

-- COMP-23 — a legal hold overrides erasure, is auditable, and the person can be
-- told a hold exists where the law permits.
--
-- Employment status is NOT a legal hold. An ex-employee under litigation hold is
-- `exited`, and a person serving notice is not under hold at all — conflating
-- the two destroys evidence in one direction and blocks the wrong people in the
-- other.
CREATE TABLE legal_hold (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  person_id    uuid NOT NULL REFERENCES person(id),
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  scope        text NOT NULL DEFAULT 'all',
  placed_by    uuid NOT NULL,
  placed_at    timestamptz NOT NULL DEFAULT now(),
  released_by  uuid,
  released_at  timestamptz,
  CONSTRAINT legal_hold_release CHECK (
    (released_at IS NULL AND released_by IS NULL) OR
    (released_at IS NOT NULL AND released_by IS NOT NULL))
);
CREATE INDEX legal_hold_person ON legal_hold (tenant_id, person_id) WHERE released_at IS NULL;

-- COMP-01, COMP-34. The source of truth for retention, permissions, export and
-- erasure. Populated by migration alongside every schema change; CI fails if a
-- new column in a personal-data table has no row here.
CREATE TABLE data_classification (
  table_name     text NOT NULL,
  column_name    text NOT NULL,
  classification text NOT NULL CHECK (classification IN
    ('identity','financial','health','biometric','employment','internal','ugc')),
  purpose        text NOT NULL,
  lawful_basis   text NOT NULL,
  retention_days integer,
  statutory_ref  text,
  PRIMARY KEY (table_name, column_name)
);

-- First-party analytics. No third-party SDK in the employee-facing app
-- (docs/06-technology-decisions.md §The analytics decision).
CREATE TABLE analytics_event (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  -- Property names and non-identifying values only. Never free text from a user.
  props      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX analytics_event_name ON analytics_event (tenant_id, name, at DESC);

-- =============================================================================
-- Row-Level Security
--
-- FORCE, not just ENABLE. ENABLE does not apply to the table owner, and app
-- connections very often run as the owner. This is the single most common
-- multi-tenant leak in exactly this architecture.
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'person','employment','org_unit','org_unit_version',
    'job_position','job_position_version','employment_version',
    'audit_log','transparency_ledger','analytics_event','legal_hold'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- current_tenant() is NULL when app.tenant_id is unset, and "=" against NULL
    -- is NULL (not true) — so an unset session sees ZERO rows, never all rows.
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (tenant_id = current_tenant())
         WITH CHECK (tenant_id = current_tenant())',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- Grants: DML only, no DDL.
GRANT USAGE ON SCHEMA public TO hrms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

-- The audit log is append-only for the application. This is a grant, enforced by
-- the database, not a convention enforced by code review.
REVOKE UPDATE, DELETE ON audit_log FROM hrms_app;
-- Same for the transparency ledger: corrections append, they never overwrite.
REVOKE UPDATE, DELETE ON transparency_ledger FROM hrms_app;

-- ...with one deliberate exception each, because append-only and erasable are
-- both real obligations and they collide.
--
-- `decided_by_name` is denormalised so the ledger can still say WHO decided
-- after that person leaves — which is exactly what makes it un-erasable
-- otherwise. A COLUMN-level grant lets erasure pseudonymise that one field
-- while every other column, including `reason`, stays immutable.
-- Same reasoning for the audit log's actor link (COMP-22 vs COMP-53).
GRANT UPDATE (decided_by_name) ON transparency_ledger TO hrms_app;
GRANT UPDATE (actor_id) ON audit_log TO hrms_app;
-- Reference data is read-only to the app.
REVOKE INSERT, UPDATE, DELETE ON data_classification FROM hrms_app;

-- History is never hard-deleted by the application. RULE-001 says versions are
-- "never updated and never deleted" — that must be a grant, not a convention in
-- packages/core that one bad cleanup script or injection defect can ignore.
REVOKE DELETE ON employment_version FROM hrms_app;
REVOKE DELETE ON org_unit_version FROM hrms_app;
REVOKE DELETE ON job_position_version FROM hrms_app;
REVOKE DELETE ON employment FROM hrms_app;
REVOKE DELETE ON org_unit FROM hrms_app;

-- ...and the same for UPDATE. BLOCKER-4's whole argument is that overwriting a
-- version destroys the record of what we believed; leaving UPDATE open left that
-- one bad cleanup script away. Same narrow-scope pattern as the ledger: revoke
-- the table, grant the two columns the legitimate paths actually need.
REVOKE UPDATE ON employment_version FROM hrms_app;
GRANT UPDATE (superseded_at) ON employment_version TO hrms_app;  -- system-time close
GRANT UPDATE (reason) ON employment_version TO hrms_app;         -- erasure only
REVOKE UPDATE ON org_unit_version FROM hrms_app;
GRANT UPDATE (superseded_at, valid_to) ON org_unit_version TO hrms_app;
REVOKE UPDATE ON job_position_version FROM hrms_app;
GRANT UPDATE (superseded_at, valid_to, status) ON job_position_version TO hrms_app;

-- A hold is placed and released, never edited or deleted.
REVOKE UPDATE, DELETE ON legal_hold FROM hrms_app;
GRANT UPDATE (released_by, released_at) ON legal_hold TO hrms_app;

-- Tenant provisioning is an owner operation, never an application one.
REVOKE INSERT, UPDATE, DELETE ON tenant FROM hrms_app;

-- =============================================================================
-- Classification seed (COMP-01)
-- =============================================================================
INSERT INTO data_classification
  (table_name, column_name, classification, purpose, lawful_basis, retention_days, statutory_ref) VALUES
  ('person','legal_name','identity','Identify the employee on records and filings','employment_legitimate_use',NULL,'[LAW — VERIFY per market]'),
  ('person','preferred_name','identity','Address the employee as they wish to be addressed','employment_legitimate_use',NULL,NULL),
  ('person','pronouns','identity','Address the employee correctly','employment_legitimate_use',NULL,NULL),
  ('person','date_of_birth','identity','Statutory age checks and benefits eligibility','employment_legitimate_use',NULL,'[LAW — VERIFY per market]'),
  ('person','personal_email','identity','Contact after work access is revoked','employment_legitimate_use',NULL,NULL),
  ('person','personal_phone','identity','Emergency and offboarding contact','employment_legitimate_use',NULL,NULL),
  ('person','national_id_ref','identity','Statutory filing and payroll identity','legal_obligation',NULL,'[LAW — VERIFY per market]'),
  ('employment','employee_number','internal','Internal identifier','employment_legitimate_use',NULL,NULL),
  ('employment','work_email','identity','Work communication and authentication','employment_legitimate_use',NULL,NULL),
  ('employment','hire_date','employment','Tenure, benefits, statutory filings','employment_legitimate_use',NULL,'[LAW — VERIFY per market]'),
  ('employment','exit_date','employment','Final settlement and statutory filings','employment_legitimate_use',NULL,'[LAW — VERIFY per market]'),
  ('employment_version','job_title','employment','Role, reporting and org reporting','employment_legitimate_use',NULL,NULL),
  ('employment_version','org_unit_id','employment','Reporting structure and headcount','employment_legitimate_use',NULL,NULL),
  ('employment_version','manager_employment_id','employment','Approval routing and reporting line','employment_legitimate_use',NULL,NULL),
  ('employment_version','cost_centre','internal','Cost allocation','legitimate_interest',NULL,NULL),
  ('employment_version','reason','employment','Transparency to the affected employee','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','reason','employment','Tell the employee why a decision was made','employment_legitimate_use',NULL,NULL),
  -- MAJOR-4: the gate previously covered `person` only. Location is a proxy for
  -- protected characteristics (docs/07-fairness-and-transparency.md Part 1), and
  -- a missing row here silently becomes a missing row in the RoPA, the retention
  -- schedule, the export and the erasure plan.
  ('person','emergency_contact','identity','Contact someone in an emergency','employment_legitimate_use',NULL,NULL),
  ('person','profile_photo_url','identity','Recognise colleagues in the directory','employment_legitimate_use',NULL,NULL),
  ('employment','status','employment','Headcount, access provisioning and offboarding','employment_legitimate_use',2555,'[LAW — VERIFY per market]'),
  ('employment','person_id','internal','Link a person to their employment','employment_legitimate_use',NULL,NULL),
  ('employment_version','work_location','employment','Statutory jurisdiction and workplace safety','employment_legitimate_use',2555,'[LAW — VERIFY per market]'),
  ('employment_version','secondary_manager_employment_id','employment','Dotted-line reporting','employment_legitimate_use',NULL,NULL),
  ('employment_version','position_id','employment','Seat and headcount tracking','employment_legitimate_use',NULL,NULL),
  ('employment_version','employment_type','employment','Statutory classification and benefits eligibility','employment_legitimate_use',2555,'[LAW — VERIFY per market]'),
  ('employment_version','decided_by','employment','Accountability for a decision about a person','employment_legitimate_use',NULL,NULL),
  ('employment_version','valid_from','employment','When a change takes effect','employment_legitimate_use',NULL,NULL),
  ('employment_version','valid_to','employment','When a change stops applying','employment_legitimate_use',NULL,NULL),
  ('job_position_version','salary_band','financial','Pay-range transparency without exposing individuals','employment_legitimate_use',NULL,'[LAW — VERIFY: pay transparency rules per market]'),
  ('job_position_version','title','employment','Role definition','employment_legitimate_use',NULL,NULL),
  ('org_unit_version','name','internal','Org structure','employment_legitimate_use',NULL,NULL),
  ('org_unit_version','parent_id','internal','Org hierarchy','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','decided_by','employment','Accountability','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','decided_by_name','identity','Tell the employee WHO decided, even after that person leaves','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','what','employment','Tell the employee what changed','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','reciprocal','employment','Flag a manager changing their own manager record','employment_legitimate_use',NULL,NULL),
  ('transparency_ledger','ai_basis','employment','Explain an AI contribution in plain language','employment_legitimate_use',NULL,NULL),
  ('audit_log','actor_id','employment','Who did what','legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','before_data','employment','Evidence of what changed (PII-redacted)','legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','after_data','employment','Evidence of what changed (PII-redacted)','legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('analytics_event','actor_id','internal','First-party product analytics','legitimate_interest',730,NULL),
  ('org_unit_version','decided_by','employment','Accountability for an org change','employment_legitimate_use',NULL,NULL),
  ('org_unit_version','reason','employment','Explain an org change to the people in it','employment_legitimate_use',NULL,NULL),
  ('legal_hold','reason','employment','Why erasure is suspended for this person','legal_obligation',NULL,'[LAW — VERIFY per market]'),
  ('legal_hold','placed_by','employment','Accountability for placing a hold','legal_obligation',NULL,NULL),
  ('legal_hold','released_by','employment','Accountability for releasing a hold','legal_obligation',NULL,NULL),
  ('legal_hold','scope','employment','What the hold covers','legal_obligation',NULL,NULL);

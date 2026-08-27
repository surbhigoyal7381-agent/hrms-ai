-- =============================================================================
-- 0003 — Employee self-service record view, and the four tenant-identity locks
--
-- Feature: 002-employee-self-service-record-view
-- Requirements: REQ-001..REQ-031, RULE-001..RULE-014
-- Decisions:  docs/99-decision-log.md, 2026-08-26, one-way door 1
--             docs/features/002-employee-self-service-record-view/99-decision-log.md
--
-- Additive only. No column is dropped or retyped and no existing row is
-- rewritten, so the down path at the foot of this file loses no data.
-- =============================================================================

-- =============================================================================
-- PART 1 — The four tenant-identity locks
--
-- This feature ships the product's first public endpoints. `app.tenant_id` is an
-- ordinary session variable that the application role can set freely, and every
-- row-level security policy trusts it, so from deploy day an injection defect
-- anywhere escalates to a full cross-tenant breach. FORCE ROW LEVEL SECURITY
-- does not help: the attacker satisfies the policy as somebody else rather than
-- bypassing it.
--
-- Feature 001's log named a `SECURITY DEFINER` setter as the fix. It is not one,
-- on its own — verified, with the correction appended to that log. Four locks
-- are needed and each closes a different statement shape:
--
--   1. REVOKE set_config      -> no GUC write inside a single statement
--   2. extended protocol only -> no stacked second statement  (packages/core/src/db.ts)
--   3. write-once setter      -> the one legitimate path, immutable once set
--   4. REVOKE plpgsql USAGE   -> no DO block running EXECUTE 'SET ...'
--
-- Lock 4 exists because a DO block is ONE statement, so lock 2 permits it, and
-- `EXECUTE 'SET ...'` inside PL/pgSQL is a utility statement, so lock 1 does not
-- see it. Verified on postgres:16:
--
--   SELECT set_config('app.tenant_id','x',false)
--     -> ERROR: permission denied for function set_config      (lock 1 holding)
--   DO $$ BEGIN EXECUTE 'SET app.tenant_id = ''pwned'''; END $$; SHOW app.tenant_id;
--     -> DO / pwned                                            (locks 1+2 walked around)
--   ...after REVOKE USAGE ON LANGUAGE plpgsql:
--     -> ERROR: permission denied for language plpgsql          (closed)
-- =============================================================================

-- LOCK 3. The only granted way to bind a transaction to a tenant.
--
-- Write-once: a second call in the same transaction raises. That makes the
-- tenant immutable for the life of the transaction even on the legitimate path,
-- so a bug that re-enters this function is loud rather than silent.
--
-- Transaction-local (`set_config(..., true)`), so a pooled connection cannot
-- carry one tenant's context into the next request. Verified: the setting
-- persists to the caller's transaction and is gone after COMMIT.
CREATE OR REPLACE FUNCTION begin_tenant_session(p_tenant uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Empty search_path: a SECURITY DEFINER function that resolves unqualified names
-- through the caller's search_path is the classic privilege-escalation shape.
SET search_path = pg_catalog
AS $$
DECLARE
  existing_tenant text := current_setting('app.tenant_id', true);
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'begin_tenant_session: tenant is required';
  END IF;
  IF existing_tenant IS NOT NULL AND existing_tenant <> '' THEN
    RAISE EXCEPTION
      'begin_tenant_session: tenant already set for this transaction (%)', existing_tenant
      USING HINT = 'One transaction serves one tenant. Open a new transaction.';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('app.actor_employment_id', coalesce(p_actor::text, ''), true);
END $$;

REVOKE EXECUTE ON FUNCTION begin_tenant_session(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION begin_tenant_session(uuid, uuid) TO hrms_app;

-- LOCK 1. `set_config` is how a single injected statement would rewrite the
-- tenant without needing to stack a second one.
--
-- NOTE for anyone tempted by the obvious alternative: `REVOKE SET ON PARAMETER
-- "app.tenant_id"` reports success and does NOTHING for a custom placeholder
-- variable — it creates no pg_parameter_acl row and the role sets the variable
-- anyway. Checking the catalogue rather than the acknowledgement is the lesson.
REVOKE EXECUTE ON FUNCTION set_config(text, text, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION set_config(text, text, boolean) TO postgres;

-- LOCK 4. See the header. Revoking USAGE blocks DO blocks and the creation of
-- PL/pgSQL functions by the application role. It does NOT block CALLING an
-- existing PL/pgSQL function, so `begin_tenant_session` above still works —
-- verified, because getting this backwards would have broken every transaction.
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;

-- =============================================================================
-- PART 2 — What the access log needs from `audit_log`
--
-- The audit log records WHO did what. It could not tell Aisha:
--   * whether "who" was a person or a nightly job — `actor_id IS NULL` meant
--     BOTH "a job did this" and "the person who did this has been erased", and
--     guessing "system" would tell her no person read her record when one did.
--     That is the most damaging false sentence this feature can produce.
--   * the viewer's NAME once they left. The ledger solved this years ago with
--     `decided_by_name`; the audit log never did.
--   * WHY. There is an `action`, which restates itself ("Looking at your
--     details"), not a business purpose ("annual pay review").
--   * WHOSE record was read, without a four-way union over resource_type.
-- =============================================================================

CREATE TYPE audit_actor_kind AS ENUM ('human', 'system');

-- The closed list from RULE-004. A purpose is CHOSEN by the calling path, never
-- inferred: `writeSensitiveRead` takes it as a required argument, so a new read
-- path cannot compile without picking one.
CREATE TYPE access_purpose_code AS ENUM (
  'pay_review', 'payroll_run', 'record_correction', 'onboarding',
  'case_handling', 'employee_request', 'support');

-- Needed for the composite foreign key below. Every foreign key in this schema
-- carries a tenant component, because FK checks run with the referencing
-- table's privileges and BYPASS row-level security — without it, a pointer into
-- another tenant is silently accepted.
ALTER TABLE person ADD CONSTRAINT person_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE audit_log
  ADD COLUMN actor_kind         audit_actor_kind,
  ADD COLUMN actor_display_name text,
  ADD COLUMN actor_role_label   text,
  ADD COLUMN service_name       text,
  ADD COLUMN purpose_code       access_purpose_code,
  ADD COLUMN subject_person_id  uuid;

-- Backfill before the constraints, so the constraints can be trusted rather
-- than deferred. Everything that has ever written to this table was a person
-- acting through `applyEmploymentChange` or `erasePerson`.
UPDATE audit_log SET actor_kind = 'human' WHERE actor_kind IS NULL;

-- An honest sentence beats a blank. A blank in an access log reads as a system
-- that lost something; this reads as a system that started recording later.
UPDATE audit_log
   SET actor_display_name = 'Recorded before names were captured'
 WHERE actor_kind = 'human' AND actor_display_name IS NULL;

-- Derive the subject where it is derivable. Rows whose subject cannot be
-- derived keep NULL, which the CHECK below permits for non-sensitive-read rows.
UPDATE audit_log a SET subject_person_id = a.resource_id
 WHERE a.resource_type = 'person' AND a.resource_id IS NOT NULL
   AND a.subject_person_id IS NULL;
UPDATE audit_log a SET subject_person_id = e.person_id
  FROM employment e
 WHERE a.resource_type = 'employment' AND e.id = a.resource_id
   AND a.subject_person_id IS NULL;

-- NOT NULL with NO DEFAULT, deliberately. A default lets a future writer omit
-- the column and silently get a value; RULE-005 says the actor kind is recorded,
-- never inferred. Every writer must state it.
ALTER TABLE audit_log ALTER COLUMN actor_kind SET NOT NULL;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_actor_shape CHECK (
    (actor_kind = 'human'  AND actor_display_name IS NOT NULL) OR
    (actor_kind = 'system' AND service_name       IS NOT NULL));

-- The access log renders exactly the `sensitive_read` rows, so those must be
-- attributable to a subject or the screen has a hole it cannot see. Tying the
-- rule to `sensitive_read` rather than making the column unconditionally
-- NOT NULL keeps it off rows that genuinely have no subject — a setting flip,
-- or a sign-in attempt from an address that matches nobody.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_subject_present CHECK (
    sensitive_read = false OR subject_person_id IS NOT NULL);

ALTER TABLE audit_log
  ADD CONSTRAINT audit_subject_is_person
  FOREIGN KEY (tenant_id, subject_person_id) REFERENCES person (tenant_id, id);

-- The index that makes REQ-019 bounded. Partial, because only sensitive reads
-- are ever queried this way, and a heavily-audited executive over seven years
-- would otherwise be an unbounded scan (SCALE-02).
CREATE INDEX audit_log_subject_at
  ON audit_log (tenant_id, subject_person_id, at DESC)
  WHERE sensitive_read;

-- COMP-22 vs COMP-53, resolved the way feature 001 resolved it for the ledger:
-- the table stays append-only, and erasure gets ONE column at COLUMN scope so a
-- departed viewer's name can be pseudonymised. `actor_kind`, `actor_role_label`
-- and `purpose_code` stay immutable, which is what keeps the entry readable as
-- a sentence after the name is gone.
GRANT UPDATE (actor_display_name) ON audit_log TO hrms_app;

-- RULE-010 — suppression lives in the QUERY layer, never in a template. A filter
-- in a rendering function is one refactor away from being lost, and invisible in
-- review. The access-log path queries this view and never the table.
--
-- `IS DISTINCT FROM`, not `<>`: `NULL <> 'case_handling'` is NULL, not true, so
-- the plain comparison would silently drop every entry with no purpose code —
-- exactly the entries REQ-005 insists must still be shown.
CREATE VIEW access_log_visible AS
  SELECT id, tenant_id, subject_person_id, at, actor_kind, actor_id,
         actor_display_name, actor_role_label, service_name, purpose_code, action
    FROM audit_log
   WHERE sensitive_read = true
     AND purpose_code IS DISTINCT FROM 'case_handling';

GRANT SELECT ON access_log_visible TO hrms_app;

-- =============================================================================
-- PART 3 — REQ-021 / Q-13: correcting a reason that names somebody else
--
-- The ledger is append-only with UPDATE revoked, so a `reason` naming a third
-- party cannot be edited or redacted. The correction is a NEW row carrying a
-- pointer back at the one it replaces for display. The original is untouched,
-- so no new column grant is needed — which is what makes this better than a
-- `superseded_for_display` flag on the original row.
-- =============================================================================
ALTER TABLE transparency_ledger
  ADD COLUMN supersedes_ledger_id uuid REFERENCES transparency_ledger(id);

-- A chain must not fork: two rows claiming to supersede the same original would
-- render both or neither.
CREATE UNIQUE INDEX ledger_supersedes_unique
  ON transparency_ledger (supersedes_ledger_id)
  WHERE supersedes_ledger_id IS NOT NULL;

GRANT UPDATE (decided_by_name) ON transparency_ledger TO hrms_app;  -- unchanged, restated

-- =============================================================================
-- PART 4 — Correcting a comment that asserts a control nobody built
--
-- Migration 0001 line 79 says `national_id_ref` is "Encrypted at the application
-- layer before it reaches this column (SEC-04)". There is no encryption code
-- anywhere in this product — no encrypt, no decrypt, no key management, in any
-- package — and nothing reads or writes the column, so it is always NULL.
--
-- REQ-002's "shown masked, last 4 characters" was therefore unbuildable: the
-- last four characters of ciphertext are four meaningless characters presented
-- to Aisha as her identity number. The ruling is that national ID is NOT
-- rendered and NOT exported, and the truthful statement today is "not
-- collected" — not "withheld", which would imply we hold it.
--
-- The comment in 0001 is corrected in place (a comment is not schema; re-running
-- 0001 produces an identical database). This puts the correction where the
-- database itself will show it, so `\d+ person` tells the truth too.
-- =============================================================================
COMMENT ON COLUMN person.national_id_ref IS
  'NOT COLLECTED as of feature 002. No code writes this column and no encryption '
  'exists in this product; SEC-04 is unbuilt. Not rendered and not exported '
  '(feature 002 decision log, Q-20). If it is ever populated, SEC-04 needs its '
  'own design first: envelope encryption, key rotation, and a stored non-secret '
  'last-4 if masking is wanted.';

-- =============================================================================
-- PART 5 — Classification (COMP-01, COMP-34, REQ-025)
--
-- Every new personal-data column, before it is written to. CI fails the build
-- otherwise, and that job now applies every migration in order rather than 0001
-- by name — so this file is genuinely exercised.
--
-- Retention: these columns live on `audit_log` rows and share that table's
-- clock. The value is carried explicitly rather than left NULL, because NULL is
-- indistinguishable from "we decided to keep it forever".
-- =============================================================================
INSERT INTO data_classification
  (table_name, column_name, classification, purpose, lawful_basis, retention_days, statutory_ref) VALUES
  ('audit_log','actor_kind','internal',
   'Tell a person whether a HUMAN or a scheduled job read their record (RULE-005)',
   'legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','actor_display_name','identity',
   'Name the viewer in the person''s own access log, and keep naming them after they leave (REQ-020)',
   'legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','actor_role_label','employment',
   'Show the role the viewer held ON THE DAY of the read, not the one they hold now',
   'legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','service_name','internal',
   'Name the scheduled job, so a payroll batch does not read as somebody watching you',
   'legitimate_interest',2555,NULL),
  ('audit_log','purpose_code','employment',
   'The reason beside each entry — the sentence that makes an access log reassuring rather than frightening (RULE-004)',
   'legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('audit_log','subject_person_id','internal',
   'Whose record the read was ABOUT, so "everything about this person" is one query and not a union that a later table falls out of',
   'legal_obligation',2555,'[LAW — VERIFY per market]'),
  ('transparency_ledger','supersedes_ledger_id','employment',
   'Points a corrected entry at the one it replaces for display, so a reason naming a third party can be superseded without editing an append-only row (REQ-021)',
   'employment_legitimate_use',NULL,NULL);

-- =============================================================================
-- DOWN (manual)
--
--   GRANT USAGE ON LANGUAGE plpgsql TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION set_config(text, text, boolean) TO PUBLIC;
--   DROP FUNCTION IF EXISTS begin_tenant_session(uuid, uuid);
--
-- Rolling back re-opens the cross-tenant escalation path. It loses no data.
-- =============================================================================

-- =============================================================================
-- 0002 — `actor_id` / `decided_by` refer to an employment, and the database
--        enforces it.
--
-- Feature: 001-core-hr-foundation (defect fix, not new scope)
-- Requirements: COMP-22, PRIV-10, COMP-53, SEC-02
-- Decision: docs/features/001-core-hr-foundation/99-decision-log.md,
--           "2026-08-26 — actor_id is an employment id, enforced".
--
-- THE DEFECT
-- ----------
-- `audit_log.actor_id`, `analytics_event.actor_id` and
-- `transparency_ledger.decided_by` were plain `uuid` columns with no foreign
-- key. Nothing said WHICH kind of id they held. The application wrote a login
-- account id into them; the erasure orchestrator looked for them with
--
--     WHERE actor_id IN (SELECT id FROM employment WHERE person_id = $1)
--
-- so the two never met. A person who had changed somebody's record stayed named
-- in three stores after their data was erased, and the erasure test passed
-- because it asked the same question the erasing code asked: nothing matched
-- before, nothing matched after, zero equalled zero.
--
-- Compare `transparency_ledger.subject_employment_id`, which has always been
-- `uuid NOT NULL REFERENCES employment(id)`. The subject of a decision was
-- constrained. The decider was not.
--
-- THE FIX
-- -------
-- Every accountability column now carries a COMPOSITE foreign key
-- `(tenant_id, <column>) REFERENCES employment (tenant_id, id)`.
--
-- Composite, not simple, for the reason `ev_manager_same_tenant` is composite:
-- foreign-key checks run with the referencing table's privileges and BYPASS row
-- level security, so a single-column key would happily accept an employment id
-- from ANOTHER tenant. Aisha would then read a ledger entry naming a decider
-- who works at a different company.
--
-- NULL stays legal on the nullable columns, and that is deliberate. A composite
-- foreign key defaults to MATCH SIMPLE: if any column of the key is NULL the
-- constraint is satisfied. `tenant_id` is NOT NULL everywhere, so this means
-- exactly "actor_id may be NULL, but if it is set it must be a real employment
-- in this tenant" — which is what erasure needs, because erasure NULLs the
-- actor link on `audit_log` and `analytics_event` (COMP-22 vs COMP-53, resolved
-- by the column-level grants in 0001).
--
-- REVERSIBILITY
-- -------------
-- Fully reversible. The down path is at the bottom of this file, commented, and
-- drops nothing but the constraints this migration adds. No column is added,
-- dropped or retyped, and no row is rewritten, so rolling back loses no data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pre-flight. Adding a foreign key to a column that already holds values which
-- are not employment ids fails with Postgres' own message, which names the
-- constraint but not the problem. Fail first, with a count and an instruction.
--
-- A fresh database built from 0001 has no rows in these tables, so this is a
-- no-op there. It exists for a database that has already been written to.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  bad_rows bigint := 0;
  n bigint;
  report text := '';
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('audit_log','actor_id'),
      ('analytics_event','actor_id'),
      ('transparency_ledger','decided_by'),
      ('employment_version','decided_by'),
      ('org_unit_version','decided_by'),
      ('legal_hold','placed_by'),
      ('legal_hold','released_by')
    ) AS v(tbl, col)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I t WHERE t.%I IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM employment e
                          WHERE e.id = t.%I AND e.tenant_id = t.tenant_id)',
      t.tbl, t.col, t.col) INTO n;
    IF n > 0 THEN
      bad_rows := bad_rows + n;
      report := report || format(E'\n  %s.%s: %s row(s)', t.tbl, t.col, n);
    END IF;
  END LOOP;

  IF bad_rows > 0 THEN
    RAISE EXCEPTION
      'Migration 0002 cannot run: % row(s) hold an actor id that is not an employment in the same tenant.%',
      bad_rows, report
      USING HINT =
        'Forward fix: map each value to the acting employment (or NULL it on '
        'audit_log/analytics_event, where the column is nullable) before '
        'retrying. transparency_ledger.decided_by and *_version.decided_by are '
        'NOT NULL and UPDATE is revoked, so a bad value there must be corrected '
        'by the owner role, and the correction itself recorded.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- The constraints.
-- -----------------------------------------------------------------------------

-- COMP-53 + COMP-22. "Who did what" is now answerable, and erasable.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_is_employment
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employment (tenant_id, id);

-- The analytics table is not a back door around field-level permissions, and it
-- is not a back door around erasure either.
ALTER TABLE analytics_event
  ADD CONSTRAINT analytics_event_actor_is_employment
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employment (tenant_id, id);

-- docs/07-fairness-and-transparency.md Part 2: the person sees WHO decided.
-- `subject_employment_id` was constrained from day one; `decided_by` was not,
-- which is precisely the asymmetry this fixes.
ALTER TABLE transparency_ledger
  ADD CONSTRAINT ledger_decided_by_is_employment
  FOREIGN KEY (tenant_id, decided_by) REFERENCES employment (tenant_id, id);

-- "The human accountable" (20-requirements.md, employment_version.decided_by).
ALTER TABLE employment_version
  ADD CONSTRAINT ev_decided_by_is_employment
  FOREIGN KEY (tenant_id, decided_by) REFERENCES employment (tenant_id, id);

ALTER TABLE org_unit_version
  ADD CONSTRAINT ouv_decided_by_is_employment
  FOREIGN KEY (tenant_id, decided_by) REFERENCES employment (tenant_id, id);

-- COMP-23. Placing a legal hold suspends someone's erasure right; who did it
-- must be a real, nameable person in this tenant.
ALTER TABLE legal_hold
  ADD CONSTRAINT legal_hold_placed_by_is_employment
  FOREIGN KEY (tenant_id, placed_by) REFERENCES employment (tenant_id, id);
ALTER TABLE legal_hold
  ADD CONSTRAINT legal_hold_released_by_is_employment
  FOREIGN KEY (tenant_id, released_by) REFERENCES employment (tenant_id, id);

-- Erasure NULLs `audit_log.actor_id` and `analytics_event.actor_id`. Postgres
-- needs to find the referencing rows to enforce the key, and it does that with
-- the referenced side; these indexes serve the erasure lookup itself, which
-- scans by actor. `audit_log_actor` already covers audit_log.
CREATE INDEX IF NOT EXISTS analytics_event_actor
  ON analytics_event (tenant_id, actor_id);
CREATE INDEX IF NOT EXISTS ledger_decided_by
  ON transparency_ledger (tenant_id, decided_by);
CREATE INDEX IF NOT EXISTS ev_decided_by
  ON employment_version (tenant_id, decided_by);

-- -----------------------------------------------------------------------------
-- The session variable is renamed for the same reason the columns got keys:
-- `app.actor_id` did not say which kind of id it held.
--
-- `current_actor()` is not referenced by any policy today. It is kept, and kept
-- correct, because the next module that writes a policy will reach for it, and
-- a helper that silently reads a stale variable name is worse than none.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_actor_employment() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_employment_id', true), '')::uuid
$$;
DROP FUNCTION IF EXISTS current_actor();

-- -----------------------------------------------------------------------------
-- DOWN (manual; this project does not auto-generate down migrations)
--
--   ALTER TABLE audit_log            DROP CONSTRAINT audit_log_actor_is_employment;
--   ALTER TABLE analytics_event      DROP CONSTRAINT analytics_event_actor_is_employment;
--   ALTER TABLE transparency_ledger  DROP CONSTRAINT ledger_decided_by_is_employment;
--   ALTER TABLE employment_version   DROP CONSTRAINT ev_decided_by_is_employment;
--   ALTER TABLE org_unit_version     DROP CONSTRAINT ouv_decided_by_is_employment;
--   ALTER TABLE legal_hold           DROP CONSTRAINT legal_hold_placed_by_is_employment;
--   ALTER TABLE legal_hold           DROP CONSTRAINT legal_hold_released_by_is_employment;
--   DROP INDEX IF EXISTS analytics_event_actor;
--   DROP INDEX IF EXISTS ledger_decided_by;
--   DROP INDEX IF EXISTS ev_decided_by;
--   CREATE OR REPLACE FUNCTION current_actor() RETURNS uuid LANGUAGE sql STABLE
--     AS $f$ SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid $f$;
--   DROP FUNCTION IF EXISTS current_actor_employment();
--
-- Rolling back re-opens the erasure gap. It does not lose data.
-- =============================================================================

-- =============================================================================
-- 0004 — The organisation switch (RULE-001, REQ-001, REQ-015, REQ-016)
--
-- Feature: 002-employee-self-service-record-view
-- Decision: 99-decision-log.md, 2026-08-26 — "the record view is a tenant
--           setting, and it is off by default"
--
-- One switch per organisation. OFF by default, and "default" here means
-- ABSENT — a brand-new tenant has no row at all, and no row must behave
-- exactly like `off`. That is the whole point of the table's shape: there is
-- nothing to forget to write, because the safe answer is the absence of data.
--
-- Append-only. A flip inserts a row; it never updates one. The current value is
-- the newest row, and the history is evidence for REQ-015 and for the person's
-- own export (RULE-012).
-- =============================================================================

CREATE TABLE tenant_record_view_setting (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  record_view_enabled boolean NOT NULL,
  -- Who decided, as an employment — the referent settled in migration 0002.
  -- Composite, because a foreign key without a tenant component bypasses RLS.
  changed_by          uuid NOT NULL,
  -- Denormalised for the same reason `transparency_ledger.decided_by_name` is:
  -- the employee notice has to name the decider after that person leaves.
  changed_by_name     text NOT NULL CHECK (length(btrim(changed_by_name)) > 0),
  changed_at          timestamptz NOT NULL DEFAULT now(),
  -- NOT NULL by design, not by oversight. Every other decision about people in
  -- this product carries a reason the person can be shown; a decision about
  -- what an entire workforce may see about itself is not the exception.
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  CONSTRAINT trvs_changed_by_is_employment
    FOREIGN KEY (tenant_id, changed_by) REFERENCES employment (tenant_id, id)
);

-- The resolution query is "newest row for this tenant". Nothing else reads it.
CREATE INDEX trvs_current
  ON tenant_record_view_setting (tenant_id, changed_at DESC);

ALTER TABLE tenant_record_view_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_record_view_setting FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_record_view_setting_tenant_isolation
  ON tenant_record_view_setting
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

GRANT SELECT, INSERT ON tenant_record_view_setting TO hrms_app;
-- Append-only at the storage layer, not by convention in application code.
-- A flip that could be edited afterwards is not evidence of anything.
REVOKE UPDATE, DELETE ON tenant_record_view_setting FROM hrms_app;

-- =============================================================================
-- Classification (COMP-01, COMP-34, REQ-025)
-- =============================================================================
INSERT INTO data_classification
  (table_name, column_name, classification, purpose, lawful_basis, retention_days, statutory_ref) VALUES
  ('tenant_record_view_setting','record_view_enabled','internal',
   'Whether employees in this organisation may open their own record',
   'legitimate_interest',NULL,NULL),
  ('tenant_record_view_setting','changed_by','employment',
   'Accountability for a decision about what a whole workforce may see about itself',
   'employment_legitimate_use',NULL,NULL),
  ('tenant_record_view_setting','changed_by_name','identity',
   'Name the decider in the employee notice, even after that person leaves (REQ-015)',
   'employment_legitimate_use',NULL,NULL),
  ('tenant_record_view_setting','reason','employment',
   'Explain the decision — charter Part 2 requires a logged, in-product decision',
   'employment_legitimate_use',NULL,NULL);

-- =============================================================================
-- DOWN (manual)
--
--   DROP TABLE IF EXISTS tenant_record_view_setting;
--   DELETE FROM data_classification WHERE table_name = 'tenant_record_view_setting';
--
-- Rolling back removes the switch. Every gated endpoint then has no row to read,
-- which resolves to OFF — the safe direction, by construction.
-- =============================================================================

-- =============================================================================
-- 0005 — identity_link: which login is which employee
--
-- Feature: 002-employee-self-service-record-view (slice 3b)
-- Requirements: SEC-01, SEC-02, REQ-016, REQ-022, COMP-01, COMP-34
--
-- Nothing in this product connects an authenticated user to an employee. The
-- domain layer has known who Aisha is since feature 001; it has never known
-- that the person holding a session IS Aisha. This table is that link, and it
-- is the whole of it.
--
-- Additive. The down path at the foot drops one table and its classification
-- rows, and loses nothing else.
-- =============================================================================

CREATE TABLE identity_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  person_id    uuid NOT NULL,

  -- The identity provider's `sub` claim.
  --
  -- This is PERSONAL DATA, not an opaque key, and it is classified as identity
  -- below. It is a stable, unique, lifelong identifier for one natural person;
  -- that it is a meaningless-looking string is exactly what a pseudonymous
  -- identifier is. Treating it as infrastructure would keep it out of the
  -- record of processing, out of the retention schedule, and out of erasure —
  -- and it is the one value that can re-link an erased person to their old
  -- account, which makes it the single worst thing here to leave unerased.
  subject      text NOT NULL CHECK (length(btrim(subject)) > 0),

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- A link is disabled, never deleted: "this login no longer reaches this
  -- person" is a fact somebody may need to prove later. Deleting the row
  -- destroys the only evidence of who could sign in as whom, and when.
  disabled_at  timestamptz,

  -- Composite, with a tenant component. A foreign key without one bypasses row
  -- level security, because FK checks run with the referencing table's
  -- privileges — the rule migration 0002 established after the same omission
  -- let a manager pointer cross tenants.
  CONSTRAINT identity_link_person_same_tenant
    FOREIGN KEY (tenant_id, person_id) REFERENCES person (tenant_id, id),

  -- One subject is one human, product-wide. Enforced globally rather than per
  -- tenant so the same login can never be pointed at two different people in
  -- two different customers — which would be a cross-tenant identity confusion
  -- that no amount of RLS would catch, because both rows would be legitimate
  -- in their own tenant.
  CONSTRAINT identity_link_subject_unique UNIQUE (subject)
);

-- Only ONE live link per subject. A disabled link stays for the audit trail and
-- does not block a new one.
CREATE UNIQUE INDEX identity_link_live_subject
  ON identity_link (subject) WHERE disabled_at IS NULL;

-- The resolution query's access path: tenant from the request host, then subject.
CREATE INDEX identity_link_lookup
  ON identity_link (tenant_id, subject) WHERE disabled_at IS NULL;

CREATE INDEX identity_link_person ON identity_link (tenant_id, person_id);

ALTER TABLE identity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_link FORCE  ROW LEVEL SECURITY;
CREATE POLICY identity_link_tenant_isolation ON identity_link
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

GRANT SELECT ON identity_link TO hrms_app;
-- Provisioning writes these, not the request path. The application reads them.
REVOKE INSERT, UPDATE, DELETE ON identity_link FROM hrms_app;

-- =============================================================================
-- Classification (COMP-01, COMP-34, REQ-025)
-- =============================================================================
INSERT INTO data_classification
  (table_name, column_name, classification, purpose, lawful_basis, retention_days, statutory_ref) VALUES
  ('identity_link','subject','identity',
   'Recognise which employee is signing in. A pseudonymous but stable identifier for one natural person, and the value that could re-link an erased person to their old account',
   'employment_legitimate_use',NULL,'[LAW — VERIFY per market]'),
  ('identity_link','person_id','internal',
   'Link a login to the employee it belongs to',
   'employment_legitimate_use',NULL,NULL),
  ('identity_link','disabled_at','internal',
   'When this login stopped reaching this person — kept as evidence rather than deleted',
   'employment_legitimate_use',NULL,NULL);

-- =============================================================================
-- DOWN (manual)
--
--   DROP TABLE IF EXISTS identity_link;
--   DELETE FROM data_classification WHERE table_name = 'identity_link';
--
-- Rolling back leaves the product with no way to tell which login is which
-- employee. It loses no employee data.
-- =============================================================================

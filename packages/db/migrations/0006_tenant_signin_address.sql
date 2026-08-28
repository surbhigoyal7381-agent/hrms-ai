-- =============================================================================
-- 0006 — The sign-in address, and why it is READABLE
--
-- Feature: 002-employee-self-service-record-view (slice 3c)
-- Requirements: REQ-031, SEC-01, SEC-02
-- Decision:    Q-19, RESOLVED by the human on 2026-08-28
--              (docs/features/002-.../99-decision-log.md)
--
-- Sign-in has to be tenant-specific. REQ-031 depends on it: the closed-window
-- page renders THAT tenant's data-protection contact to every caller, which is
-- only safe because the caller already chose the address. `resolveRequestContext`
-- depends on it too — the tenant is taken from the request, and the subject is
-- resolved within it, so another customer's subject resolves to nothing.
--
-- An EARLIER VERSION OF THIS FILE shipped an opaque 32-hex-character slug, on
-- the argument that a readable address lets anyone confirm whether a company is
-- a customer. That argument was put to the human twice and OVERRULED on
-- 2026-08-28. The address is readable: `northwind.<product>.app`.
--
-- The trade was accepted with its consequence understood and written down: a
-- readable address is enumerable, by guessing from a company list and — the
-- route that needs nothing from us at all — through Certificate Transparency,
-- where every publicly-trusted certificate is published within minutes. No
-- employee's personal data is exposed by an enumerable address; whether the
-- customer list is commercially sensitive is a business judgement, and it was
-- made. Two mitigations that preserve readable addresses were offered and NOT
-- taken now: one wildcard certificate instead of one per tenant, and a uniform
-- pre-authentication response. Both are recorded in the decision log.
--
-- Nothing about tenant isolation rests on the address being unguessable. The
-- address selects which tenant a request is resolved against; it grants
-- nothing. Row-level security, the permissions model, the tenant setting and
-- the audit trail are unchanged by this file.
-- =============================================================================

-- Added nullable, backfilled, then constrained. A NOT NULL column with a
-- DEFAULT would have been one statement, and it would have been wrong: every
-- existing tenant would silently receive an address nobody chose, and so would
-- every tenant created afterwards. There is no safe default for a name.
ALTER TABLE tenant ADD COLUMN signin_slug text;

-- -----------------------------------------------------------------------------
-- Backfill: derive a readable label from the tenant's name.
--
-- Run once, here, for tenants that already exist. Provisioning sets the slug
-- explicitly for every tenant created after this migration — the column has no
-- DEFAULT precisely so that a missing slug is a loud failure at provisioning
-- time rather than a surprising address discovered by a customer.
-- -----------------------------------------------------------------------------
WITH derived AS (
  SELECT
    t.id,
    -- "Northwind Trading Co." -> "northwind-trading-co"
    btrim(regexp_replace(lower(t.name), '[^a-z0-9]+', '-', 'g'), '-') AS base
  FROM tenant t
),
labelled AS (
  SELECT
    d.id,
    -- A name of only punctuation derives to an empty string. Fall back to
    -- something that is at least a valid label rather than writing '' and
    -- failing the CHECK below with a message about the constraint instead of
    -- about the name.
    CASE WHEN length(d.base) BETWEEN 3 AND 40 THEN d.base
         ELSE 'tenant-' || left(d.id::text, 8)
    END AS label
  FROM derived d
),
-- Two customers can genuinely share a derived label ("Acme Ltd", "ACME!"), and
-- the UNIQUE constraint below would then fail the whole migration. Disambiguate
-- the later ones rather than refusing to migrate.
ranked AS (
  SELECT l.id, l.label,
         row_number() OVER (PARTITION BY l.label ORDER BY l.id) AS n
  FROM labelled l
)
UPDATE tenant t
   SET signin_slug = CASE WHEN r.n = 1 THEN r.label
                          ELSE r.label || '-' || left(t.id::text, 6)
                     END
  FROM ranked r
 WHERE r.id = t.id;

ALTER TABLE tenant ALTER COLUMN signin_slug SET NOT NULL;

-- -----------------------------------------------------------------------------
-- What a sign-in address is allowed to be.
--
-- This is a DNS label, so it must be one: lowercase letters, digits and
-- hyphens, starting and ending alphanumeric, 3 to 62 characters. Enforced as a
-- CHECK rather than as a convention in provisioning code, because a slug that
-- is not a legal DNS label produces an address that cannot be issued a
-- certificate — a failure that surfaces at the customer, not at the commit.
--
-- Uppercase is refused rather than folded. Host names are case-insensitive, so
-- storing `Northwind` and `northwind` as two rows would be two tenants sharing
-- one address, and the UNIQUE constraint would not see it.
-- -----------------------------------------------------------------------------
ALTER TABLE tenant
  ADD CONSTRAINT tenant_signin_slug_is_a_label
  CHECK (signin_slug ~ '^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$');

-- Labels the product needs for itself. A tenant called "API" taking `api.…`
-- would shadow our own address space, and the failure would look like an
-- outage rather than a naming collision.
ALTER TABLE tenant
  ADD CONSTRAINT tenant_signin_slug_not_reserved
  CHECK (signin_slug NOT IN (
    'www', 'api', 'app', 'admin', 'auth', 'login', 'signin', 'sso',
    'mail', 'smtp', 'static', 'assets', 'cdn', 'status', 'support',
    'help', 'docs', 'blog', 'test', 'staging', 'internal'
  ));

ALTER TABLE tenant
  ADD CONSTRAINT tenant_signin_slug_unique UNIQUE (signin_slug);

-- -----------------------------------------------------------------------------
-- Resolving the address is a chicken-and-egg problem, and this is the one place
-- it is solved.
--
-- `tenant` is itself row-level-secured with `USING (id = current_tenant())`, so
-- reading it requires already knowing the tenant — which is exactly what an
-- arriving request does not know. A SECURITY DEFINER function is the narrow way
-- through: it returns ONE uuid for an exact label match, and nothing else. No
-- name, no region, no row, no listing, and no way to ask it anything but "does
-- this exact string correspond to a tenant".
--
-- That narrowness still matters after Q-19. The decision accepted that the
-- address space is enumerable from the outside; it did not license this
-- function to become a customer-list endpoint from the inside. An application
-- role compromised through an injection defect can ask it one yes/no question
-- at a time and learns no name.
--
-- Marked STABLE and given a fixed search_path — a SECURITY DEFINER function
-- that resolves unqualified names through the caller's search_path is the
-- classic privilege-escalation shape.
--
-- `lower(...)` on the argument, because host names are case-insensitive and an
-- employee who types `Northwind.<product>.app` is at the right address. Storage
-- is already lowercase by CHECK, so this folds the input and not the column,
-- and the unique index on `signin_slug` is still usable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_id_for_signin_slug(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id FROM public.tenant t WHERE t.signin_slug = lower(btrim(p_slug))
$$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_signin_slug(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION tenant_id_for_signin_slug(text) TO hrms_app;

-- No new grant is needed and none is given. Migration 0001 already revokes
-- INSERT, UPDATE and DELETE on `tenant` from `hrms_app`, and adding a column
-- does not re-grant them — so a compromised application role cannot re-point a
-- customer's sign-in address at itself. Checked in `information_schema` by the
-- test rather than assumed from reading 0001.

-- No `data_classification` row: `signin_slug` describes a customer
-- organisation, not a natural person. The COMP-34 gate scopes itself to tables
-- carrying a `tenant_id` column and `tenant` has `id`, so this is a deliberate
-- scope statement rather than an exemption slipped past a check.

-- =============================================================================
-- DOWN (manual)
--
--   DROP FUNCTION IF EXISTS tenant_id_for_signin_slug(text);
--   ALTER TABLE tenant DROP CONSTRAINT tenant_signin_slug_unique;
--   ALTER TABLE tenant DROP CONSTRAINT tenant_signin_slug_not_reserved;
--   ALTER TABLE tenant DROP CONSTRAINT tenant_signin_slug_is_a_label;
--   ALTER TABLE tenant DROP COLUMN signin_slug;
--
-- Rolling back removes every tenant's sign-in address, so every link already
-- sent to an employee stops working. Re-running the forward migration derives
-- addresses from tenant names again — which, unlike the opaque slug this file
-- replaced, means a re-run reproduces the SAME address for an unchanged name.
-- A tenant whose address was set by provisioning to something other than the
-- derived label does NOT get it back; that value exists only in the dropped
-- column. Take a copy of (id, signin_slug) before rolling back.
-- =============================================================================

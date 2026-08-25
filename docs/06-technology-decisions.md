# Technology Decisions — locked

**Status: DECIDED.** This supersedes the PROPOSED notice previously in `CLAUDE.md` §7.
**Deployment model: multi-tenant SaaS, EU + India regions.**

Selection criteria, in priority order:

1. **Genuinely open source**, with a permissive or low-risk licence
2. **Popular and maintained** enough to hire for and depend on for a decade
3. **Low data-privacy risk** — no phone-home by default, no forced third-party egress, no lock-in that routes employee data through someone else's cloud
4. **Boring.** Complexity must buy something nameable

Every licence and telemetry claim below was verified against primary sources (LICENSE files, vendor docs, npm registry metadata) in **August 2026**, with sources at the end. **Licences change** — Unleash's changed ten weeks before this was written. Re-verify before a major version bump.

---

## The stack

| Layer | Choice | Licence | Why this one |
|---|---|---|---|
| Language | TypeScript on Node 22 LTS | Apache-2.0 / MIT | One language across web, API and jobs. Large hiring pool. |
| Monorepo | pnpm workspaces + Turborepo | MIT | Strict dependency isolation; no phantom deps. |
| Web | Next.js (App Router) | MIT | **Telemetry is ON by default — we disable it.** See §Telemetry kill list. |
| UI | Tailwind CSS + Radix UI + shadcn/ui | MIT (all three) | shadcn is vendored source, not a dependency — no supply-chain surface, but we own maintenance. |
| Database | **PostgreSQL** | PostgreSQL Licence | Permissive, no vendor, no relicensing history, and Row-Level Security is core built-in. |
| ORM | **Drizzle** | Apache-2.0 (`drizzle-orm`), MIT (`drizzle-kit`) | SQL-first, no proprietary query engine, and **first-class RLS support** via `pgPolicy`/`pgRole`. |
| Jobs / queue | **pg-boss** on the same Postgres | MIT | Transactional enqueue — the job and the business write commit together. **No Redis needed.** |
| Cache | **None in v1** | — | Add only when a measured problem exists. If needed: **Valkey**, never Redis 8. |
| Object storage | S3-compatible, region-pinned | — | Payslips and ID documents. Self-host fallback: SeaweedFS (Apache-2.0). |
| Identity | **Keycloak** | Apache-2.0 | CNCF Incubating. Mature OIDC + SAML. **SCIM is experimental — we build our own.** |
| Authorization | Postgres RLS (tenant) + policy functions in `packages/core` | — | Structural isolation first. Escalate to Cerbos only when attribute policies genuinely hurt. |
| Search | Postgres full-text | PostgreSQL Licence | OpenSearch (Apache-2.0, Linux Foundation) when FTS stops being enough. |
| Observability | **OpenTelemetry** SDK + Prometheus | Apache-2.0 (both) | OTel is CNCF **Graduated**. Instrumenting with OTel — not a vendor SDK — is what keeps the backend swappable. |
| Product analytics | **First-party event store in Postgres** | — | See §The analytics decision. No third-party analytics SDK in the employee app. |
| Feature flags | DB-backed, behind an OpenFeature interface | Apache-2.0 | See §The feature-flag decision. |
| Testing | Vitest, Playwright, axe-core, k6 | MIT, Apache-2.0, MPL-2.0, AGPL-3.0 | axe-core and k6 are **CI-only** — never in the production image. |
| CI | GitHub Actions | — | Already where the repo lives. |
| AI | Hosted API behind our own gateway | — | See §The AI decision — this is the one place we accepted higher privacy risk. |

## Rejected, and why — this is the useful part

**MinIO.** Entered maintenance mode December 2025 — no new features, no accepted PRs, security fixes case-by-case. The web console was stripped from the community edition in February 2025 and moved to the paid product. A dead dependency holding your customers' payslips is not a position to be in.

**Redis 8.** Relicensed 1 May 2025 to a tri-licence: RSALv2 *or* SSPLv1 *or* AGPLv3, your choice. RSALv2 explicitly forbids offering the software as a service. Valkey is BSD-3-Clause under Linux Foundation governance, backed by AWS, Google Cloud, Oracle and others — it removes the question entirely rather than making you answer it. We need neither in v1.

**Prisma.** Apache-2.0 and genuinely good, but three strikes for us: the CLI phones home by default; Prisma Accelerate is a data proxy that routes queries through Prisma's cloud and is not self-hostable (fatal for a region-pinned tenant if anyone ever enables it); and RLS support is weaker than Drizzle's. Drizzle's `pgPolicy` maps directly onto the isolation model we need.

**Zitadel.** Relicensed Apache-2.0 → AGPL-3.0 in March 2025 (v3.0). Better multi-tenant B2B ergonomics than Keycloak, genuinely — but on a licence-risk basis, Apache-2.0 beats AGPL for something this deep in the stack. Revisit if Keycloak's tenancy model becomes the bottleneck.

**PostHog self-hosted.** PostHog's own documentation says the self-hosted open-source build is "made for hobbyists", that self-hosted customers "cannot receive commercial support", that it is "unlikely to scale past a couple 100ks events without significant effort", and that Kubernetes/Helm support was sunset in February 2023 with self-hosted licences no longer sold. Self-hosted instances also send usage reports — including geographic data — to PostHog by default. The supported path is PostHog Cloud, which means third-party egress of employee behavioural data. **For an HRMS that is the wrong trade.**

**Unleash 8.x.** Silently relicensed from Apache-2.0 to AGPL-3.0-or-later around June 2026 — the 7.x line stayed Apache-2.0, 8.x is AGPL. We could not find an official announcement, which is itself the lesson: verify licences from the LICENSE file at the version you pin, not from a blog post or from memory. It also phones home by default (two separate switches). Feature flags are not hard enough to import this risk.

**Grafana embedded in the product.** Grafana, Loki and Tempo are AGPLv3 (relicensed April 2021). Running them unmodified as internal ops tooling is one situation; **embedding Grafana dashboards in the customer-facing HRMS UI is a materially different one**, because you are then offering AGPL software to remote users. Internal only. Decide deliberately, not by accident.

**SigNoz.** MIT core, but everything under `ee/` is proprietary and production use of anything in it requires a subscription. "MIT with an `ee/` directory" is not MIT, and the boundary is a directory rather than a visible feature flag. Same pattern as PostHog. Avoidable, so avoided.

## The analytics decision

**We do not put a third-party analytics SDK in the employee-facing application.**

Every mainstream product-analytics tool works by shipping behavioural events about identifiable people to a vendor's cloud. In a consumer app that is a routine disclosure. In an HRMS it means employee behaviour — when Aisha logs in, which policy she read, how long she hesitated on the resignation screen — leaving the tenant's boundary to a US-based processor. That is a sub-processor relationship, a cross-border transfer, and a conversation with every enterprise buyer's security team.

Instead: `packages/core` emits domain events to a **first-party `analytics_event` table** in the tenant's own database, region-pinned like everything else, subject to the same retention clocks and the same erasure propagation. Product questions get answered with SQL. When we outgrow that, the destination changes — the emission code does not.

This costs us some convenience. It buys us an honest answer to "where does our employee data go?" that fits in one sentence.

## The feature-flag decision

Flags live in a Postgres table, read through an **OpenFeature** (Apache-2.0, CNCF) interface. If we later want Unleash or another provider, we swap the OpenFeature provider — not the call sites. Given Unleash 8.x's relicensing, starting behind the vendor-neutral interface is worth the small extra effort.

## The AI decision — where we accepted more risk, deliberately

**Chosen: hosted model API under a DPA with no-training terms.** This is the one place the stack trades privacy risk for capability, and it should be recorded as a decision rather than a drift.

**What it costs us, stated plainly:**

- Every call is a **cross-border transfer** and a **sub-processor relationship** that must be disclosed (`COMP-04`, `COMP-41`)
- A tenant that requires strict region-pinning **cannot use AI features** unless the provider offers in-region inference — verify per region, do not assume
- Contractual no-training terms are a contract, not a technical control. They are only as good as the counterparty.

**The mitigations are not optional — they are the design:**

All model access goes through **one gateway** in `packages/ai`. Nothing else in the codebase may call a model API directly, and CI fails if it does.

The gateway enforces, in order:

1. **Classification gate** — reads the field classification metadata. Fields marked `identity`, `financial`, `health` or `biometric` are refused or redacted before the prompt is built. This is a code path, not a guideline.
2. **Minimisation** — strip identity where the task does not need it. Summarising feedback themes does not need names.
3. **Per-tenant opt-in** — AI is off until a tenant's administrator turns it on, having seen exactly what leaves and to whom (`PRIV-06`).
4. **Per-tenant, per-feature kill switch** (`COMP-79`, `AI-13`).
5. **Full call logging** — inputs, outputs, model and prompt version, and the human decider (`COMP-76`).
6. **Injection defence** — employee-authored text is passed as data, never concatenated into a system prompt (`AI-03`).
7. **A swappable adapter.** The gateway interface is provider-agnostic. Moving to self-hosted open-weight inference later must be a configuration change and an adapter, not a rewrite. **Design for that day now** — it is cheap now and expensive later.

**Non-negotiable regardless of provider:** no AI-only adverse decision about a person (`AI-02`), and any AI touching recruitment, selection, performance, task allocation, monitoring, promotion or termination carries the full high-risk obligation set (`COMP-70`–`COMP-79`).

## Telemetry kill list

Several of these are on by default and almost nobody turns them off. Set them in the **Dockerfile and CI configuration**, not on a developer's laptop.

```bash
# Next.js — build/dev-time telemetry, on by default
NEXT_TELEMETRY_DISABLED=1

# Prisma CLI — only if Prisma is ever introduced
CHECKPOINT_DISABLE=1

# k6 — load testing, usage reports on by default
K6_NO_USAGE_REPORT=1

# Cerbos — only if adopted; telemetry on by default
CERBOS_NO_TELEMETRY=1

# Broad opt-out honoured by several tools
DO_NOT_TRACK=1
```

If Grafana, Loki or Tempo are ever run internally, each has its **own separate** switch — `analytics.reporting_enabled` in Grafana and Loki, a `usage-report` block in Tempo — and Grafana additionally polls GitHub and grafana.com for updates every ten minutes by default. Three switches, not one.

**Verify this list on every dependency addition.** A tool that phones home from inside an HRMS deployment is a finding, not a nuisance.

## The two traps to brief every engineer on

**1. Postgres RLS is bypassed by the table owner.** `ENABLE ROW LEVEL SECURITY` does not apply to the role that owns the table, and application connections very often run as the owner. This is the single most common multi-tenant isolation bug in exactly this architecture. **We use `FORCE ROW LEVEL SECURITY` on every tenant-scoped table**, and there is a test that creates two tenants and tries to read across them.

**2. Drizzle Studio serves its UI from a Drizzle-controlled domain** (`local.drizzle.studio`) and its own docs say it is meant for local development, not remote. **Never point it at production or at any database containing real employee data.**

## What must be re-verified before you rely on it

Stated honestly, because a confident wrong answer here is expensive:

- **Unleash's relicensing** was confirmed from npm per-version metadata and the repo LICENSE, but no official announcement was found. Verify at the version you pin.
- **Keycloak telemetry** — no phone-home was found in its documentation, but there is no explicit vendor statement that it collects nothing. Absence of evidence.
- **OpenSearch telemetry** — not investigated. Check before deploying.
- **Every AGPL §13 judgement** in this document (Redis, Zitadel, Grafana, Unleash, Garage) is a **legal question, not a factual one.** What is written here is what the licences say. Get counsel before relying on "internal use is fine."
- Prometheus, Vitest, Tailwind, Radix, shadcn and Drizzle telemetry — none found, but no vendor "we collect nothing" statement located either.

## Sources

Licences verified from LICENSE files: [Next.js](https://raw.githubusercontent.com/vercel/next.js/canary/license.md) · [PostgreSQL](https://www.postgresql.org/about/licence/) · [Valkey](https://raw.githubusercontent.com/valkey-io/valkey/unstable/COPYING) · [Redis](https://raw.githubusercontent.com/redis/redis/unstable/LICENSE.txt) · [pg-boss](https://raw.githubusercontent.com/timgit/pg-boss/master/LICENSE) · [Keycloak](https://raw.githubusercontent.com/keycloak/keycloak/main/LICENSE.txt) · [Zitadel](https://raw.githubusercontent.com/zitadel/zitadel/main/LICENSE) · [OpenFGA](https://raw.githubusercontent.com/openfga/openfga/main/LICENSE) · [Cerbos](https://raw.githubusercontent.com/cerbos/cerbos/main/LICENSE) · [SigNoz ee/](https://raw.githubusercontent.com/SigNoz/signoz/develop/ee/LICENSE) · [PostHog ee/](https://raw.githubusercontent.com/PostHog/posthog/master/ee/LICENSE) · [OpenSearch](https://raw.githubusercontent.com/opensearch-project/OpenSearch/main/LICENSE.txt) · [k6](https://raw.githubusercontent.com/grafana/k6/master/LICENSE.md) · [Unleash](https://raw.githubusercontent.com/Unleash/unleash/main/LICENSE) · [SeaweedFS](https://raw.githubusercontent.com/seaweedfs/seaweedfs/master/LICENSE)

Behaviour and policy: [Next.js telemetry](https://nextjs.org/telemetry) · [Prisma CLI telemetry](https://www.prisma.io/docs/orm/v6/tools/prisma-cli) · [Prisma Accelerate self-hosting](https://github.com/prisma/prisma/issues/19551) · [Drizzle RLS](https://orm.drizzle.team/docs/rls) · [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) · [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) · [Redis AGPLv3](https://redis.io/blog/agplv3/) · [Valkey launch](https://www.linuxfoundation.org/press/linux-foundation-launches-open-source-valkey-community) · [Keycloak SCIM experimental](https://www.keycloak.org/2026/04/scim-as-experimental-feature) · [Zitadel relicensing](https://zitadel.com/blog/apache-to-agpl) · [Cerbos telemetry](https://docs.cerbos.dev/cerbos/latest/configuration/telemetry.html) · [Grafana/Loki/Tempo AGPLv3](https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/) · [Loki usage stats](https://grafana.com/docs/loki/latest/configure/usage-statistics/) · [SigNoz telemetry](https://signoz.io/docs/telemetry/) · [PostHog egress](https://posthog.com/docs/privacy/egress) · [PostHog self-host disclaimer](https://posthog.com/docs/self-host/open-source/disclaimer) · [PostHog sunsetting Helm](https://posthog.com/blog/sunsetting-helm-support-posthog) · [k6 usage collection](https://grafana.com/docs/k6/latest/set-up/usage-collection/) · [Unleash data & privacy](https://docs.getunleash.io/privacy-and-compliance/data-privacy) · [CNCF: OpenTelemetry](https://www.cncf.io/projects/opentelemetry/) · [CNCF: Keycloak](https://www.cncf.io/projects/keycloak/) · [CNCF: OpenFGA](https://www.cncf.io/projects/openfga/) · [OpenSearch Software Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-opensearch-software-foundation-to-foster-open-collaboration-in-search-and-analytics)

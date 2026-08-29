import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { freshDatabase, adminPool, seedTenant, type SeededTenant } from './setup.js';
import { withTenantForResolution } from '../src/db.js';
import { readAccessLogResponse, resolveAccessLogWindowDays } from '../src/access-log-response.js';
import { buildConfidentialPanel } from '../src/confidential-panel.js';

/**
 * REQ-007 / RULE-010 — the standing panel, and REQ-020 — the viewer who left.
 *
 * The single most important assertion in this file is the byte-identity of the
 * panel between somebody WITH suppressed entries and somebody with NONE, and the
 * single most important thing about that assertion is the GUARD in front of it.
 *
 * Without the guard, the test compares two people who both have nothing
 * suppressed, finds them identical, and passes forever while proving nothing.
 * That is the design note's own point 2, and it is the third time this shape of
 * vacuous assertion has been caught in this product.
 */

const DB = 'hrms_access_log_response_test';
const TZ = 'Asia/Kolkata';

let app: pg.Pool;
let admin: pg.Pool;
let t: SeededTenant;

/** Rohan — the person WITH suppressed entries. */
let rohanPersonId: string;
let rohanEmploymentId: string;

async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [t.tenantId]);
    return await fn(c);
  } finally {
    c.release();
  }
}

/** One sensitive-read audit row, written as the owner. */
async function seedRead(c: pg.PoolClient, o: {
  subjectPersonId: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  purpose: string | null;
  at: string;
  action?: string;
  kind?: 'human' | 'system';
  service?: string | null;
}): Promise<void> {
  await c.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, actor_kind, actor_display_name, actor_role_label,
        service_name, action, resource_type, resource_id, subject_person_id,
        purpose_code, at, sensitive_read)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'employment',NULL,$8,$9::access_purpose_code,$10,true)`,
    [t.tenantId, o.actorId, o.kind ?? 'human', o.actorName, o.actorRole,
     o.service ?? null, o.action ?? 'record.viewed', o.subjectPersonId,
     o.purpose, o.at]);
}

const recent = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  t = await seedTenant(admin, { name: 'Northwind', region: 'in' });

  await asOwner(async (c) => {
    // Rohan, a second employee in the same tenant. He is the respondent in a
    // grievance: a case handler has opened his record, and those reads are
    // suppressed. Aisha has nothing suppressed. Neither must be able to tell
    // which of them is which.
    const p = await c.query(
      `INSERT INTO person (tenant_id, legal_name, preferred_name)
       VALUES ($1,'Rohan Mehta','Rohan') RETURNING id`, [t.tenantId]);
    rohanPersonId = p.rows[0].id;
    const e = await c.query(
      `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
       VALUES ($1,$2,'E-9001','2021-02-01','active') RETURNING id`,
      [t.tenantId, rohanPersonId]);
    rohanEmploymentId = e.rows[0].id;

    // Aisha: three ordinary human reads, nothing suppressed.
    await seedRead(c, { subjectPersonId: t.personId, actorId: t.hrEmploymentId,
      actorName: 'Meera Nair', actorRole: 'HR Business Partner',
      purpose: 'pay_review', at: recent(12) });
    await seedRead(c, { subjectPersonId: t.personId, actorId: t.hrEmploymentId,
      actorName: 'Meera Nair', actorRole: 'HR Business Partner',
      purpose: 'pay_review', at: recent(12) });
    await seedRead(c, { subjectPersonId: t.personId, actorId: null,
      actorName: null, actorRole: null, kind: 'system', service: 'payroll-run',
      purpose: 'payroll_run', at: recent(9) });

    // Rohan: two ordinary reads AND two suppressed case-handling reads.
    await seedRead(c, { subjectPersonId: rohanPersonId, actorId: t.hrEmploymentId,
      actorName: 'Meera Nair', actorRole: 'HR Business Partner',
      purpose: 'pay_review', at: recent(12) });
    await seedRead(c, { subjectPersonId: rohanPersonId, actorId: null,
      actorName: null, actorRole: null, kind: 'system', service: 'payroll-run',
      purpose: 'payroll_run', at: recent(9) });
    await seedRead(c, { subjectPersonId: rohanPersonId, actorId: t.hrEmploymentId,
      actorName: 'Anita Rao', actorRole: 'Case Investigator',
      purpose: 'case_handling', action: 'case.record_reviewed', at: recent(5) });
    await seedRead(c, { subjectPersonId: rohanPersonId, actorId: t.hrEmploymentId,
      actorName: 'Anita Rao', actorRole: 'Case Investigator',
      purpose: 'case_handling', action: 'case.record_reviewed', at: recent(4) });
  });
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

const TENANT = { market: 'in', dpoName: null, dpoEmail: null };

const responseFor = (personId: string) =>
  withTenantForResolution(app, t.tenantId, (tx) =>
    readAccessLogResponse(tx, TENANT, { subjectPersonId: personId, timezone: TZ }));

// ---------------------------------------------------------------------------
// THE ASSERTION THIS SLICE EXISTS FOR
// ---------------------------------------------------------------------------

describe('RULE-010 — the panel is identical whether or not anything is suppressed', () => {
  it('GUARD: the suppressed fixture genuinely has suppressed rows', async () => {
    // Checked through the OWNER role, against the TABLE, bypassing
    // `access_log_visible` — the very view whose job is to hide these rows. If
    // this were asserted through the read path it would return zero by design
    // and confirm nothing.
    //
    // Everything below is worthless without this. Two people who both have
    // nothing suppressed produce identical panels trivially, and the suite goes
    // green over a comparison of two empty states.
    const suppressed = await asOwner((c) => c.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE subject_person_id = $1 AND purpose_code = 'case_handling'`,
      [rohanPersonId]));
    expect(suppressed.rows[0].n, 'Rohan has NO suppressed rows — the comparison below is vacuous')
      .toBeGreaterThan(0);

    const aishaSuppressed = await asOwner((c) => c.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE subject_person_id = $1 AND purpose_code = 'case_handling'`,
      [t.personId]));
    expect(aishaSuppressed.rows[0].n, 'Aisha has suppressed rows — she is the control')
      .toBe(0);

    // And the suppression genuinely takes effect: the read path must not see
    // them. Otherwise the panel could be identical while the entries leaked.
    const visible = await withTenantForResolution(app, t.tenantId, (tx) =>
      tx.query(`SELECT count(*)::int AS n FROM access_log_visible
                 WHERE subject_person_id = $1 AND purpose_code = 'case_handling'`,
        [rohanPersonId]));
    expect(visible.rows[0].n, 'a case_handling row reached the read path').toBe(0);
  });

  it('renders a byte-identical panel for Rohan and for Aisha', async () => {
    const aisha = await responseFor(t.personId);
    const rohan = await responseFor(rohanPersonId);

    // Byte-for-byte, on the serialised panel — not a field-by-field comparison,
    // which would silently skip a field somebody adds later.
    expect(JSON.stringify(rohan.panel)).toBe(JSON.stringify(aisha.panel));
    expect(Buffer.byteLength(JSON.stringify(rohan.panel)))
      .toBe(Buffer.byteLength(JSON.stringify(aisha.panel)));

    // Same key ORDER too. A panel serialised with its keys in a different order
    // is a different byte sequence on the wire even when the values match.
    expect(Object.keys(rohan.panel)).toEqual(Object.keys(aisha.panel));
  });

  it('keeps the panel in the same position in the payload for both', async () => {
    // RULE-010 fixes the panel's position so its offset cannot vary with the
    // number of entries. In the payload that means it is the FIRST key, before
    // anything whose length depends on the person.
    const aisha = await responseFor(t.personId);
    const rohan = await responseFor(rohanPersonId);
    expect(Object.keys(aisha)[0]).toBe('panel');
    expect(Object.keys(rohan)[0]).toBe('panel');

    const prefix = (o: unknown) => JSON.stringify(o).indexOf('"page"');
    expect(prefix(rohan)).toBe(prefix(aisha));
  });

  it('does not leak suppression through the entries or the count bucket', async () => {
    // The panel being identical is not enough on its own. Rohan has 4 rows of
    // which 2 are suppressed; Aisha has 3 of which 0 are. Both must land in the
    // same bucket, and neither may see a case-handling entry.
    const aisha = await responseFor(t.personId);
    const rohan = await responseFor(rohanPersonId);

    expect(rohan.page.entries.some((e) => e.action.startsWith('case.'))).toBe(false);
    expect(JSON.stringify(rohan.page)).not.toContain('Anita Rao');
    expect(JSON.stringify(rohan.page)).not.toContain('case_handling');

    // Both are small logs, so both bucket to '1-5'. Asserted as a business fact
    // rather than derived from the entry counts the code produced.
    expect(rohan.page.countBucket).toBe('1-5');
    expect(aisha.page.countBucket).toBe('1-5');
  });

  it('does not let a suppressed read inflate a grouped count', async () => {
    // RULE-006 + RULE-010's ordering trap. Meera opened Rohan's record once and
    // Anita opened it twice on other days. If suppression ran AFTER grouping,
    // a "3 times" could survive as "1 time" on the wrong line, or a count could
    // be computed over rows that were then removed.
    const rohan = await responseFor(rohanPersonId);
    for (const entry of rohan.page.entries) {
      expect(entry.actorName).not.toBe('Anita Rao');
      expect(entry.times).toBeLessThanOrEqual(1);
    }
  });

  it('shows the panel to somebody with NO entries at all', async () => {
    // RULE-010's third row. A person with an empty log still gets the panel —
    // otherwise "no entries" and "nothing suppressed" would look different.
    const empty = await asOwner(async (c) => {
      const p = await c.query(
        `INSERT INTO person (tenant_id, legal_name) VALUES ($1,'Nobody Yet') RETURNING id`,
        [t.tenantId]);
      return p.rows[0].id as string;
    });

    const response = await responseFor(empty);
    expect(response.page.entries).toEqual([]);
    expect(response.page.countBucket).toBe('0');

    const aisha = await responseFor(t.personId);
    expect(JSON.stringify(response.panel)).toBe(JSON.stringify(aisha.panel));
  });
});

describe('REQ-020 — the viewer has left, or been erased', () => {
  it('names the viewer from the value captured AT THE TIME OF THE READ', async () => {
    const aisha = await responseFor(t.personId);
    const meera = aisha.page.entries.find((e) => e.actorName === 'Meera Nair');

    expect(meera, 'the captured name did not reach the response').toBeDefined();
    expect(meera!.kind).toBe('human');
    // The role she held on the day of the read, not whatever she holds now.
    expect(meera!.actorRoleLabel).toBe('HR Business Partner');
    expect(meera!.purposeText).toContain('pay review');
    // Two reads on the same day, same actor, same purpose — one line (RULE-006).
    expect(meera!.times).toBe(2);
  });

  it('still names her after her employment ends', async () => {
    // Nothing in the read path joins to `employment` for the name, so exiting
    // cannot change what the entry says. Asserted by actually exiting her.
    await asOwner((c) => c.query(
      `UPDATE employment SET status = 'exited', exit_date = current_date
        WHERE id = $1`, [t.hrEmploymentId]));

    const aisha = await responseFor(t.personId);
    const meera = aisha.page.entries.find((e) => e.actorName === 'Meera Nair');
    expect(meera, 'the entry lost its name when the viewer left').toBeDefined();
    expect(meera!.actorRoleLabel).toBe('HR Business Partner');
    expect(meera!.kind).toBe('human');

    await asOwner((c) => c.query(
      `UPDATE employment SET status = 'active', exit_date = NULL WHERE id = $1`,
      [t.hrEmploymentId]));
  });

  it('reads as "Former employee" with the role after erasure, NEVER as a system read', async () => {
    // The most damaging false sentence this screen can produce is "no person
    // read your record" when one did. Erasure NULLs `actor_id` and
    // pseudonymises `actor_display_name`; `actor_kind` and `actor_role_label`
    // are immutable, which is what keeps the entry readable as a sentence.
    await asOwner((c) => c.query(
      `UPDATE audit_log SET actor_display_name = 'Former employee', actor_id = NULL
        WHERE subject_person_id = $1 AND actor_display_name = 'Meera Nair'`,
      [t.personId]));

    // GUARD: the row really is in the erased shape now — a NULL actor id with a
    // pseudonymised name. Without this the assertions below could be passing
    // over rows the UPDATE never touched.
    const shape = await asOwner((c) => c.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE subject_person_id = $1 AND actor_id IS NULL
          AND actor_display_name = 'Former employee' AND actor_kind = 'human'`,
      [t.personId]));
    expect(shape.rows[0].n, 'no row is in the erased shape — this test proves nothing')
      .toBeGreaterThan(0);

    const aisha = await responseFor(t.personId);
    const erased = aisha.page.entries.find((e) => e.actorName === 'Former employee');

    expect(erased, 'the erased viewer vanished from the log').toBeDefined();
    // THE assertion. A NULL actor id must not be read as "a computer did it".
    expect(erased!.kind, 'an erased HUMAN viewer was reclassified as a system read')
      .toBe('human');
    expect(erased!.serviceName).toBeNull();
    // The role survives, so the sentence still reads
    // "Former employee, HR Business Partner — opened your record on ...".
    expect(erased!.actorRoleLabel).toBe('HR Business Partner');
    expect(erased!.purposeText).toContain('pay review');

    // Positive control, so "kind === human" is not satisfied by a function that
    // returns 'human' for everything: the payroll job in the same page is still
    // a system read.
    const system = aisha.page.entries.find((e) => e.serviceName === 'payroll-run');
    expect(system, 'the system fixture is missing — the control is vacuous').toBeDefined();
    expect(system!.kind).toBe('system');
    expect(system!.actorName).toBeNull();
  });

  it('shows an unattributable entry as an unnamed HUMAN read', async () => {
    // A legacy row with no captured name. RULE-005: a missing actor is never a
    // system read. It renders with `access.unknown_actor` and the "Ask about
    // this" route — but it stays in the human section.
    await asOwner((c) => c.query(
      `INSERT INTO audit_log
         (tenant_id, actor_id, actor_kind, actor_display_name, action,
          resource_type, subject_person_id, at, sensitive_read)
       VALUES ($1, NULL, 'human', 'Recorded before names were captured',
               'record.viewed', 'employment', $2, $3, true)`,
      [t.tenantId, t.personId, recent(3)]));

    const aisha = await responseFor(t.personId);
    const legacy = aisha.page.entries.find(
      (e) => e.actorName === 'Recorded before names were captured');

    expect(legacy).toBeDefined();
    expect(legacy!.kind).toBe('human');
    expect(legacy!.serviceName).toBeNull();
    // No purpose code was recorded, so RULE-004's fallback applies and the
    // entry is STILL shown — `IS DISTINCT FROM` in the view is what keeps it.
    expect(legacy!.purposeMissing).toBe(true);
  });
});

describe('RULE-007 — the window the screen may honestly claim', () => {
  it('is the shorter of the display window and the actual audit retention', async () => {
    const resolved = await withTenantForResolution(app, t.tenantId, (tx) =>
      resolveAccessLogWindowDays(tx, 365));

    // Independent oracle: read the retention from `data_classification` with a
    // separate query rather than trusting the function's own answer.
    const retention = await asOwner((c) => c.query(
      `SELECT min(retention_days)::int AS n FROM data_classification
        WHERE table_name = 'audit_log' AND retention_days IS NOT NULL`));
    const retentionDays: number = retention.rows[0].n;

    expect(retentionDays).toBeGreaterThan(0);
    expect(resolved.retentionDays).toBe(retentionDays);
    expect(resolved.windowDays).toBe(Math.min(365, retentionDays));
    expect(resolved.limitedByRetention).toBe(retentionDays < 365);
  });

  it('shortens the window when retention is shorter than the display setting', async () => {
    // The boundary RULE-007 names: a market whose audit retention is 180 days
    // must not be shown a heading that promises 12 months. Asserted by asking
    // for a display window LONGER than retention.
    const resolved = await withTenantForResolution(app, t.tenantId, (tx) =>
      resolveAccessLogWindowDays(tx, 99_999));
    expect(resolved.limitedByRetention).toBe(true);
    expect(resolved.windowDays).toBe(resolved.retentionDays);
  });

  it('reports the window it actually applied on the response', async () => {
    const response = await responseFor(t.personId);
    expect(response.window.days).toBeGreaterThan(0);
    expect(response.window.startAt).toBe(response.page.windowStartAt);
    // No total is computed anywhere — REQ-019. A count field would be the
    // easiest thing in the world to add and the hardest to notice.
    expect(JSON.stringify(response)).not.toMatch(/"total"|"totalCount"|"entryCount"/);
  });
});

describe('the panel is built from tenant facts and nothing else', () => {
  it('is identical for two different people given the same tenant input', () => {
    // The pure function, exercised directly. There is no argument through which
    // a person could reach it — this asserts the consequence.
    const a = buildConfidentialPanel({ market: 'in', dpoName: null, dpoEmail: null });
    const b = buildConfidentialPanel({ market: 'in', dpoName: null, dpoEmail: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('falls back to the default set for an unrecognised market, never to no panel', () => {
    // Fail closed here means RENDER, which is the opposite direction from every
    // other fail-closed rule in this feature.
    for (const market of ['zz', '', 'EU', null, '   ']) {
      const panel = buildConfidentialPanel({ market, dpoName: null, dpoEmail: null });
      expect(panel.marketResolved, `market ${JSON.stringify(market)}`).toBe('default');
      expect(panel.strings.heading).toBe('Not everything is listed here');
      expect(panel.strings.body.length).toBeGreaterThan(0);
      expect(panel.strings.invariant.length).toBeGreaterThan(0);
      expect(panel.strings.action.length).toBeGreaterThan(0);
    }
  });

  it('reports an unconfigured data-protection contact instead of hiding the panel', () => {
    const unconfigured = buildConfidentialPanel({ market: 'in', dpoName: null, dpoEmail: null });
    expect(unconfigured.dpoConfigured).toBe(false);
    expect(unconfigured.strings.action).toContain('{dpo_name}');

    const configured = buildConfidentialPanel({
      market: 'in', dpoName: 'Priya Nair', dpoEmail: 'dpo@northwind.example',
    });
    expect(configured.dpoConfigured).toBe(true);
    expect(configured.params).toEqual({
      dpo_name: 'Priya Nair', dpo_email: 'dpo@northwind.example',
    });
  });

  it('carries the Q-02 legal status in the payload', () => {
    // So nobody ships these believing counsel has seen them.
    const panel = buildConfidentialPanel({ market: 'in', dpoName: null, dpoEmail: null });
    expect(panel.legalStatus).toBe('DRAFTED_NOT_LEGALLY_APPROVED');
  });

  it('uses the exact wording from the requirements document', async () => {
    // Independent oracle against transcription drift. The strings are counsel's
    // to write and mine only to copy; a panel whose wording has quietly changed
    // is not the artefact that gets signed off.
    const fs = await import('node:fs/promises');
    const doc = await fs.readFile(
      new URL('../../../docs/features/002-employee-self-service-record-view/20-requirements.md',
        import.meta.url), 'utf8');

    const panel = buildConfidentialPanel({ market: 'in', dpoName: null, dpoEmail: null });
    const keys: Array<[keyof typeof panel.strings, string]> = [
      ['heading', 'access.confidential_panel.heading'],
      ['body', 'access.confidential_panel.body'],
      ['invariant', 'access.confidential_panel.invariant'],
      ['action', 'access.confidential_panel.action'],
    ];

    for (const [field, key] of keys) {
      const row = doc.split('\n').find((l) => l.includes('`' + key + '`'));
      expect(row, `${key} is not in the requirements document`).toBeDefined();
      const expected = row!.split('|')[2]!.trim().replace(/^`|`$/g, '');
      expect(panel.strings[field], `${key} has drifted from the requirements`).toBe(expected);
    }
  });
});

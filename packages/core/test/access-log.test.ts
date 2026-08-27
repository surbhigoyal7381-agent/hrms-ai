import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenant } from '../src/db.js';
import { readAccessLog } from '../src/access-log.js';

/**
 * REQ-005 / REQ-006 / RULE-006 / RULE-010 — the access log read model.
 *
 * Every fixture below is written through the OWNER role, and every assertion is
 * checked against what this file inserted — never re-read through the query
 * under test. Where a test asserts something is absent, it first asserts the
 * thing exists in the table, so "absent" cannot mean "was never there".
 */
const DB = 'hrms_access_log_test';
let app: pg.Pool;
let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
/** Meera the HRBP — the viewer whose reads Aisha sees. */
let meeraEmp: string;
const IST = 'Asia/Kolkata';

/** Inserts one audit row exactly as a read path would, as the owner. */
async function seedRead(opts: {
  at: string;
  actorEmploymentId: string | null;
  actorName: string | null;
  roleLabel?: string | null;
  kind?: 'human' | 'system';
  serviceName?: string | null;
  purpose?: string | null;
  action?: string;
  subjectPersonId?: string;
}) {
  const c = await admin.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    await c.query(
      `INSERT INTO audit_log
         (tenant_id, actor_id, actor_kind, actor_display_name, actor_role_label,
          service_name, action, resource_type, resource_id, subject_person_id,
          purpose_code, sensitive_read, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'person',$8,$8,$9::access_purpose_code,true,$10::timestamptz)`,
      [
        A.tenantId,
        opts.actorEmploymentId,
        opts.kind ?? 'human',
        opts.actorName,
        opts.roleLabel ?? 'HR Business Partner',
        opts.serviceName ?? null,
        opts.action ?? 'person.read_sensitive',
        opts.subjectPersonId ?? A.personId,
        opts.purpose ?? null,
        opts.at,
      ],
    );
  } finally {
    c.release();
  }
}

const actor = () => ({ tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId });

const read = (over: Partial<Parameters<typeof readAccessLog>[1]> = {}) =>
  withTenant(app, actor(), (tx) =>
    readAccessLog(tx, {
      subjectPersonId: A.personId, timezone: IST, windowDays: 3650, ...over,
    }));

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Northwind', region: 'eu' });

  const c = await admin.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
  const mp = await c.query(
    `INSERT INTO person (tenant_id, legal_name) VALUES ($1,'Meera Nair') RETURNING id`,
    [A.tenantId]);
  const me = await c.query(
    `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
     VALUES ($1,$2,'E-9001','2020-02-01','active') RETURNING id`, [A.tenantId, mp.rows[0].id]);
  meeraEmp = me.rows[0].id;
  await c.query(
    `INSERT INTO employment_version (tenant_id, employment_id, valid_from, org_unit_id,
       job_title, employment_type, decided_by, reason)
     VALUES ($1,$2,'2020-02-01',$3,'HR Business Partner','full_time',$4,'Initial hire')`,
    [A.tenantId, meeraEmp, A.orgUnitId, A.hrEmploymentId]);
  c.release();
}, 60_000);

afterAll(async () => { await app?.end(); await admin?.end(); });

describe('RULE-010 — suppressed entries are filtered BEFORE grouping', () => {
  it('a confidential read never appears, and never changes another line count', async () => {
    // Meera opens Aisha's record five times on 14 August: THREE for the pay
    // review, TWO as a case handler. The two orderings give different answers:
    //
    //   filter -> group  (correct):  one line, "3 times", casework absent
    //   group  -> filter (wrong)  :  the casework GROUP is rendered, which
    //                                announces that a confidential process
    //                                touched this person
    //   grouping that ignores purpose, filtering after: one line, "5 times" —
    //                                a count Aisha cannot reconcile, which is
    //                                the leak in its quietest form
    for (const at of ['2026-08-14T04:00:00Z', '2026-08-14T04:30:00Z', '2026-08-14T09:10:00Z']) {
      await seedRead({ at, actorEmploymentId: meeraEmp, actorName: 'Meera Nair',
        purpose: 'pay_review' });
    }
    for (const at of ['2026-08-14T05:00:00Z', '2026-08-14T06:00:00Z']) {
      await seedRead({ at, actorEmploymentId: meeraEmp, actorName: 'Meera Nair',
        purpose: 'case_handling', action: 'person.read_sensitive' });
    }

    // Independent oracle: the rows really are in the table, in both flavours.
    // Without this the assertions below could pass on an empty fixture.
    const c = await admin.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    const raw = await c.query(
      `SELECT purpose_code::text AS p, count(*)::int AS n FROM audit_log
        WHERE subject_person_id = $1 AND actor_id = $2
        GROUP BY 1 ORDER BY 1`, [A.personId, meeraEmp]);
    c.release();
    expect(raw.rows).toEqual([
      { p: 'case_handling', n: 2 },
      { p: 'pay_review', n: 3 },
    ]);

    const page = await read();
    const meera = page.entries.filter((e) => e.actorName === 'Meera Nair');

    expect(meera, 'the pay-review reads collapsed to one line').toHaveLength(1);
    expect(meera[0]!.times, 'count must exclude the suppressed reads').toBe(3);
    expect(meera[0]!.purposeText).toBe('annual pay review');

    // ...and no line anywhere describes casework.
    expect(
      page.entries.some((e) => e.purposeText === 'confidential casework'),
      'a suppressed entry was rendered',
    ).toBe(false);
  });
});

describe('RULE-004 — an entry with no purpose is SHOWN, never dropped', () => {
  it('survives the suppression filter (IS DISTINCT FROM, not <>)', async () => {
    // `purpose_code <> 'case_handling'` is NULL for a NULL purpose, and NULL is
    // not true, so the plain comparison silently deletes every purpose-less
    // entry from the log. REQ-005 says the entry is still shown, because a log
    // with silent exclusions is not a log.
    await seedRead({ at: '2026-07-01T05:00:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: null, action: 'person.read_sensitive' });
    await seedRead({ at: '2026-07-02T05:00:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: null, action: 'goal.read' });

    const c = await admin.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    const raw = await c.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE subject_person_id = $1 AND purpose_code IS NULL`, [A.personId]);
    c.release();
    expect(raw.rows[0].n, 'fixture: there should be purpose-less rows').toBe(2);

    const page = await read();

    // A known action still yields a sentence, from RULE-004's fallback table.
    const known = page.entries.find((e) => e.localDay === '2026-07-01');
    expect(known, 'the purpose-less entry vanished').toBeDefined();
    expect(known!.purposeText).toBe('looking at your details');
    expect(known!.purposeMissing).toBe(false);

    // An action nobody mapped is STILL shown, flagged for the alert.
    const unknown = page.entries.find((e) => e.localDay === '2026-07-02');
    expect(unknown, 'the unmapped entry vanished').toBeDefined();
    expect(unknown!.purposeMissing).toBe(true);
    expect(unknown!.purposeText).toBeNull();
    expect(unknown!.action).toBe('goal.read');
  });
});

describe('RULE-005 — a missing actor is never a system read', () => {
  it('an ERASED viewer still reads as a human, named "Former employee"', async () => {
    // erasure.ts sets actor_id = NULL and pseudonymises the captured name. If
    // the renderer inferred "system" from the null id, Aisha would be told that
    // no person read her record when one did.
    await seedRead({ at: '2026-06-10T05:00:00Z', actorEmploymentId: null,
      actorName: 'Former employee', roleLabel: 'HR Business Partner',
      kind: 'human', purpose: 'pay_review' });

    const page = await read();
    const entry = page.entries.find((e) => e.localDay === '2026-06-10');
    expect(entry, 'the erased viewer entry vanished').toBeDefined();
    expect(entry!.kind, 'an erased human read was reclassified as a system read').toBe('human');
    expect(entry!.actorName).toBe('Former employee');
    expect(entry!.actorRoleLabel, 'the role must survive so the line reads as a sentence')
      .toBe('HR Business Partner');
    expect(entry!.isSelf).toBe(false);
  });

  it('a real system read IS classified as a system read', async () => {
    // Positive control. Without it the assertion above passes for an
    // implementation that hard-codes every entry to "human".
    await seedRead({ at: '2026-06-11T20:44:00Z', actorEmploymentId: null, actorName: null,
      kind: 'system', serviceName: 'payroll-runner', purpose: 'payroll_run',
      action: 'payroll.run_read' });

    const page = await read();
    const entry = page.entries.find((e) => e.serviceName === 'payroll-runner');
    expect(entry, 'the system read vanished').toBeDefined();
    expect(entry!.kind).toBe('system');
    expect(entry!.purposeText).toBe('payroll run');
  });
});

describe('RULE-006 — grouping is by the EMPLOYEE calendar day', () => {
  it('a read at 23:58 IST and one at 00:03 IST are two days, not one', async () => {
    // 18:28Z is 23:58 IST on the 20th; 18:33Z is 00:03 IST on the 21st.
    // Splitting on UTC would file the evening read under the previous day and
    // show a read as happening before it did (REL-08).
    await seedRead({ at: '2026-05-20T18:28:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: 'onboarding' });
    await seedRead({ at: '2026-05-20T18:33:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: 'onboarding' });

    const page = await read();
    const days = page.entries
      .filter((e) => e.purposeText === 'setting up your record')
      .map((e) => e.localDay).sort();
    expect(days, 'the IST midnight boundary was not honoured').toEqual(['2026-05-20', '2026-05-21']);
  });

  it('the subject reading their own record shows as "you", not hidden', async () => {
    await seedRead({ at: '2026-04-02T06:00:00Z', actorEmploymentId: A.employmentId,
      actorName: 'Aisha Kumar', roleLabel: 'Engineer', purpose: 'employee_request',
      action: 'record.viewed_own' });
    const page = await read();
    const own = page.entries.find((e) => e.localDay === '2026-04-02');
    expect(own, 'the subject own read was excluded').toBeDefined();
    expect(own!.isSelf, 'own read not marked as self').toBe(true);
  });
});

describe('REQ-019 / SCALE-02 — paging without ever computing a total', () => {
  it('pages by cursor, and never reports how many there are', async () => {
    // 30 distinct days by one actor -> 30 groups, which is more than one page.
    for (let d = 1; d <= 30; d++) {
      const day = String(d).padStart(2, '0');
      await seedRead({ at: `2026-03-${day}T06:00:00Z`, actorEmploymentId: meeraEmp,
        actorName: 'Meera Nair', purpose: 'support' });
    }

    const first = await read({ pageSize: 25 });
    expect(first.entries.length).toBeLessThanOrEqual(25);
    expect(first.nextCursor, 'there should be a further page').not.toBeNull();
    // Bucketed, never exact — a payload that moved by one entry could be
    // differenced across two loads to reveal a suppressed read.
    expect(first.countBucket).toBe('25+');
    expect(Object.keys(first)).not.toContain('total');

    const second = await read({ pageSize: 25, cursor: first.nextCursor });
    expect(second.entries.length, 'the second page is empty').toBeGreaterThan(0);

    // Keyset paging must not repeat a row across pages.
    const firstDays = new Set(first.entries.map((e) => `${e.localDay}|${e.purposeText}`));
    const overlap = second.entries.filter((e) => firstDays.has(`${e.localDay}|${e.purposeText}`));
    expect(overlap, 'a cursor page repeated entries from the previous page').toEqual([]);

    // Ordering is newest first, across the page boundary.
    const firstLast = first.entries[first.entries.length - 1]!.lastAt;
    expect(second.entries[0]!.lastAt < firstLast).toBe(true);
  });

  it('the query plan is bounded by the subject index, not a full scan', async () => {
    // SCALE-02 asserted on the PLAN, not on a row count: a test that only
    // checks the rows would pass on a sequential scan of a seven-year log.
    const plan = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `EXPLAIN (FORMAT JSON)
         SELECT count(*) FROM access_log_visible
          WHERE subject_person_id = $1 AND at >= now() - interval '365 days'`,
        [A.personId]);
      return JSON.stringify(r.rows[0]);
    });
    expect(plan, 'the access-log query is not using the subject index').toContain(
      'audit_log_subject_at');
  });
});

describe('RULE-006 — the grouping key includes the PURPOSE', () => {
  it('the same person, the same day, two purposes = two lines', async () => {
    // RULE-006's boundary case, and the one that catches a "simplification" of
    // the grouping key to (actor, day). Merging across purposes hides a
    // purpose, and the purpose is the whole reason an entry reads as reassuring
    // rather than frightening.
    //
    // This test was added because a mutation that dropped `purpose` from the
    // GROUP BY passed every other test in this file. It is here because it
    // failed to be here.
    await seedRead({ at: '2026-02-05T04:00:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: 'pay_review' });
    await seedRead({ at: '2026-02-05T11:00:00Z', actorEmploymentId: meeraEmp,
      actorName: 'Meera Nair', purpose: 'record_correction' });

    // A wide page, because this file has seeded later days that would otherwise
    // fill page one. The assertion is about grouping, not about paging.
    const page = await read({ pageSize: 200 });
    const sameDay = page.entries.filter((e) => e.localDay === '2026-02-05');

    expect(sameDay, 'two purposes on one day were collapsed into one line').toHaveLength(2);
    expect(sameDay.map((e) => e.purposeText).sort())
      .toEqual(['annual pay review', 'correcting your record']);
    // Each is a single read, so neither line claims a repeat.
    expect(sameDay.every((e) => e.times === 1), 'a merged group inflated the count').toBe(true);
  });
});

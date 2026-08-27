/**
 * Erasure orchestrator — REQ-010, COMP-22, PRIV-10.
 *
 * Built in Core HR even though Core HR writes to few stores, because its real
 * job is to make the NEXT module's erasure gap visible. Leave, Payroll and
 * Engagement will each add stores; with no orchestrator to register against,
 * each one silently becomes a store nobody erases.
 *
 * A delete that leaves the row in the search index is not a delete.
 */
import type { Tx, Actor } from './db.js';
import { writeAudit } from './audit.js';

export type ErasureMode =
  /** Row is removed entirely. */
  | 'delete'
  /** Row survives; identifying columns are replaced. Used where a record must
   *  remain for audit or for the other party's rights. */
  | 'minimise';

/**
 * The predicate every actor-linked store erases by.
 *
 * It was always written this way. Until migration 0002 it matched nothing,
 * because the columns held login account ids rather than employment ids and
 * nothing constrained them — so erasure silently did no work and the test that
 * checked it asked this same question and also got nothing. The columns now
 * carry a composite foreign key into `employment (tenant_id, id)`, so this
 * predicate means what it reads as.
 *
 * Tests must NOT re-use this constant. An assertion that shares the eraser's own
 * predicate compares zero to zero. Assert against the employment id you seeded.
 */
const ACTED_BY_PERSON = `IN (SELECT id FROM employment WHERE person_id = $1)`;

export interface StoreEraser {
  store: string;
  mode: ErasureMode;
  /** Why this store cannot simply be deleted. Required for 'minimise'. */
  justification?: string;
  erase(tx: Tx, personId: string): Promise<number>;
}

export interface ErasureResult {
  personId: string;
  perStore: { store: string; mode: ErasureMode; rowsAffected: number }[];
  heldByLegalHold: boolean;
  holdReason: string | null;
}

/**
 * Every store Core HR writes to. Adding a store without adding it here is the
 * failure mode this registry exists to prevent — the test asserts each store
 * independently rather than trusting a success return.
 */
export const CORE_HR_STORES: StoreEraser[] = [
  {
    store: 'analytics_event',
    mode: 'minimise',
    justification:
      'Aggregate product metrics must survive, but the actor link must not.',
    async erase(tx, personId) {
      const r = await tx.query(
        `UPDATE analytics_event SET actor_id = NULL
          WHERE actor_id ${ACTED_BY_PERSON}`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
  {
    store: 'transparency_ledger',
    mode: 'minimise',
    justification:
      'The ledger is append-only and cannot be deleted by the application. ' +
      'Entries about OTHER people that name this person as the decider must ' +
      'survive as evidence for those people, so the name is replaced rather ' +
      'than the row removed. [LAW — VERIFY: confirm pseudonymisation is ' +
      'sufficient here in each market.]',
    async erase(tx, personId) {
      const r = await tx.query(
        `UPDATE transparency_ledger SET decided_by_name = 'Former employee'
          WHERE decided_by ${ACTED_BY_PERSON}`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
  {
    store: 'audit_log',
    mode: 'minimise',
    justification:
      'Retained under a statutory record-keeping obligation. Payload is already ' +
      'PII-redacted (PRIV-07). The actor link is removed AND the viewer name ' +
      'captured at read time is pseudonymised (REQ-020), through the narrow ' +
      'column grants on those two columns only. actor_kind and actor_role_label ' +
      'survive, so the entry still reads as a sentence: "Former employee, ' +
      'Engineering Manager - opened your record on 14 August". ' +
      '[LAW — VERIFY retention.]',
    async erase(tx, personId) {
      // BOTH columns in ONE statement, deliberately.
      //
      // These were briefly two registered stores, and the second could never
      // match: the first had already set `actor_id = NULL`, so the predicate
      // that finds "rows this person viewed" found nothing, and the captured
      // name survived erasure. The regression test caught it because it asserts
      // the NAME is gone, not just the id — an erasure ordering bug is invisible
      // to a test that only checks the column erased first.
      //
      // One statement cannot be reordered into being wrong.
      const r = await tx.query(
        `UPDATE audit_log
            SET actor_id = NULL,
                actor_display_name = 'Former employee'
          WHERE actor_id ${ACTED_BY_PERSON}`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
  {
    store: 'employment_version',
    mode: 'minimise',
    justification:
      'DELETE is revoked at the database role level (RULE-001: history is never ' +
      'hard-deleted). The version chain carries no direct identifiers; erasure ' +
      'of the person record breaks the link.',
    async erase(tx, personId) {
      const r = await tx.query(
        `UPDATE employment_version SET reason = '[erased]'
          WHERE employment_id IN (SELECT id FROM employment WHERE person_id = $1)`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
  {
    store: 'employment',
    mode: 'minimise',
    justification:
      'Employment dates are retained for statutory filing (COMP-32 minimisation). ' +
      'Identifying columns are cleared.',
    async erase(tx, personId) {
      const r = await tx.query(
        `UPDATE employment SET work_email = NULL WHERE person_id = $1`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
  {
    store: 'person',
    mode: 'minimise',
    justification:
      'The row survives so employment history stays referentially intact; every ' +
      'identifying column is cleared.',
    async erase(tx, personId) {
      const r = await tx.query(
        `UPDATE person SET
           legal_name = '[erased]', preferred_name = NULL, pronouns = NULL,
           date_of_birth = NULL, personal_email = NULL, personal_phone = NULL,
           emergency_contact = NULL, profile_photo_url = NULL,
           national_id_ref = NULL, updated_at = now()
         WHERE id = $1`,
        [personId],
      );
      return r.rowCount ?? 0;
    },
  },
];

/**
 * COMP-23 — a legal hold overrides erasure, is auditable, and the person is
 * told a hold exists where the law permits.
 */
export async function hasLegalHold(
  tx: Tx,
  personId: string,
): Promise<{ held: boolean; reason: string | null }> {
  // Reads the legal_hold table. Employment status is NOT a legal hold: an
  // ex-employee under litigation hold is `exited`, and someone serving notice is
  // not under hold at all. Conflating them destroys evidence in one direction
  // and blocks the wrong people in the other.
  const r = await tx.query(
    `SELECT reason FROM legal_hold
      WHERE person_id = $1 AND released_at IS NULL
      LIMIT 1`,
    [personId],
  );
  return { held: (r.rowCount ?? 0) > 0, reason: r.rows[0]?.reason ?? null };
}

export async function erasePerson(
  tx: Tx,
  actor: Actor,
  personId: string,
  stores: StoreEraser[] = CORE_HR_STORES,
): Promise<ErasureResult> {
  const hold = await hasLegalHold(tx, personId);
  if (hold.held) {
    return { personId, perStore: [], heldByLegalHold: true, holdReason: hold.reason };
  }
  const perStore: ErasureResult['perStore'] = [];
  // Order matters: dependants before the person row, so the subselects still
  // resolve.
  for (const s of stores) {
    const rowsAffected = await s.erase(tx, personId);
    perStore.push({ store: s.store, mode: s.mode, rowsAffected });
  }
  // COMP-22 + COMP-53: the most consequential write in the system must itself be
  // evidenced. Written LAST so it survives the person-row minimisation, and it
  // carries no PII — only counts.
  //
  // ...but writing it last re-links the actor AFTER the audit_log eraser has
  // run. If the actor is the person being erased — a self-service erasure —
  // that single row would put their employment id straight back into a store we
  // had just cleared. So a self-service erasure records a NULL actor and says in
  // the payload that it was self-service. Nothing is lost: the resource_id
  // already identifies whose erasure this was.
  const selfService = await isOwnEmployment(tx, actor.actorEmploymentId, personId);
  if (selfService) {
    // A self-service erasure must not re-link the person into a store we have
    // just cleared. `actor_kind` still says `human` — RULE-005: a missing actor
    // id is NEVER a system read, because telling somebody no person touched
    // their record when one did is the worst thing this log can say.
    await tx.query(
      `INSERT INTO audit_log
         (tenant_id, actor_id, actor_kind, actor_display_name,
          action, resource_type, resource_id, subject_person_id, purpose_code, after_data)
       VALUES ($1, NULL, 'human', 'Former employee',
               'person.erased','person',$2,$2,'employee_request',$3::jsonb)`,
      [actor.tenantId, personId, JSON.stringify({ perStore, selfService })],
    );
  } else {
    await writeAudit(tx, actor, {
      action: 'person.erased',
      resourceType: 'person',
      resourceId: personId,
      subjectPersonId: personId,
      purpose: 'employee_request',
      after: { perStore, selfService },
    });
  }

  return { personId, perStore, heldByLegalHold: false, holdReason: null };
}

/** Is the acting employment one of the erased person's own employments? */
async function isOwnEmployment(
  tx: Tx,
  actorEmploymentId: string,
  personId: string,
): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM employment WHERE id = $1 AND person_id = $2`,
    [actorEmploymentId, personId],
  );
  return (r.rowCount ?? 0) > 0;
}

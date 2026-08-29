/**
 * The standing confidential-access panel — REQ-007, RULE-010, PRIV-08.
 *
 * Shown to EVERYONE, on EVERY access log, whether or not anything is actually
 * suppressed. That is the whole requirement, and the natural implementation —
 * show a notice when something is suppressed — IS the leak.
 *
 * Rohan is the respondent in a grievance. He opens his access log, sees a panel
 * he has never seen before, and now knows an investigator has opened his file.
 * He can guess who complained. The suppression worked and the feature leaked
 * anyway.
 *
 * THIS FUNCTION CANNOT VARY WITH THE PERSON, AND YOU CAN SEE THAT FROM ITS
 * SIGNATURE.
 *
 * `PanelInput` carries three tenant-level values and nothing else. No entry
 * count, no `hasSuppressed`, no person id, no entries array. A reviewer does not
 * have to read the body to know the panel cannot differ between two employees of
 * the same organisation — there is no argument through which it could. That is
 * the design-note rule "the panel is not passed any data", enforced by the type
 * rather than by care.
 *
 * The same argument is why this file has no database access. A function that
 * could query could query something about the caller.
 */

/** Exactly the four strings REQ-007 names, in the order it names them. */
export interface PanelStrings {
  heading: string;
  body: string;
  invariant: string;
  action: string;
}

/**
 * The default set — `access.confidential_panel.*` from the microcopy section.
 *
 * DRAFTED, NOT LEGALLY APPROVED. Q-02 is open: counsel must sign these off per
 * market, and each translation separately, before they reach a live tenant. The
 * BEHAVIOUR is not blocked by that, which is why this ships now; the WORDING is.
 *
 * Copied verbatim from `20-requirements.md`. There is a test that parses the
 * requirements document and asserts these are character-for-character identical,
 * because a panel whose wording has quietly drifted from the approved text is
 * exactly the artefact counsel signed off on and we did not ship.
 */
const DEFAULT_STRINGS: PanelStrings = Object.freeze({
  heading: 'Not everything is listed here',
  body:
    "One kind of access is never shown in anyone's record: confidential casework. " +
    'If someone raises a concern, the people looking into it are not listed. ' +
    'That protects the person who raised it.',
  invariant:
    "This note appears on everyone's record, every time. It does not tell you " +
    'whether anything has been left out of yours.',
  action:
    'To get a copy of your record, use Download my data. If you have a question ' +
    'about your data, contact {dpo_name} at {dpo_email}.',
});

/**
 * Per-market string sets.
 *
 * Every market currently resolves to the default, because RULE-010 records
 * India, EU and UK as "not confident — uses the default until counsel reviews
 * it". The map exists so that adding a reviewed market is a content change and
 * not a code change (Q-02), and so the fail-closed path below is exercised today
 * rather than written and never run.
 */
const MARKET_STRINGS: Readonly<Record<string, PanelStrings>> = Object.freeze({
  default: DEFAULT_STRINGS,
});

export type PanelLegalStatus = 'DRAFTED_NOT_LEGALLY_APPROVED';

export interface PanelInput {
  /** The tenant's market, e.g. 'in' or 'eu'. Unrecognised resolves to default. */
  market: string | null;
  /** The tenant's published data-protection contact, or null if unconfigured. */
  dpoName: string | null;
  dpoEmail: string | null;
}

export interface ConfidentialPanel {
  /**
   * The four strings, as TEMPLATES, with `{dpo_name}` and `{dpo_email}` left in
   * place for the renderer to substitute from `params`.
   *
   * Returned unsubstituted on purpose. The alternative — interpolating here —
   * would mean inventing replacement wording when the contact is unconfigured,
   * and RULE-010's strings are counsel's to write, not mine. Leaving the
   * template intact and reporting `dpoConfigured: false` keeps the alert honest
   * without putting words in anybody's mouth.
   */
  strings: PanelStrings;
  /** Tenant-level substitutions. Never person-level — that is the invariant. */
  params: { dpo_name: string | null; dpo_email: string | null };
  /** Which set was used. `default` today for every market. */
  marketResolved: string;
  /** Q-02. Carried in the payload so nobody ships these believing they are signed off. */
  legalStatus: PanelLegalStatus;
  /**
   * False when the tenant has no published contact.
   *
   * The caller ALERTS on this (`dpo.unconfigured`) and still renders the panel.
   * A blank contact panel is a compliance failure wearing a UI gap, and a
   * missing panel is the leak — so neither absence is allowed to remove it.
   */
  dpoConfigured: boolean;
}

/**
 * Builds the panel. Deterministic, and identical for every employee of a tenant.
 *
 * FAIL CLOSED MEANS *RENDER*, which is the opposite direction from every other
 * fail-closed rule in this feature, and it is worth saying out loud because the
 * instinct on a missed lookup is to render nothing. An unrecognised market
 * resolves to the default set. It never resolves to no panel.
 */
export function buildConfidentialPanel(input: PanelInput): ConfidentialPanel {
  const key = typeof input.market === 'string' ? input.market.trim().toLowerCase() : '';
  const strings = MARKET_STRINGS[key] ?? MARKET_STRINGS.default!;

  const dpoName = nonEmpty(input.dpoName);
  const dpoEmail = nonEmpty(input.dpoEmail);

  return {
    strings,
    params: { dpo_name: dpoName, dpo_email: dpoEmail },
    marketResolved: MARKET_STRINGS[key] ? key : 'default',
    legalStatus: 'DRAFTED_NOT_LEGALLY_APPROVED',
    dpoConfigured: dpoName !== null && dpoEmail !== null,
  };
}

function nonEmpty(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

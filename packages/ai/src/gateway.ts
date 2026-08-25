/**
 * THE AI GATEWAY — the only place in this codebase that may call a model API.
 *
 * Rationale and the accepted trade-off: docs/06-technology-decisions.md
 * §The AI decision. We chose a hosted model API under a DPA with no-training
 * terms. That is a deliberate trade of privacy risk for capability, and these
 * controls ARE the design — not a checklist bolted on afterwards.
 *
 * CI fails if any file outside this package imports a model SDK or calls a
 * model endpoint. See .github/workflows/ci.yml → "ai-gateway-boundary".
 *
 * Core HR (feature 001) uses NO AI. This module exists so that the first
 * feature which does cannot take a shortcut around it.
 */

export class AiRefusedError extends Error {
  readonly code = 'AI_REFUSED';
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'AiRefusedError';
  }
}

/** Matches data_classification.classification in the database (COMP-01). */
export type Classification =
  | 'identity' | 'financial' | 'health' | 'biometric'
  | 'employment' | 'internal' | 'ugc';

/**
 * Classifications that must NEVER reach a third-party model.
 * This is a code path, not a guideline (PRIV-06, COMP-41, AI-11).
 */
const NEVER_SEND: ReadonlySet<Classification> = new Set([
  'identity', 'financial', 'health', 'biometric',
]);

export interface Field {
  name: string;
  value: string;
  classification: Classification;
}

export interface TenantAiPolicy {
  /** Off until an administrator opts in, having seen what leaves and to whom (PRIV-06). */
  enabled: boolean;
  /** Per-feature kill switch — flip in minutes when a jurisdiction changes position (COMP-79, AI-13). */
  enabledFeatures: ReadonlySet<string>;
  /** A strictly region-pinned tenant may not be able to use AI at all (COMP-43). */
  region: 'eu' | 'in';
  providerRegions: ReadonlySet<string>;
}

/**
 * High-risk under the EU AI Act Annex III and several US state AEDT laws.
 * Classify by EFFECT on the person, not by what the feature is called: a
 * "suggestion" that determines outcomes in practice is a decision (COMP-70).
 */
export const HIGH_RISK_PURPOSES: ReadonlySet<string> = new Set([
  'recruitment', 'candidate_selection', 'performance_evaluation',
  'task_allocation', 'worker_monitoring', 'promotion', 'termination',
]);

export interface AiRequest {
  tenantId: string;
  actorId: string;
  feature: string;
  purpose: string;
  /** Instructions authored by us. Never contains user text. */
  instruction: string;
  /** Structured fields. Employee-authored text goes in `untrustedData`, never here. */
  fields: Field[];
  /**
   * Employee-authored text: survey comments, feedback, recognition messages,
   * resumes, tickets. Treated as HOSTILE input (AI-03) and passed as data in a
   * separate message — never concatenated into the instruction.
   */
  untrustedData?: string[];
  /**
   * Required for a high-risk purpose. The human who will own the outcome.
   * There is no code path to a high-risk decision without one (AI-02, COMP-71).
   */
  humanDecider?: { id: string; name: string };
}

export interface AiCallRecord {
  tenantId: string; feature: string; purpose: string;
  model: string; promptVersion: string;
  inputTokens: number; outputTokens: number; costMinor: number;
  humanDeciderId: string | null;
  at: string;
}

export interface Provider {
  readonly name: string;
  readonly region: string;
  readonly model: string;
  complete(args: { instruction: string; data: string[] }): Promise<{
    text: string; inputTokens: number; outputTokens: number; costMinor: number;
  }>;
}

export interface GatewayDeps {
  provider: Provider;
  policyFor(tenantId: string): Promise<TenantAiPolicy>;
  record(call: AiCallRecord): Promise<void>;
  now(): string;
}

/**
 * The single entry point. Every guard below is ordered deliberately: the
 * cheapest and most consequential refusals happen first.
 */
export async function ask(deps: GatewayDeps, req: AiRequest): Promise<string> {
  const policy = await deps.policyFor(req.tenantId);

  // 1. Per-tenant opt-in. Off until an administrator turns it on.
  if (!policy.enabled) {
    throw new AiRefusedError('AI features are not enabled for this organisation.', 'tenant_opt_out');
  }

  // 2. Per-feature kill switch.
  if (!policy.enabledFeatures.has(req.feature)) {
    throw new AiRefusedError(`AI is switched off for "${req.feature}".`, 'feature_disabled');
  }

  // 3. Residency. Every call is a cross-border transfer; a region-pinned tenant
  //    cannot use a provider outside its region (COMP-41, COMP-43).
  if (!policy.providerRegions.has(deps.provider.region)) {
    throw new AiRefusedError(
      `This organisation's data must stay in ${policy.region}, and the model provider runs in ${deps.provider.region}.`,
      'residency',
    );
  }

  // 4. High-risk purposes require a recorded human decider BEFORE the call.
  //    There is no path around this (AI-02, COMP-71).
  if (HIGH_RISK_PURPOSES.has(req.purpose) && !req.humanDecider) {
    throw new AiRefusedError(
      `"${req.purpose}" affects a person's outcome, so a named human must own the decision.`,
      'no_human_decider',
    );
  }

  // 5. Classification gate. Refuse before building the prompt (AI-11, PRIV-06).
  const forbidden = req.fields.filter((f) => NEVER_SEND.has(f.classification));
  if (forbidden.length > 0) {
    throw new AiRefusedError(
      `Refused: ${forbidden.map((f) => f.name).join(', ')} may not be sent to a model.`,
      'classification',
    );
  }

  // 6. Minimisation — send only what the task needs.
  const payload = req.fields.map((f) => `${f.name}: ${f.value}`);

  // 7. Injection defence — untrusted text is passed as DATA, in its own
  //    messages, never concatenated into the instruction (AI-03).
  const data = [...payload, ...(req.untrustedData ?? []).map(wrapUntrusted)];

  const result = await deps.provider.complete({ instruction: req.instruction, data });

  // 8. Full call logging for the regulatory lifetime (COMP-76, AI-14).
  await deps.record({
    tenantId: req.tenantId, feature: req.feature, purpose: req.purpose,
    model: deps.provider.model, promptVersion: hashInstruction(req.instruction),
    inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    costMinor: result.costMinor,
    humanDeciderId: req.humanDecider?.id ?? null,
    at: deps.now(),
  });

  return result.text;
}

function wrapUntrusted(text: string): string {
  // The model is told explicitly that this is quoted third-party content and
  // that any instruction inside it is data to be reported, not obeyed.
  return `<employee_authored_content>\n${text}\n</employee_authored_content>`;
}

function hashInstruction(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `v${(h >>> 0).toString(16)}`;
}

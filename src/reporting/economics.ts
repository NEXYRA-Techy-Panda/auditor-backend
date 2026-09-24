/** Pure preparation math for future report integration. This module has no I/O. */

export type EvidenceKind = 'historical_consumption' | 'vacancy_estimate' | 'forecast'
  | 'excess_consumption' | 'gradual_trend' | 'scenario_comparison';

export interface EvidenceReference {
  dataset_id: string;
  run_id: string;
  job_id?: string;
  finding_id?: string;
  device_id: string;
  room_id: string;
  start_utc: string;
  end_utc: string;
}

export interface RecommendationInput {
  recommendation_id: string;
  suggested_action: string;
  evidence_type: EvidenceKind;
  comparison_status?: 'verified' | 'unverified' | null;
  method: string;
  references: EvidenceReference[];
  assumptions: string[];
  coverage_limitations: string[];
  synthetic: boolean | null;
  savings_estimate_kwh: number | null;
  savings_period_days: number | null;
  savings_basis: string | null;
}

export type Recommendation = RecommendationInput;

export function createRecommendation(input: RecommendationInput): Recommendation {
  if (!input.recommendation_id.trim() || !input.suggested_action.trim() || !input.method.trim()) {
    throw new RangeError('Recommendation identity, action and method are required');
  }
  if (input.references.length === 0) throw new RangeError('At least one evidence reference is required');
  for (const ref of input.references) {
    const start = parseUtcInstant(ref.start_utc); const end = parseUtcInstant(ref.end_utc);
    if (!ref.dataset_id || !ref.run_id || !ref.device_id || !ref.room_id || !Number.isFinite(start)
      || !Number.isFinite(end) || end <= start) throw new RangeError('Evidence references need identity and a positive UTC period');
  }
  const canSupportSavings = input.evidence_type === 'vacancy_estimate' || input.evidence_type === 'scenario_comparison';
  if (input.savings_estimate_kwh !== null) {
    if (!canSupportSavings) throw new RangeError(`${input.evidence_type} evidence cannot support a savings estimate`);
    finiteNonnegative(input.savings_estimate_kwh, 'savings_estimate_kwh');
    finitePositive(input.savings_period_days, 'savings_period_days');
    if (!input.savings_basis?.trim()) throw new RangeError('A savings estimate needs an explicit basis');
    if (input.evidence_type === 'scenario_comparison' && input.comparison_status !== 'verified') {
      throw new RangeError('Scenario savings require a verified comparison');
    }
    if (input.evidence_type === 'vacancy_estimate'
      && !input.references.some((ref) => ref.job_id && ref.finding_id)) {
      throw new RangeError('Vacancy savings require persisted job and finding references');
    }
  } else if (input.savings_period_days !== null) {
    throw new RangeError('A savings period requires a known savings estimate');
  }
  if (!canSupportSavings && input.savings_basis !== null) throw new RangeError(`${input.evidence_type} evidence cannot claim a savings basis`);
  return structuredClone(input);
}

export interface ExtrapolationRule {
  source_period_days: number;
  multiplier: number;
  assumption: string;
}

export interface EconomicsInput {
  supported_energy_reduction_kwh: number | null;
  source_period_days: number | null;
  projection_period_days: number;
  projection_period_months: number;
  tariff_inr_per_kwh: number | null;
  implementation_cost_inr: number | null;
  recurring_cost_inr: number | null;
  recurring_cost_period_months: number | null;
  extrapolation: ExtrapolationRule | null;
  supported_gross_recurring_savings_inr_per_month: number | null;
}

export interface EconomicsResult {
  status: 'available' | 'unavailable';
  unavailable_reason: string | null;
  projection_label: 'observed_period' | 'scenario_estimate' | null;
  projection_assumption: string | null;
  projected_energy_reduction_kwh: number | null;
  gross_savings_inr: number | null;
  recurring_cost_inr: number | null;
  net_period_savings_inr: number | null;
  implementation_cost_inr: number | null;
  upfront_classification: 'zero_upfront_cost' | 'priced' | 'unknown' | null;
  period_roi_percent: number | null;
  simple_payback_months: number | null;
  supported_net_recurring_savings_inr_per_month: number | null;
  payback_status: 'available' | 'no_positive_net_savings' | 'rate_unavailable' | 'unknown_cost' | null;
}

export function calculateEconomics(input: EconomicsInput): EconomicsResult {
  finitePositive(input.projection_period_days, 'projection_period_days');
  finitePositive(input.projection_period_months, 'projection_period_months');
  if (input.tariff_inr_per_kwh !== null) finiteNonnegative(input.tariff_inr_per_kwh, 'tariff_inr_per_kwh');
  if (input.implementation_cost_inr !== null) finiteNonnegative(input.implementation_cost_inr, 'implementation_cost_inr');
  if (input.recurring_cost_inr !== null) finiteNonnegative(input.recurring_cost_inr, 'recurring_cost_inr');
  if (input.recurring_cost_period_months !== null) finitePositive(input.recurring_cost_period_months, 'recurring_cost_period_months');
  if (input.supported_gross_recurring_savings_inr_per_month !== null) {
    finiteNonnegative(input.supported_gross_recurring_savings_inr_per_month, 'supported_gross_recurring_savings_inr_per_month');
  }
  if ((input.recurring_cost_inr === null) !== (input.recurring_cost_period_months === null)) {
    throw new RangeError('Recurring cost and its period must both be supplied or both be null');
  }
  if (input.supported_energy_reduction_kwh === null || input.source_period_days === null || input.tariff_inr_per_kwh === null) {
    return unavailable('Supported energy, its source period and tariff are all required', input.implementation_cost_inr);
  }
  finiteNonnegative(input.supported_energy_reduction_kwh, 'supported_energy_reduction_kwh');
  finitePositive(input.source_period_days, 'source_period_days');
  let projectedEnergy: number;
  let projectionLabel: EconomicsResult['projection_label'];
  let assumption: string | null = null;
  if (input.projection_period_days === input.source_period_days) {
    projectedEnergy = input.supported_energy_reduction_kwh;
    projectionLabel = 'observed_period';
    if (input.extrapolation !== null) throw new RangeError('Do not supply extrapolation for an unchanged source period');
  } else {
    if (input.extrapolation === null) return unavailable('A different projection period requires an explicit extrapolation rule', input.implementation_cost_inr);
    finitePositive(input.extrapolation.source_period_days, 'extrapolation.source_period_days');
    finiteNonnegative(input.extrapolation.multiplier, 'extrapolation.multiplier');
    if (!input.extrapolation.assumption.trim() || input.extrapolation.source_period_days !== input.source_period_days) {
      throw new RangeError('Extrapolation must preserve the source period and include assumption text');
    }
    projectedEnergy = input.supported_energy_reduction_kwh * input.extrapolation.multiplier;
    projectionLabel = 'scenario_estimate';
    assumption = input.extrapolation.assumption;
  }
  if (!Number.isFinite(projectedEnergy)) throw new RangeError('Projected energy is nonfinite');
  const gross = projectedEnergy * input.tariff_inr_per_kwh;
  const recurring = input.recurring_cost_inr === null ? 0
    : input.recurring_cost_inr * input.projection_period_months / input.recurring_cost_period_months!;
  const net = gross - recurring;
  const impl = input.implementation_cost_inr;
  const monthlyRecurringCost = input.recurring_cost_inr === null ? 0
    : input.recurring_cost_inr / input.recurring_cost_period_months!;
  const monthlyNetRate = input.supported_gross_recurring_savings_inr_per_month === null ? null
    : input.supported_gross_recurring_savings_inr_per_month - monthlyRecurringCost;
  let payback: number | null = null;
  let paybackStatus: EconomicsResult['payback_status'];
  if (impl === null) paybackStatus = 'unknown_cost';
  else if (monthlyNetRate === null) paybackStatus = 'rate_unavailable';
  else if (monthlyNetRate <= 0) paybackStatus = 'no_positive_net_savings';
  else { payback = impl / monthlyNetRate; paybackStatus = 'available'; }
  const roi = impl !== null && impl > 0 ? ((net - impl) / impl) * 100 : null;
  if (!Number.isFinite(gross) || !Number.isFinite(recurring) || !Number.isFinite(net)
    || (monthlyNetRate !== null && !Number.isFinite(monthlyNetRate))
    || (roi !== null && !Number.isFinite(roi)) || (payback !== null && !Number.isFinite(payback))) {
    throw new RangeError('Economics calculation produced a nonfinite result');
  }
  return { status: 'available', unavailable_reason: null, projection_label: projectionLabel,
    projection_assumption: assumption, projected_energy_reduction_kwh: projectedEnergy,
    gross_savings_inr: gross, recurring_cost_inr: recurring, net_period_savings_inr: net,
    implementation_cost_inr: impl,
    upfront_classification: impl === null ? 'unknown' : impl === 0 ? 'zero_upfront_cost' : 'priced',
    period_roi_percent: roi, simple_payback_months: payback,
    supported_net_recurring_savings_inr_per_month: monthlyNetRate, payback_status: paybackStatus };
}

function unavailable(reason: string, implementationCost: number | null): EconomicsResult {
  return { status: 'unavailable', unavailable_reason: reason, projection_label: null,
    projection_assumption: null, projected_energy_reduction_kwh: null, gross_savings_inr: null,
    recurring_cost_inr: null, net_period_savings_inr: null, implementation_cost_inr: implementationCost,
    upfront_classification: implementationCost === null ? 'unknown' : implementationCost === 0 ? 'zero_upfront_cost' : 'priced',
    period_roi_percent: null, simple_payback_months: null,
    supported_net_recurring_savings_inr_per_month: null, payback_status: null };
}

export interface ScenarioComparisonInput {
  comparison_id: string | null;
  original_energy_kwh: number;
  improved_energy_kwh: number;
  original_start_utc: string;
  original_end_utc: string;
  improved_start_utc: string;
  improved_end_utc: string;
  original_coverage_complete: boolean;
  improved_coverage_complete: boolean;
  original_inventory_fingerprint: string | null;
  improved_inventory_fingerprint: string | null;
  original_external_inputs_fingerprint: string | null;
  improved_external_inputs_fingerprint: string | null;
  original_policy_fingerprint: string | null;
  improved_policy_fingerprint: string | null;
  policy_difference_is_intended_intervention: boolean;
  policy_assumption: string;
  intervention_assumption: string;
  tariff_inr_per_kwh: number | null;
}

export interface ScenarioComparisonResult {
  status: 'verified' | 'unverified';
  verification_failures: string[];
  energy_difference_kwh: number;
  savings_inr: number | null;
}

export function calculateScenarioComparison(input: ScenarioComparisonInput): ScenarioComparisonResult {
  finiteNonnegative(input.original_energy_kwh, 'original_energy_kwh');
  finiteNonnegative(input.improved_energy_kwh, 'improved_energy_kwh');
  if (input.tariff_inr_per_kwh !== null) finiteNonnegative(input.tariff_inr_per_kwh, 'tariff_inr_per_kwh');
  const originalStart = parseUtcInstant(input.original_start_utc); const originalEnd = parseUtcInstant(input.original_end_utc);
  const improvedStart = parseUtcInstant(input.improved_start_utc); const improvedEnd = parseUtcInstant(input.improved_end_utc);
  const failures: string[] = [];
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart
    || !Number.isFinite(improvedStart) || !Number.isFinite(improvedEnd) || improvedEnd <= improvedStart) failures.push('invalid_comparison_window');
  if (originalStart !== improvedStart || originalEnd !== improvedEnd) failures.push('comparison_windows_not_matched');
  if (!input.original_coverage_complete || !input.improved_coverage_complete) failures.push('incomplete_coverage');
  if (!input.original_inventory_fingerprint || input.original_inventory_fingerprint !== input.improved_inventory_fingerprint) failures.push('inventory_not_matched');
  if (!input.original_external_inputs_fingerprint || input.original_external_inputs_fingerprint !== input.improved_external_inputs_fingerprint) failures.push('external_inputs_not_matched');
  if (!input.original_policy_fingerprint || !input.improved_policy_fingerprint) failures.push('policy_provenance_missing');
  else if (input.original_policy_fingerprint !== input.improved_policy_fingerprint && !input.policy_difference_is_intended_intervention) {
    failures.push('policy_difference_not_declared_intervention');
  }
  if (!input.policy_assumption.trim() || !input.intervention_assumption.trim()) failures.push('policy_or_intervention_assumption_missing');
  const verified = failures.length === 0;
  const difference = input.original_energy_kwh - input.improved_energy_kwh;
  const savings = verified && input.tariff_inr_per_kwh !== null ? difference * input.tariff_inr_per_kwh : null;
  if (savings !== null && !Number.isFinite(savings)) throw new RangeError('Scenario comparison produced a nonfinite monetary difference');
  return { status: verified ? 'verified' : 'unverified', verification_failures: failures,
    energy_difference_kwh: difference,
    savings_inr: savings };
}

export interface RankedRecommendation {
  recommendation_id: string;
  projection_period_days: number;
  projection_period_months: number;
  currency: 'INR';
  assumptions_fingerprint: string;
  savings_supported: boolean;
  simple_payback_months: number | null;
  upfront_cost_inr: number | null;
  overlap_group: string | null;
}

export interface RankingResult {
  ranking_basis: 'shortest_supported_simple_payback';
  ranked_ids: string[];
  unranked_ids: string[];
  overlap_conflicts: string[][];
}

/** Returns conflict pairs; callers must not add the paired savings claims together. */
export function detectOverlaps(items: readonly Recommendation[]): string[][] {
  const conflicts: string[][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!; const b = items[j]!;
    const overlap = a.references.some((left) => b.references.some((right) => left.device_id === right.device_id
      && Date.parse(left.start_utc) < Date.parse(right.end_utc) && Date.parse(right.start_utc) < Date.parse(left.end_utc)));
    if (overlap && a.savings_estimate_kwh !== null && b.savings_estimate_kwh !== null) conflicts.push([a.recommendation_id, b.recommendation_id].sort());
  }
  return conflicts;
}

export function rankRecommendations(items: readonly RankedRecommendation[]): RankingResult {
  const conflicts: string[][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!; const b = items[j]!;
    if (a.overlap_group !== null && a.overlap_group === b.overlap_group) conflicts.push([a.recommendation_id, b.recommendation_id].sort());
  }
  const conflicted = new Set(conflicts.flat());
  const eligible = items.filter((item) => !conflicted.has(item.recommendation_id) && item.savings_supported
    && Number.isFinite(item.projection_period_days) && item.projection_period_days > 0
    && Number.isFinite(item.projection_period_months) && item.projection_period_months > 0
    && item.assumptions_fingerprint.trim() !== '' && item.simple_payback_months !== null
    && Number.isFinite(item.simple_payback_months) && item.simple_payback_months >= 0
    && item.upfront_cost_inr !== null && Number.isFinite(item.upfront_cost_inr) && item.upfront_cost_inr >= 0);
  const unranked = new Set(items.filter((item) => conflicted.has(item.recommendation_id) || !eligible.includes(item)).map((item) => item.recommendation_id));
  const groups = new Map<string, RankedRecommendation[]>();
  for (const item of eligible) {
    const key = `${item.projection_period_days}\u0000${item.projection_period_months}\u0000${item.currency}\u0000${item.assumptions_fingerprint}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  // A flat ranking is honest only if every candidate shares the same basis.
  const ranked = groups.size === 1 ? [...groups.values()][0]! : [];
  if (groups.size > 1) for (const item of eligible) unranked.add(item.recommendation_id);
  ranked.sort((a, b) => a.simple_payback_months! - b.simple_payback_months!
    || (a.recommendation_id < b.recommendation_id ? -1 : a.recommendation_id > b.recommendation_id ? 1 : 0));
  const rankedIds = new Set(ranked.map((item) => item.recommendation_id));
  for (const item of items) if (!rankedIds.has(item.recommendation_id)) unranked.add(item.recommendation_id);
  return { ranking_basis: 'shortest_supported_simple_payback', ranked_ids: ranked.map((item) => item.recommendation_id),
    unranked_ids: [...unranked].sort(), overlap_conflicts: conflicts };
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
}
function finitePositive(value: number | null, name: string): asserts value is number {
  if (value === null || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}

function parseUtcInstant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return Number.NaN;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  const fraction = value.match(/\.(\d{1,3})Z$/);
  const canonical = fraction
    ? `${value.slice(0, fraction.index)}.${fraction[1]!.padEnd(3, '0')}Z`
    : value.replace(/Z$/, '.000Z');
  return new Date(timestamp).toISOString() === canonical ? timestamp : Number.NaN;
}

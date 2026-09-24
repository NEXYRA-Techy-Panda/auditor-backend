import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEconomics, calculateScenarioComparison, createRecommendation, detectOverlaps, rankRecommendations,
  type EconomicsInput, type RecommendationInput, type RankedRecommendation, type ScenarioComparisonInput } from '../src/reporting/economics.js';

const baseEconomics: EconomicsInput = { supported_energy_reduction_kwh: 0.01, source_period_days: 1,
  projection_period_days: 1, projection_period_months: 1, tariff_inr_per_kwh: 10,
  implementation_cost_inr: null, recurring_cost_inr: null, recurring_cost_period_months: null, extrapolation: null,
  supported_gross_recurring_savings_inr_per_month: null };
const baseRecommendation: RecommendationInput = { recommendation_id: 'vacancy-1', suggested_action: 'Review device schedule',
  evidence_type: 'vacancy_estimate', method: 'vacant-beyond-grace-v1', references: [{ dataset_id: 'd1', run_id: 'r1', job_id: 'j1',
    finding_id: 'f1', device_id: 'lamp-1', room_id: 'room-1', start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T00:01:00Z' }],
  assumptions: ['supported vacancy estimate'], coverage_limitations: [], synthetic: true,
  savings_estimate_kwh: 0.01, savings_period_days: 1, savings_basis: 'finding avoidable_energy_kwh for assessed period' };

test('0.01 kWh vacancy estimate at ₹10/kWh is ₹0.10 for its observed period only', () => {
  const result = calculateEconomics(baseEconomics);
  assert.equal(result.gross_savings_inr, 0.1);
  assert.equal(result.projected_energy_reduction_kwh, 0.01);
  assert.equal(result.projection_label, 'observed_period');
  const recommendation = createRecommendation(baseRecommendation);
  assert.equal(recommendation.savings_estimate_kwh, 0.01);
});

test('historical, forecast, excess and trend evidence cannot claim savings', () => {
  for (const evidence_type of ['historical_consumption', 'forecast', 'excess_consumption', 'gradual_trend'] as const) {
    assert.throws(() => createRecommendation({ ...baseRecommendation, evidence_type }), /cannot support a savings estimate/);
  }
});

test('missing tariff is unavailable while an explicit zero tariff is valid', () => {
  const missing = calculateEconomics({ ...baseEconomics, tariff_inr_per_kwh: null, implementation_cost_inr: 12000 });
  assert.equal(missing.gross_savings_inr, null);
  assert.equal(missing.implementation_cost_inr, 12000);
  assert.equal(missing.upfront_classification, 'priced');
  const zero = calculateEconomics({ ...baseEconomics, tariff_inr_per_kwh: 0 });
  assert.equal(zero.status, 'available');
  assert.equal(zero.gross_savings_inr, 0);
});

test('explicit ₹2,000 monthly net savings supports six-month simple payback', () => {
  const result = calculateEconomics({ ...baseEconomics, supported_energy_reduction_kwh: 200, source_period_days: 30,
    projection_period_days: 30, projection_period_months: 1, tariff_inr_per_kwh: 10,
    implementation_cost_inr: 12000, recurring_cost_inr: 0, recurring_cost_period_months: 1,
    supported_gross_recurring_savings_inr_per_month: 2000 });
  assert.equal(result.net_period_savings_inr, 2000);
  assert.equal(result.simple_payback_months, 6);
  assert.equal(result.supported_net_recurring_savings_inr_per_month, 2000);
});

test('₹24,000 annual net savings and ₹12,000 upfront gives 100% period ROI', () => {
  const result = calculateEconomics({ ...baseEconomics, supported_energy_reduction_kwh: 2400, source_period_days: 365,
    projection_period_days: 365, projection_period_months: 12, tariff_inr_per_kwh: 10,
    implementation_cost_inr: 12000, recurring_cost_inr: 0, recurring_cost_period_months: 12 });
  assert.equal(result.net_period_savings_inr, 24000);
  assert.equal(result.period_roi_percent, 100);
  assert.equal(result.simple_payback_months, null);
});

test('different projection period needs explicit extrapolation and preserves its scenario label', () => {
  const unavailable = calculateEconomics({ ...baseEconomics, projection_period_days: 365, projection_period_months: 12 });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.unavailable_reason, 'A different projection period requires an explicit extrapolation rule');
  const projected = calculateEconomics({ ...baseEconomics, projection_period_days: 365, projection_period_months: 12,
    extrapolation: { source_period_days: 1, multiplier: 365, assumption: 'User supplied constant daily opportunity for 365 days' } });
  assert.equal(projected.projection_label, 'scenario_estimate');
  assert.equal(projected.projected_energy_reduction_kwh, 3.65);
});

test('zero upfront cost is classified without infinite ROI; negative net savings has no payback', () => {
  const free = calculateEconomics({ ...baseEconomics, implementation_cost_inr: 0 });
  assert.equal(free.upfront_classification, 'zero_upfront_cost');
  assert.equal(free.period_roi_percent, null);
  const freeWithRate = calculateEconomics({ ...baseEconomics, implementation_cost_inr: 0,
    supported_gross_recurring_savings_inr_per_month: 10 });
  assert.equal(freeWithRate.simple_payback_months, 0);
  assert.ok(Number.isFinite(freeWithRate.simple_payback_months));
  const negative = calculateEconomics({ ...baseEconomics, implementation_cost_inr: 100, recurring_cost_inr: 2,
    recurring_cost_period_months: 1, supported_energy_reduction_kwh: 0, source_period_days: 1,
    supported_gross_recurring_savings_inr_per_month: 1 });
  assert.equal(negative.net_period_savings_inr, -2);
  assert.equal(negative.simple_payback_months, null);
  assert.equal(negative.payback_status, 'no_positive_net_savings');
  assert.equal(calculateEconomics({ ...baseEconomics, implementation_cost_inr: 12000 }).payback_status, 'rate_unavailable');
});

test('payback uses explicit monthly net savings after monthly recurring costs', () => {
  const result = calculateEconomics({ ...baseEconomics, supported_energy_reduction_kwh: 200,
    source_period_days: 30, projection_period_days: 30, projection_period_months: 1,
    implementation_cost_inr: 12000, recurring_cost_inr: 500, recurring_cost_period_months: 1,
    supported_gross_recurring_savings_inr_per_month: 2500 });
  assert.equal(result.supported_net_recurring_savings_inr_per_month, 2000);
  assert.equal(result.simple_payback_months, 6);
});

test('invalid nonfinite and negative monetary assumptions are rejected', () => {
  for (const implementation_cost_inr of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calculateEconomics({ ...baseEconomics, implementation_cost_inr }), /implementation_cost_inr must be finite and nonnegative/);
  }
  assert.throws(() => calculateEconomics({ ...baseEconomics, tariff_inr_per_kwh: Number.NaN }), /tariff_inr_per_kwh/);
  assert.throws(() => calculateEconomics({ ...baseEconomics, supported_gross_recurring_savings_inr_per_month: -1 }), /supported_gross_recurring_savings/);
  assert.throws(() => calculateEconomics({ ...baseEconomics, supported_energy_reduction_kwh: 1e308,
    tariff_inr_per_kwh: 1e308 }), /nonfinite result/);
  assert.throws(() => calculateScenarioComparison({ ...comparison, original_energy_kwh: 1e308,
    improved_energy_kwh: 0, tariff_inr_per_kwh: 1e308 }), /nonfinite monetary difference/);
});

test('ranking separates unequal projection periods and unknown costs', () => {
  const items: RankedRecommendation[] = [
    { recommendation_id: 'a', projection_period_days: 30, projection_period_months: 1, currency: 'INR', assumptions_fingerprint: 'same', savings_supported: true, simple_payback_months: 5, upfront_cost_inr: 100, overlap_group: null },
    { recommendation_id: 'b', projection_period_days: 365, projection_period_months: 12, currency: 'INR', assumptions_fingerprint: 'same', savings_supported: true, simple_payback_months: 2, upfront_cost_inr: 100, overlap_group: null },
    { recommendation_id: 'c', projection_period_days: 30, projection_period_months: 1, currency: 'INR', assumptions_fingerprint: 'same', savings_supported: false, simple_payback_months: 2, upfront_cost_inr: 100, overlap_group: null },
  ];
  const result = rankRecommendations(items);
  assert.deepEqual(result.ranked_ids, []);
  assert.deepEqual(result.unranked_ids, ['a', 'b', 'c']);
  assert.equal(result.ranking_basis, 'shortest_supported_simple_payback');
  const sameBasis = [items[0]!, { ...items[0]!, recommendation_id: 'z', simple_payback_months: 5 }];
  assert.deepEqual(rankRecommendations(sameBasis).ranked_ids, ['a', 'z']);
  assert.deepEqual(rankRecommendations([...sameBasis].reverse()).ranked_ids, ['a', 'z']);
  assert.deepEqual(rankRecommendations([{ ...items[0]!, projection_period_months: 0.5 }, items[0]!]).ranked_ids, []);
});

test('overlapping vacancy claims for one device are explicit conflicts, not additive totals', () => {
  const one = createRecommendation(baseRecommendation);
  const two = createRecommendation({ ...baseRecommendation, recommendation_id: 'vacancy-2', references: [{ ...baseRecommendation.references[0]!,
    finding_id: 'f2', start_utc: '2026-01-01T00:00:30Z', end_utc: '2026-01-01T00:02:00Z' }] });
  assert.deepEqual(detectOverlaps([one, two]), [['vacancy-1', 'vacancy-2']]);
  const disjoint = createRecommendation({ ...baseRecommendation, recommendation_id: 'vacancy-disjoint', references: [{
    ...baseRecommendation.references[0]!, finding_id: 'f3', start_utc: '2026-01-01T00:02:00Z', end_utc: '2026-01-01T00:03:00Z' }] });
  assert.deepEqual(detectOverlaps([one, disjoint]), []);
});

const comparison: ScenarioComparisonInput = { comparison_id: 'same-id-alone-is-not-enough', original_energy_kwh: 100, improved_energy_kwh: 80,
  original_start_utc: '2026-01-01T00:00:00Z', original_end_utc: '2026-01-02T00:00:00Z',
  improved_start_utc: '2026-01-01T00:00:00Z', improved_end_utc: '2026-01-02T00:00:00Z',
  original_coverage_complete: true, improved_coverage_complete: true,
    original_inventory_fingerprint: 'inventory', improved_inventory_fingerprint: 'inventory',
    original_external_inputs_fingerprint: 'inputs', improved_external_inputs_fingerprint: 'inputs',
    original_policy_fingerprint: 'policy', improved_policy_fingerprint: 'policy', policy_difference_is_intended_intervention: false,
    policy_assumption: 'same schedules except named change', intervention_assumption: 'replace lamp', tariff_inr_per_kwh: 10 };

test('matched scenario delta preserves signs and calculates tariff difference', () => {
  const result = calculateScenarioComparison(comparison);
  assert.equal(result.status, 'verified');
  assert.equal(result.energy_difference_kwh, 20);
  assert.equal(result.savings_inr, 200);
  const increased = calculateScenarioComparison({ ...comparison, improved_energy_kwh: 110 });
  assert.equal(increased.energy_difference_kwh, -10);
  assert.equal(increased.savings_inr, -100);
});

test('unmatched external inputs or coverage cannot produce verified monetary savings', () => {
  const result = calculateScenarioComparison({ ...comparison, improved_external_inputs_fingerprint: 'different', improved_coverage_complete: false });
  assert.equal(result.status, 'unverified');
  assert.equal(result.savings_inr, null);
  assert.deepEqual(result.verification_failures, ['incomplete_coverage', 'external_inputs_not_matched']);
});

test('a shared comparison identifier cannot replace equal compared windows', () => {
  const result = calculateScenarioComparison({ ...comparison, improved_start_utc: '2026-01-01T00:01:00Z' });
  assert.equal(result.status, 'unverified');
  assert.equal(result.savings_inr, null);
  assert.ok(result.verification_failures.includes('comparison_windows_not_matched'));
});

test('a changed intervention policy is verified only when declared as the controlled intervention', () => {
  const allowed = calculateScenarioComparison({ ...comparison, improved_policy_fingerprint: 'policy-after',
    policy_difference_is_intended_intervention: true });
  assert.equal(allowed.status, 'verified');
  const unexplained = calculateScenarioComparison({ ...comparison, improved_policy_fingerprint: 'policy-after',
    policy_difference_is_intended_intervention: false });
  assert.equal(unexplained.status, 'unverified');
  assert.ok(unexplained.verification_failures.includes('policy_difference_not_declared_intervention'));
});

test('evidence windows must use explicit UTC timestamps', () => {
  assert.throws(() => createRecommendation({ ...baseRecommendation, references: [{
    ...baseRecommendation.references[0]!, start_utc: '2026-01-01T00:00:00+05:30' }] }), /positive UTC period/);
  assert.throws(() => createRecommendation({ ...baseRecommendation, references: [{
    ...baseRecommendation.references[0]!, start_utc: '2026-02-30T00:00:00Z' }] }), /positive UTC period/);
});

test('scenario recommendation savings require verified comparison status', () => {
  assert.throws(() => createRecommendation({ ...baseRecommendation, evidence_type: 'scenario_comparison' }), /require a verified comparison/);
  const verified = createRecommendation({ ...baseRecommendation, evidence_type: 'scenario_comparison', comparison_status: 'verified' });
  assert.equal(verified.evidence_type, 'scenario_comparison');
});

test('vacancy savings require persisted job and finding references', () => {
  const unlinked = { dataset_id: 'd1', run_id: 'r1', device_id: 'lamp-1', room_id: 'room-1',
    start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T00:01:00Z' };
  assert.throws(() => createRecommendation({ ...baseRecommendation, references: [unlinked] }), /job and finding references/);
});

test('calculations are deterministic and do not mutate their input objects', () => {
  const original = structuredClone(baseEconomics);
  const first = calculateEconomics(baseEconomics); const second = calculateEconomics(baseEconomics);
  assert.deepEqual(baseEconomics, original);
  assert.deepEqual(first, second);
});

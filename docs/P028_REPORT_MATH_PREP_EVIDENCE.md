# P028-PREP — report economics preparation

Developer Mohan | Agent M-B — Codex | P028-PREP | Review pending

Prepared on a separate worktree at `K:\NEXYRA-P028-report-math-prep`, branch
`mohan/p028-report-math-prep`, based on committed auditor-backend SHA
`d0fcd092fa39ca17a7efbcdaeffd4e43bd1c2eb1`. This is newer than the reported
deployment baseline `f3b8e2c8dac923957d91e1a55591abc7e03fe67c`; no working-tree
changes from the owner branch were brought over.
Implementation commit: `abab61321c723f2a2c8cf30392d64fabed496528` (local only;
feature branch not pushed; review pending).

## Module surface

`src/reporting/economics.ts` is pure TypeScript and performs no I/O:

```ts
createRecommendation(input: RecommendationInput): Recommendation
calculateEconomics(input: EconomicsInput): EconomicsResult
calculateScenarioComparison(input: ScenarioComparisonInput): ScenarioComparisonResult
detectOverlaps(items: readonly Recommendation[]): string[][]
rankRecommendations(items: readonly RankedRecommendation[]): RankingResult
```

Exported data types are `EvidenceKind`, `EvidenceReference`,
`RecommendationInput`, `Recommendation`, `ExtrapolationRule`,
`EconomicsInput`, `EconomicsResult`, `ScenarioComparisonInput`,
`ScenarioComparisonResult`, `RankedRecommendation`, and `RankingResult`.

- `createRecommendation(input)` validates evidence references, periods,
  assumptions, coverage limitations and provenance. Historical consumption,
  forecasts, excess-consumption observations and gradual trends cannot carry
  savings amounts. Savings must be a supported vacancy estimate or a verified
  scenario comparison, with an explicit basis.
- `calculateEconomics(input)` consumes explicit user-entered cost, tariff,
  source/projection period and optional extrapolation inputs. It returns
  gross/net period values, simple period ROI, and simple payback only if the
  caller explicitly establishes a recurring savings rate. Unknown tariff or
  supported energy returns unavailable; explicit zero tariff remains valid.
  Zero upfront cost has its own classification and no manufactured infinite
  ROI. Arithmetic retains full JavaScript number precision; callers round only
  when displaying values. Flat tariff excludes unsupported utility charges.
- `calculateScenarioComparison(input)` returns signed original-minus-improved
  kWh. Verification requires equal positive UTC windows, complete coverage, equal non-empty inventory and
  external-input fingerprints, an admissible window, and stated policy and
  intervention assumptions. `comparison_id` is not used as proof. Unverified
  differences cannot be priced as savings; a verified negative difference
  remains negative.
- `detectOverlaps(items)` reports individual recommendation pairs for the same
  device with intersecting half-open UTC windows. It intentionally does not
  produce a combined savings total.
- `rankRecommendations(items)` returns deterministic payback ranking and a
  separate unranked list. Only finite supported payback, known upfront cost,
  explicit `savings_supported: true`, known upfront cost, and matching day and
  month projection periods/currency/assumption fingerprint qualify; supplied
  overlap groups are excluded and reported. If eligible candidates have
  multiple comparison bases, all are unranked instead of choosing a basis from
  input order.

## Minimal typed examples

Supported vacancy recommendation input:

```ts
const vacancy = createRecommendation({
  recommendation_id: 'rec-1', suggested_action: 'Review lighting schedule',
  evidence_type: 'vacancy_estimate', method: 'vacant-beyond-grace-v1',
  references: [{ dataset_id: 'ds-1', run_id: 'run-1', job_id: 'job-1',
    finding_id: 'finding-1', device_id: 'light-1', room_id: 'room-1',
    start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-01-01T00:01:00Z' }],
  assumptions: ['P015 supported avoidable energy for this finding'],
  coverage_limitations: [], synthetic: true,
  savings_estimate_kwh: 0.01, savings_period_days: 1,
  savings_basis: 'finding-1 avoidable_energy_kwh'
});
```

The returned `Recommendation` is a validated clone of that input. Passing its
supported energy and period to `calculateEconomics` with tariff `10`, the same
one-day projection period, null costs, no extrapolation and a null
`supported_gross_recurring_savings_inr_per_month` yields `gross_savings_inr:
0.1`, `projection_label: 'observed_period'`, null ROI/payback, and unknown
upfront-cost classification. The one-day amount is not annualized.

The returned recommendation retains `recommendation_id: 'rec-1'`, the source
reference, action, `evidence_type: 'vacancy_estimate'`, method, assumptions,
coverage limitations, synthetic provenance, `savings_estimate_kwh: 0.01`,
`savings_period_days: 1`, and the supplied `savings_basis` unchanged.

Unsupported/unranked example: a forecast recommendation has
`evidence_type: 'forecast'`, `savings_estimate_kwh: null`,
`savings_period_days: null`, and `savings_basis: null`. Its ranking candidate
must set `savings_supported: false`, `simple_payback_months: null`, and
`upfront_cost_inr: null`. `rankRecommendations` returns its ID only in
`unranked_ids`; unknown price is not treated as zero.

Verified scenario comparison requires both energy values; exact original and
improved UTC bounds; both complete-coverage flags; equal non-empty inventory
and external-input fingerprints; policy fingerprints; an explicit declaration
when the policy fingerprint changes as the intended intervention; and written
policy/intervention assumptions. With original `100 kWh`, improved `80 kWh`,
both windows `2026-01-01T00:00:00Z` to `2026-01-02T00:00:00Z`, complete coverage,
matched provenance, stated intervention, and tariff `10`,
`calculateScenarioComparison` returns `status: 'verified'`,
`energy_difference_kwh: 20`, `savings_inr: 200`. If improved use is `110 kWh`,
it returns `-10 kWh` and `-100 INR`.

API grounding: P015 vacancy results contain `finding_type`, finding and job
identity, device/room, UTC window, method/assumptions and optional
`avoidable_energy_kwh`; unknown avoidable energy remains unknown. P020 forecast
results are a forecast baseline with origin, horizon, method/version and
history coverage, not savings. P023 historical responses preserve null for
missing energy, expose partial/missing coverage, and do not prorate crossing
intervals. P026 excess/trend results are deviations and explicitly excluded
from vacancy avoidable-energy totals. See `docs/P015_ANALYSIS_INTEGRATION_EVIDENCE.md`,
`docs/P020_FORECAST_INTEGRATION_EVIDENCE.md`,
`docs/P023_HISTORICAL_ANALYTICS_EVIDENCE.md`,
`docs/P026_DEVICE_ANALYSIS_INTEGRATION_EVIDENCE.md` and
`docs/AUDITOR_API_EXAMPLES.md`.

## Checks and limitations

Focused tests are in `test/P028_report_economics.test.ts`. They include the
required ₹0.10 observed-period example, missing versus zero tariff, ₹12,000 /
₹2,000 monthly → six months, ₹24,000 annual net / ₹12,000 upfront → 100% ROI,
no implicit annualization, zero/negative/nonfinite cases, period-aware ranking,
overlap reporting, matched 100/80 kWh → 20 kWh / ₹200, negative comparison
difference, unverified inputs, determinism and non-mutation.

P028-PREP-R1 `npm ci` was attempted in this isolated worktree and failed while
building locked `better-sqlite3@13.0.3`: `node-gyp` found Python 3.13.15 but no
Visual Studio C++ workload. No retry or script bypass was used. Its failure
left no local `tsc`, `eslint`, or `tsx`; `npm ls --depth=0` reports the locked
dependencies unmet. The supported typecheck, lint, focused test runner and
build therefore remain unrun. The six direct Node 24 runtime known-answer
checks from P028-PREP are prior checks and do not substitute for this round's
compiler/linter/test gates. No services, databases, model training or network
calls other than the authorized `npm ci` were used.

## Later integration

No report endpoint or response is implemented. The future backend must derive
or verify every savings claim against persisted data; passing these shape and
arithmetic checks is **not proof that caller-supplied evidence, assumptions,
coverage flags, fingerprints, savings rates, or costs are true**. It must load
the dataset/run/source metadata, synthetic provenance, exact interval
coverage, and P015 vacancy finding/job/method/assumptions (or persisted verified
comparison record). P020 forecast and P026 deviation rows must remain excluded
from savings. The current contract identifies scenario/comparison IDs, policy
versions, occupancy readings and synthetic labels, but does not provide an
established external-input fingerprint/comparison route. Until backend code
can establish equal external inputs from persisted exports, comparison status
must be `unverified`.

The future API must obtain or derive explicit INR/kWh tariff, upfront cost,
recurring gross cost and its period, supported energy reduction and source
period, projection period in both days/months, any extrapolation multiplier
plus source period and written assumption, and a supported gross recurring
savings amount in INR/month for payback. Persist the specific source
dataset/run/import metadata, synthetic label, interval coverage counters,
finding/job IDs, detector method/version, assumptions, policy versions,
inventory identity, and comparison external-input provenance used to derive
each value. P015 finding refs need device/room/window plus
`avoidable_energy_kwh`; never reconstruct unsupported values from total
consumption. Payback subtracts monthly recurring cost once from the explicit
gross recurring rate; period ROI uses period net savings minus upfront cost
once. Unknown fields stay null/unavailable. Flat tariff estimates omit
unsupported utility charges.

Surface `detectOverlaps` pairs and do not total those claims together; either
apply a persisted/verified non-overlap rule or keep individual figures and
show the conflict. `rankRecommendations` sends unknown/unsupported items to
`unranked_ids`; conflicting economic bases also remain unranked. Frontend work
needs explicit assumption forms and report sections for source references,
synthetic label, coverage, projection label, unavailable reasons, comparison
verification failures and overlap conflicts. No API/UI integration is complete.

**Prepared on a feature branch; not merged, exposed through API or deployed.**

## P028-PREP-R1 verification follow-up (2026-09-25)

Review added the following safeguards in `src/reporting/economics.ts` and the
focused test file:

- Payback now uses explicit `supported_gross_recurring_savings_inr_per_month`
  less monthly recurring cost; it no longer derives a recurring rate from a
  single projection period. The ₹12,000/₹2,000 supported monthly net case is
  six months. Period ROI subtracts upfront cost once; simple payback divides
  upfront cost by recurring net rate, with no upfront double count.
- Ranking requires `savings_supported`, finite nonnegative known upfront cost,
  finite payback, a nonempty assumption fingerprint, and compatible projection
  days, months, currency and assumptions. Multiple eligible bases are all
  unranked. Equal-payback ties use code-unit ID ordering.
- Scenario inputs include policy provenance and an explicit flag allowing a
  policy fingerprint difference only when it is the intended intervention.
  Evidence windows require explicit UTC `Z` timestamps. Missing tariff or
  projection assumptions retain known upfront cost/classification while
  keeping savings/ROI unavailable. Nonfinite calculated totals fail closed.
- Tests now also cover monthly cost deduction, finite zero-cost payback,
  unsupported ranking, mismatched periods, disjoint overlap,
  explained/unexplained policy change, invalid UTC, preserved known cost and
  nonfinite outputs.

R1 environment: `npm ci` exited 1. `better-sqlite3@13.0.3` invoked node-gyp;
Python 3.13.15 was found, but Visual Studio and its C++ workload were not.
`npm run typecheck`, `npm run lint`, focused `npm exec --offline -- tsx --test
test/P028_report_economics.test.ts`, and `npm run build` each exited 1 because
the failed install left `tsc`, `eslint` and `tsx` unavailable (`ENOTCACHED` for
the offline test runner). Twenty-seven direct Node 24 runtime assertions passed
against the module, but do not replace those four gates. `git diff --check`
passed. No install retry, `--ignore-scripts`, security bypass, dependency
manifest change, API/UI change, service, DB, or training action occurred.

### Later backend inputs and current limitations

The future API must obtain or derive INR/kWh tariff; implementation and
recurring costs with units/periods; supported energy reduction, source window,
projection days and months, and any extrapolation source period/multiplier/
assumption; and a supported recurring gross INR/month rate for payback. It
must derive the day and month representations from the same persisted
projection window; the math layer accepts both explicitly and does not prove
that callers mapped them consistently. Ranking requires both representations
to match across candidates. It must persist/verify dataset/run, import/source and synthetic provenance,
coverage counters, device/room/window, vacancy finding/job/method/assumptions,
inventory and policy identities, and external input provenance. These math
functions validate structure and arithmetic; caller-supplied fingerprints,
coverage booleans, labels, costs and savings rates are not proof. The backend
must derive or check each against persisted records. Existing contract fields
include scenario/comparison IDs, occupancy and policies, but no established
external-input matching fingerprint or comparison endpoint; until backend
verification can establish matching inputs, the pair remains unverified.

Keep overlapping device/window claims separate and surface `overlap_conflicts`;
do not total them absent a verified non-overlap rule. Unsupported/unknown-cost
actions stay in `unranked_ids`; recommendations with incomparable projection
bases are not placed into one ranking. Flat-tariff output still excludes
unsupported utility charges. The feature branch is local; commits are listed
in the progress log. API/UI integration, release verification and deployment
remain pending.

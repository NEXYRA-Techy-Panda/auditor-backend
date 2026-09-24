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
  and matching period/currency/assumption fingerprint qualify; supplied
  overlap groups are excluded and reported.

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

Verification: six direct Node 24 type-stripping runtime known-answer assertions
against the actual module passed (observed ₹0.10, unavailable vs zero tariff,
matched ₹200 scenario difference, negative signed difference, unmatched
external inputs). The repository typecheck could not start (`tsc` missing);
lint could not start (`eslint` missing); the focused `tsx` test command could
not resolve offline (`ENOTCACHED`). This worktree has no `node_modules` and the
assignment prohibits network/dependency installation. The repository test file
is committed for execution when the approved local toolchain is available. No
services, databases, model training or network requests were used.

## Later integration

This preparation creates no route or production response. Backend integration
still needs report persistence/data selection, validation of client assumptions,
overlap resolution, route contracts and report assembly. Frontend work needs
forms for upfront/recurring costs, tariff, projection period and explicit
extrapolation; report sections should show source references, synthetic label,
coverage, assumptions, unavailable reasons, period basis, scenario-vs-observed
label, comparison verification failures and overlap conflicts. Unknown-cost
items must remain “cost unknown,” not free. Do not combine claims until a
documented non-overlap rule or explicit user resolution exists.

**Prepared on a feature branch; not merged, exposed through API or deployed.**

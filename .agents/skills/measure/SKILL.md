---
name: measure
description: Evaluate a product's metrics and journeys against available evidence and name what blocks a conclusion; read-only. Use when the user says "measure our progress", "how are our metrics doing", or "are users completing this journey".
disable-model-invocation: false
---

# Measure

**What does the evidence say?** Compare each metric's definition with the evidence you can reach, report what it supports, and name exactly what stops a conclusion. This judges measured outcomes; product-wide fit is `align`, and session improvements are `retro`.

## Gather

Read the definitions first: the main metric, supporting metrics, and core journeys in `PRODUCT.md` (steps in `DESIGN.md`), and any measurement a relevant spec defines. Then read evidence through whatever the host reaches: tools, local data, or exports the user supplies. Nothing is required: no Git, vendor, or connector. When a definition is missing, say so and measure only what is defined.

## Report each metric

- **Result:** baseline, current value, target, source, observation period, sample size, and limitations, with the calculation shown so it can be rechecked. Count each qualifying outcome once; an emitted event is not a successful outcome unless the definition says so.
- **Comparisons** only between compatible definitions and populations; label the rest incompatible. A before/after difference alone is not causation.
- **Provenance:** say when evidence is a fixture, sample, or test data rather than production.
- **Gap**, when there is no conclusion, as one or more of, blocking one first:
  - **Not collected:** nothing records it.
  - **Instrumentation missing or wrong:** raw data exists but nothing computes the metric, or collection misses, double-counts, or misattributes outcomes (for example, human and agent traffic).
  - **No access:** the data likely exists but this session cannot reach it.
  - **Insufficient:** the data is reachable but too small, short, or noisy to conclude.

Unknown is never zero, and missing access never hides what can be established. Never invent a value.

## Next step

For each gap, name the smallest useful response: reuse existing collection, then a manual or export-based count, before any new service. Suggest tooling only for a concrete capability gap: name the capability and its tradeoff, and check a product's current capabilities before naming it.

Close with what the evidence supports, what remains uncertain, and the next measurement or product decision. Lead with a table (metric, result, target, source, gap) when there is more than one metric.

## Boundaries

Read-only. Never install tools, connect accounts, change tracking, create dashboards, or schedule recurring work; a recommendation becomes work only when the user asks for it (`build`, or `to-spec` for a tracked change).

# Assistant and Six-Agent Methodology

This guide describes how the conversational Analyst and the six-agent
Investigations panel work in this platform. The implementation lives in
`backend/app/agents/`; the Insights Hub's measured KPIs come from
`backend/app/tpo/`.

## At a glance

The platform uses a language model to interpret questions and explain results.
It does not delegate KPI arithmetic to the model. Backend services calculate
the facts first, and the model receives those facts for a bounded task such as
choosing a scope, writing a finding, or synthesising evidence.

| User need | Feature | Method |
|---|---|---|
| Look up a metric or compare groups | Analyst | Model selects approved data tools; deterministic services calculate results |
| Find plausible drivers and evidence | Investigations | Planner, six parallel specialist agents, evidence checks, synthesiser |
| Get a business explanation of a saved decision | Decision Brief | Model explains a deterministic decision record; figures are checked against it |

## The six-agent investigation panel

For investigations over the built-in TPO star schema, every run uses this
standing panel. The planner may tailor an assignment, but it does not choose
which members of this panel run. A specialist's data fetch is distinct and is
prepared by the platform before that specialist is called.

| Agent | Responsibility | Evidence it reads |
|---|---|---|
| Benchmarking Agent (`benchmark`) | Establish whether the selected segment is abnormal | Segment and whole-business KPIs; peer channel and region comparisons |
| Effectiveness Agent (`mechanic_efficiency`) | Compare promotion mechanics | Mechanic ROI inside the segment and across the business |
| Diagnostics Agent (`offer_forensics`) | Identify specific weak or strong promotion events | Underperforming and top promotion records, including spend and value at stake |
| Risk Agent (`risk_exposure`) | Quantify unresolved downside | Below-target events, severity and concentration of exposure |
| Optimization Agent (`geography`) | Locate differences by place or trade partner | Region, state and retailer breakdowns |
| Cannibalization Agent (`cannibalization`) | Check movement in related products during promotions | Same-brand-form neighbour sales and the separate validated cannibalization KPI |

The codebase contains a **nine-member specialist roster** in
`backend/app/agents/roster.py`. The six above are the fixed star-schema panel in
`backend/app/agents/star_pipeline.py`. The other roster lenses are spend
allocation, portfolio and temporal analysis; the planner can consider them,
but the built-in-data run still uses its fixed six. Uploaded files use a
separate analysis pipeline and planner, which chooses up to six analyses that
fit the uploaded file's columns. This distinction explains why documentation
may refer both to six agents and to nine specialists.

## How an investigation runs

1. **Question and scope.** The user question and selected dataset/scope are
   resolved by the investigation API. The built-in dataset uses the same TPO
   filter and row-resolution logic as the Insights Hub. Uploaded files use
   their profiled schema and mapped column roles.
2. **Plan.** A planner classifies the investigation and returns structured
   output. For the built-in dataset it briefs the standing panel. For an
   uploaded file it maps real columns to semantic roles and chooses analyses
   whose required columns exist.
3. **Prepare facts.** Deterministic service functions aggregate the rows each
   specialist needs. The agents receive compact evidence payloads, not raw
   uploaded rows.
4. **Specialist findings.** The six star-schema specialists run concurrently.
   Each returns a schema-constrained finding with a headline, explanation,
   evidence and optional chart values. A failure in one lens is reported as an
   unavailable finding and does not cancel the other lenses.
5. **Ground findings.** Confidence is calculated from support and traceability.
   Numeric provenance checks compare figures in generated findings with the
   values supplied to that agent. Unsupported chart values are removed; delta
   arithmetic is done by application code from named, verified operands.
6. **Synthesis.** A final model call weighs the specialist results into a root
   cause and summary. Application code grounds the synthesis against findings
   actually returned and calculates the overall confidence.
7. **Progress and record.** The API stores run progress and emits stage changes
   for the UI. The resulting investigation includes its question, scope,
   findings, evidence and failures for review.

These are hypotheses supported by observed data, not proof of causation. The
prompt and product copy instruct the agents to distinguish co-movement from
causality and to state when the data cannot support a conclusion.

## Conversational Analyst

The Analyst answers metric questions and comparisons. It interprets plain
language, chooses from bounded application tools, and returns the results in
plain language. Its tool loop is capped at five steps; it carries at most eight
previous turns for follow-up context. Tool results are calculated by existing
TPO services and the shared KPI engine. The Analyst does not receive raw CSV
rows to calculate metrics itself.

The Analyst is not the causal investigation feature. Direct causal questions
are deflected to Investigations, where six specialist lenses and evidence
checks are available. This avoids presenting a plausible narrative as a
measured explanation.

## Technology and guardrails

- **Backend:** Python, FastAPI, deterministic TPO aggregation and filtering,
  and asynchronous investigation orchestration.
- **Model interface:** the OpenAI-compatible chat completion client in
  `backend/app/agents/client.py`. The provider, model and credentials are
  configured server-side. Strict JSON-schema responses are used for pipeline
  stages that feed structured UI components.
- **Data separation:** the built-in star schema and uploaded CSVs have
  different evidence adapters. Upload profiling caches schema, null counts,
  numeric summaries, categorical summaries and sample rows; agent analyses
  use bounded aggregates rather than sending entire files to the model.
- **Grounded numbers:** `figures.py` tracks numeric provenance, validates
  chart values, and computes supported deltas. `confidence.py` scores evidence
  strength in application code.
- **Failure handling:** specialist errors are isolated and surfaced. If no
  useful specialist result survives, the pipeline reports failure rather than
  manufacturing a root cause.
- **Privacy boundary:** provider keys are held by the server and are not sent
  to the browser. Connector credentials are handled by connector routes and
  should not be placed in prompts or analysis payloads.

## Where to inspect the implementation

| Concern | Source |
|---|---|
| Investigation API and run progress | `backend/app/routers/investigations.py`, `backend/app/investigation_runs.py` |
| Built-in-data planner and six-agent orchestration | `backend/app/agents/star_pipeline.py` |
| Specialist roles, prompts and fact fetchers | `backend/app/agents/roster.py` |
| Uploaded-file planner and analyses | `backend/app/agents/pipeline.py`, `backend/app/dataset_store.py` |
| Model client and structured output | `backend/app/agents/client.py` |
| Number provenance and chart checks | `backend/app/agents/figures.py` |
| Confidence scoring | `backend/app/agents/confidence.py` |
| Conversational Analyst and bounded tools | `backend/app/agents/analyst.py`, `backend/app/routers/analyst.py` |
| Detailed prompt reference | `TPO_DOCUMENTATION/13_AGENTS_AND_PROMPTS.md` |

# Judgment-card distillation

Return one JSON object shaped as `{ "cards": [...] }`. Each array entry must contain
exactly these fields:

- `situation` (string): the generalized scenario, written so it transfers to future
  work while keeping the concrete decision recognizable.
- `judgment` (string): the action the author chose, or would choose.
- `rationale` (string): why that action was preferred over the alternatives.
- `tags` (string array): 1-6 short lowercase keywords (kebab-case), no duplicates.
- `domain`: `"work"` or `"hobby"`.
- `visibility`: `"public"` or `"sensitive"`.
- `confidence`: a plain number from 0 through 1 (not a string).

## What counts as a card

Extract only counterfactual decisions: a situation where more than one reasonable
action was possible, the action the author chose or would choose, and the reason for
that choice. Discard status reports, event summaries, facts, commands without
rationale, and duplicated statements.

If the document contains no counterfactual decision, return `{"cards": []}` -- do not
invent one to fill the response.

Generalize the situation so it transfers to future work while preserving the concrete
decision. Do not invent missing reasoning; if the rationale is not stated or clearly
implied, leave the decision out rather than guessing at it.

## Visibility

`visibility` is `"public"` only when the complete card -- situation, judgment, and
rationale together -- is safe to share publicly with no further redaction needed. When
uncertain, use `"sensitive"`. Never copy names, email addresses, credentials, tokens,
private URLs, absolute filesystem paths, customer or school identifiers, or other
identifying details into a card, in either visibility.

## Output format

Return raw JSON only: no Markdown code fences, no commentary before or after the
object, no trailing text.

## Examples (synthetic, illustrative only -- never copy their content into real output)

Input:

> Two ways to fix the flaky test existed: skip it in CI, or make the wait
> deterministic. Skipping would hide a real race; the deterministic wait costs more
> code today but doesn't hide the bug. Went with the deterministic wait.

Output:

```json
{
  "cards": [
    {
      "situation": "A flaky test can be fixed by hiding the symptom (skip or retry) or by removing the underlying race (deterministic wait or synchronization)",
      "judgment": "Prefer removing the race even when it costs more code, over hiding the symptom",
      "rationale": "Hiding the symptom keeps the real bug latent instead of fixing it",
      "tags": ["testing", "flaky-tests", "root-cause"],
      "domain": "work",
      "visibility": "public",
      "confidence": 0.85
    }
  ]
}
```

Input:

> Deployed the nightly batch job at 2am. It ran for 12 minutes and processed 4,300
> records with no errors.

Output:

```json
{"cards": []}
```

This second input is a status report with no decision between alternatives, so
nothing is extracted.
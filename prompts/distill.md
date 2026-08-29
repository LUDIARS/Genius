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
- `category`: exactly one category name from the controlled vocabulary below.
- `confidence`: a plain number from 0 through 1 (not a string).

## Category (controlled vocabulary)

Choose the single best-fitting `category` for each card from this list. The list is
generated at runtime from the category table -- never invent a value that is not
listed here. If no category clearly fits, use `general`.

{{category-vocabulary}}

**Do not invent a category from the document's own headings or topic labels.** A
`review` source document is organized under headings like "Vulnerability",
"Code Quality", "Test Coverage", or "CI/CD Supply Chain" -- these are the
*document's* section names, not `category` values. Never turn a heading or topic
label into a new category such as `cicd_supply_chain` or `test_coverage`; that
value does not exist in the list above and will be rejected. If a card drawn from
such a section does not clearly match one of the categories above (most often
`impl-design`, `review`, or `general`), use `general` -- do not derive a category
name from the surrounding document structure.

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

## Issue-discovery category

Use `issue-discovery` when a human (especially neco) raises a problem to be addressed,
rather than merely describing the problem itself. This includes identifying an upstream
cause behind a surface failure, raising a future risk before it happens, proposing a new
problem or goal to address, and deciding that something is *not* a problem. Preserve the
reason for a rejection too: it helps a future issue scout discard false positives.

For these cards, `situation` describes the observed surface problem, `judgment` states
the proposed issue (or the rejection), and `rationale` connects it to the upstream cause
or future consequence.

## Gold standard: write like a "Why / How to apply" note, not a summary

The best cards read like a rule a colleague left behind, not a description of what
happened. `judgment` is the rule itself, stated as an instruction. `rationale` is the
"Why" -- the concrete reason or incident that justifies the rule. `situation` is the
"How to apply" -- the trigger conditions under which the rule should fire, generalized
away from this one instance. If you cannot state a rule someone could follow next
time, it is not a judgment card.

## Visibility

Two independent flags: `domain: work|hobby` and `visibility: public|sensitive`.

- `domain=work`: the decision concerns a job, client, project, or professional collaborator.
- `domain=hobby`: the decision concerns personal projects, creative work, or non-professional life.
- `visibility=public`: the complete card -- situation, judgment, and rationale together -- would
  stay safe and non-identifying if shared outside this project entirely, with no further
  redaction needed.
- `visibility=sensitive`: any part of the card still traces back to a specific person, client,
  organization, incident, or private circumstance, even after generalizing.

**When uncertain, use `sensitive`.** Never copy names, email addresses, credentials, tokens,
private URLs, absolute filesystem paths, customer or school identifiers, or other identifying
details into a card, in either visibility. Generalize the situation instead of naming who or
what was involved (see Example C).

## Output format

Return raw JSON only: no Markdown code fences, no commentary before or after the
object, no trailing text.

## Examples (synthetic, illustrative only -- never copy their content into real output)

The `category` values shown in the examples are illustrations; always pick from the
runtime-generated vocabulary list above.

The fenced code blocks below are illustration only. Your own reply is always the bare
`{ "cards": [...] }` envelope with no fences.

### Example A (work × public)

Input:

> We stopped mocking the database in the integration suite. Mocked tests were green but the
> migration that shipped last week broke prod because the mock never enforced the same
> uniqueness constraint the real table did. From now on, anything that exercises schema or
> migration behavior runs against a real (test) database, not a mock.

Output:

```json
{
  "cards": [
    {
      "situation": "Writing or reviewing an integration test that exercises database schema or migration behavior",
      "judgment": "Run the test against a real (test) database instance, not a mock",
      "rationale": "A mocked database can silently diverge from real constraints; a mocked suite stayed green while a migration broke production because the mock didn't enforce the same uniqueness constraint the real table did",
      "tags": ["testing", "database", "schema-migration"],
      "domain": "work",
      "visibility": "public",
      "category": "impl-design",
      "confidence": 0.9
    }
  ]
}
```

### Example B (hobby × public)

Input:

> Rewrote the article opening again. Third-person "the developer" reads flat for this blog --
> switching to direct address with a more provocative, conversational tone matches what
> actually gets read. Keep that voice going forward for this series.

Output:

```json
{
  "cards": [
    {
      "situation": "Drafting an article opening for this blog series",
      "judgment": "Address the reader directly in a conversational, provocative tone rather than third-person narration",
      "rationale": "Third-person narration read flat; direct address matched the engagement this series actually gets",
      "tags": ["writing", "voice", "editorial"],
      "domain": "hobby",
      "visibility": "public",
      "category": "writing",
      "confidence": 0.8
    }
  ]
}
```

### Example C (work × sensitive) -- generalize away the identifying specifics, don't discard the judgment

Input -- contains a specific client name, a named teammate's disagreement, and that client's
internal deadline:

> [Client X] wanted the rollout done over a weekend to hit their internal deadline. [Teammate Y]
> pushed back and we agreed to phase it over two weeks with a canary group instead, since a
> weekend rollout leaves no one available if something breaks quietly on Sunday night.

Output:

```json
{
  "cards": [
    {
      "situation": "A stakeholder wants a risky rollout compressed to fit an external deadline",
      "judgment": "Phase the rollout over a longer window with a canary group instead of compressing it to meet the deadline",
      "rationale": "A compressed rollout window (e.g. over a weekend) leaves no one available to catch a quiet failure before it compounds",
      "tags": ["rollout", "risk", "scheduling"],
      "domain": "work",
      "visibility": "sensitive",
      "category": "ops-lifecycle",
      "confidence": 0.75
    }
  ]
}
```

Note what changed: the client name, the named teammate, and the reference to their internal
deadline are gone. The
transferable judgment (don't compress a risky rollout to hit an external deadline) survives.
Mark it `sensitive` because it still traces to a specific client relationship even after
generalizing -- when in doubt, sensitive.

### Example D (work × public, issue discovery)

Input:

> The batch has failed three times this month. The immediate error changes each time, but
> each failure starts after a manual schema edit. The issue is not the individual errors;
> we need a migration review gate before manual edits can reach production.

Output:

```json
{
  "cards": [
    {
      "situation": "A recurring batch failure appears after manual schema edits, even though the immediate error varies",
      "judgment": "Treat the missing migration review gate as the issue and require review before manual schema edits reach production",
      "rationale": "The changing immediate errors share the upstream cause of unreviewed schema edits, so fixing each error separately will not prevent recurrence",
      "tags": ["issue-discovery", "schema", "prevention"],
      "domain": "work",
      "visibility": "public",
      "category": "issue-discovery",
      "confidence": 0.9
    }
  ]
}
```

### Non-example -- discard, do not card-ify

Input:

> Deployed the nightly batch job at 2am. It ran for 12 minutes and processed 4,300
> records with no errors.

Output:

```json
{"cards": []}
```

This input is a status report with no fork in the road -- there was no other reasonable
action being weighed. Do not emit a card for it.

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

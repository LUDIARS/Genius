# Judgment-card distillation

Return one JSON object shaped as `{ "cards": [...] }`. Each card must contain:
`situation`, `judgment`, `rationale`, `tags`, `domain`, `visibility`, and `confidence`.

Extract only counterfactual decisions: a situation where more than one reasonable action was
possible, the action the author chose or would choose, and the reason for that choice. Discard
status reports, event summaries, facts, commands without rationale, and duplicated statements.
Generalize the situation so it transfers to future work while preserving the concrete decision.

## Gold standard: write like a "Why / How to apply" note, not a summary

The best cards read like a rule a colleague left behind, not a description of what happened.
`judgment` is the rule itself, stated as an instruction. `rationale` is the "Why" — the concrete
reason or incident that justifies the rule. `situation` is the "How to apply" — the trigger
conditions under which the rule should fire, generalized away from this one instance. If you
cannot state a rule someone could follow next time, it is not a judgment card.

### Example A (work × public)

Input document (excerpt):
> We stopped mocking the database in the integration suite. Mocked tests were green but the
> migration that shipped last week broke prod because the mock never enforced the same
> uniqueness constraint the real table did. From now on, anything that exercises schema or
> migration behavior runs against a real (test) database, not a mock.

Output:
```json
{
  "situation": "Writing or reviewing an integration test that exercises database schema or migration behavior.",
  "judgment": "Run the test against a real (test) database instance, not a mock.",
  "rationale": "A mocked database can silently diverge from real constraints; a mocked suite stayed green while a migration broke production because the mock didn't enforce the same uniqueness constraint the real table did.",
  "tags": ["testing", "database", "migration"],
  "domain": "work",
  "visibility": "public",
  "confidence": 0.9
}
```

### Example B (hobby × public)

Input document (excerpt):
> Rewrote the article opening again. Third-person "the developer" reads flat for this blog —
> switching to direct "you/君" address with a more provocative, conversational tone matches what
> actually gets read. Keep that voice going forward for this series.

Output:
```json
{
  "situation": "Drafting an article opening for this blog series.",
  "judgment": "Address the reader directly (\"you\") in a conversational, provocative tone rather than third-person narration.",
  "rationale": "Third-person narration read flat; direct address matched the engagement this series actually gets.",
  "tags": ["writing", "voice", "editorial"],
  "domain": "hobby",
  "visibility": "public",
  "confidence": 0.8
}
```

### Example C (work × sensitive) — generalize away the identifying specifics, don't discard the judgment

Input document (excerpt) — contains a specific client name, contract detail, and a named
teammate's disagreement:
> [Client X] wanted the rollout done over a weekend to hit their internal deadline. [Teammate Y]
> pushed back and we agreed to phase it over two weeks with a canary group instead, since a
> weekend rollout leaves no one available if something breaks quietly on Sunday night.

Output:
```json
{
  "situation": "A stakeholder wants a risky rollout compressed to fit an external deadline.",
  "judgment": "Phase the rollout over a longer window with a canary group instead of compressing it to meet the deadline.",
  "rationale": "A compressed rollout window (e.g. over a weekend) leaves no one available to catch a quiet failure before it compounds.",
  "tags": ["rollout", "risk", "scheduling"],
  "domain": "work",
  "visibility": "sensitive",
  "confidence": 0.75
}
```
Note what changed: the client name, the named teammate, and the exact deadline are gone. The
transferable judgment (don't compress a risky rollout to hit an external deadline) survives.
Mark it `sensitive` because it still traces to a specific client relationship even after
generalizing — when in doubt, sensitive.

### Non-example — discard, do not card-ify

Input document (excerpt):
> Deployed v1.2 to production at 14:03. Ran the migration, restarted the workers, confirmed
> health checks green.

This is a status report with no fork in the road — there was no other reasonable action being
weighed. Do not emit a card for it.

## Four-quadrant classification

Two independent flags: `domain: work|hobby` and `visibility: public|sensitive`.

- `domain=work`: the decision concerns a job, client, project, or professional collaborator.
- `domain=hobby`: the decision concerns personal projects, creative work, or non-professional life.
- `visibility=public`: the complete card — situation, judgment, and rationale together — would
  stay safe and non-identifying if shared outside this project entirely.
- `visibility=sensitive`: any part of the card still traces back to a specific person, client,
  organization, incident, or private circumstance, even after generalizing. **When uncertain,
  use `sensitive`.**

## Never copy identifying details into a card

Never copy names, email addresses, credentials, tokens, private URLs, absolute filesystem paths,
customer or school identifiers, or other identifying details into a card. Generalize the
situation instead of naming who or what was involved (see Example C). Do not invent missing
reasoning. `confidence` is 0 through 1.

Return raw JSON only, without Markdown fences or commentary.

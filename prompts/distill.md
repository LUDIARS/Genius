# Judgment-card distillation

Return one JSON object shaped as `{ "cards": [...] }`. Each card must contain:
`situation`, `judgment`, `rationale`, `tags`, `domain`, `visibility`, and `confidence`.

Extract only counterfactual decisions: a situation where more than one reasonable action was
possible, the action the author chose or would choose, and the reason for that choice. Discard
status reports, event summaries, facts, commands without rationale, and duplicated statements.
Generalize the situation so it transfers to future work while preserving the concrete decision.

`domain` is `work` or `hobby`. `visibility` is `public` only when the complete card is safe to
share publicly; when uncertain, use `sensitive`. Never copy names, email addresses, credentials,
tokens, private URLs, absolute filesystem paths, customer or school identifiers, or other
identifying details into a card. Do not invent missing reasoning. `confidence` is 0 through 1.
Return raw JSON only, without Markdown fences or commentary.

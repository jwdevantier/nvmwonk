# Testing

SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
SPDX-License-Identifier: BSD-2-Clause

The docx sources are confidential working-group material (not versioned), so
there are no fixtures in the repo - testing runs against the *current* XML.

## How we test

- **Main tier: `eval.py`** - an LLM-judged assertion suite. Each scenario in
  `assertions.json` cuts XPath *slices* from the XML; a blind judge (explicit
  `--model`, never sees expectations) answers YES/NO per statement with
  verbatim evidence; eval.py computes `OK iff (answer==YES) == expect`.
  The XML is fixed across retries, so extraction regressions fail every
  attempt while judge flakes do not - malformed responses are retried
  (max 3), wrong answers re-run the scenario (`--retry N`, default 1), and
  recovered flakes stay visible as annotations.
- **Tripwire (local only): re-extract and diff** against a stored golden
  XML. Byte-exact, catches everything, but only within one docx revision.
- Run the full suite after any extractor change:

  ```bash
  nix develop --command python3 eval.py --model '<provider/model-id>'
  ```

  One judge model per run; a second model is a *jury mode* second opinion,
  not mixed into the same run.

## Writing a good assertion

- Anchor on stable text - captions, headings, names, tokens - never on
  figure/section numbers; those shift between document revisions.
- Pin facts positively: "the last row consists of a single cell", never
  loose quantifiers ("at least one row ...") - they invite scan-and-miscount.
- One fact per statement. Verify ground truth by direct XPath before
  writing `expect:true` - never derive it from the extractor's output.
- Notation: `'...'` = literal (character-by-character), `~...~` = paraphrase
  (names/numbers inside still exact), unmarked = judged as written.
- Judges do not do strict string semantics: 'is exactly X' gets read as
  'mentions X', 'starts with X' gets applied to the title after the section
  number (observed on qwen). Quote the full expected string and state the
  relationship plainly ('includes the heading `5.3.1.2 32b Guard Protection
  Information`'); save absence checks for canaries with explicit qualifiers
  ('with no section number before the `16b`').
- Add canaries: `expect:false` near-misses (names that exist elsewhere in
  the document but not in the slice) punish judges answering from vibes.
- A statement that keeps flaking on retries needs surgery - reword or
  delete; don't defend near-zero-coverage traps.

## On error: debugging

Exit codes: `0` all OK · `1` assertion/judge-format failure ·
`2` mechanical (bad XPath, missing doc, harness bug) or interrupted
mid-run (results incomplete).

1. Re-run just the failing scenario, with a dump dir:

   ```bash
   nix develop --command python3 eval.py --model '<model>' \
       --scenario NAME --dump-dir /tmp/eval
   ```

2. Read the statement's `evidence` field first:
   - evidence *is* the intended fact, answer mismatches → judge/statement
     problem (ambiguous wording), not extraction;
   - evidence genuinely absent from the slice → extraction regression;
   - unclear → jury mode: re-run with a second `--model`.
3. Inspect the dump: `NAME.prompt.txt` is the exact prompt (slices +
   statements) the judge saw; `NAME.response.txt` (and `.response-2.txt`,
   `-3.txt`, ... for retries) are the raw judge outputs.
4. Check ground truth directly against the XML (`query.py`, spec tools)
   before changing anything.
5. Don't re-roll until green: a persistent `ERROR (wrong on all N
   attempts)` is a strong signal - understand it first. Statement-level
   re-rolls are what `--retry` already automates.

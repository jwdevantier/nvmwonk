# DEV

SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
SPDX-License-Identifier: BSD-2-Clause

Internal notes for working on nvmwonk itself: the assertion suite, how
statements are interpreted by the judge LLM, and how to re-extract
fixtures after changes.

## Testing: `eval.py`

`eval.py` runs an LLM-judged assertion suite against the extracted XML
(`assertions.json` holds the scenarios):

```bash
python3 eval.py --model 'provider/model-id'                           # full suite
python3 eval.py --model 'provider/model-id' --scenario oaes-rlcc-bit  # one scenario
python3 eval.py --dry-run                # prompts only, no LLM calls, no --model needed
python3 eval.py --model 'other/model-id' # second opinion (jury mode)
python3 eval.py --dump-dir /tmp/eval     # save prompts/responses for triage
python3 eval.py --retry 0                # no answer retries, single attempt per scenario
```

`--model` is required for evaluation runs - the judge must be explicit,
no silent defaults: invoked without it, eval.py prints `pi
--list-models` and an error. The pattern is passed straight through to
`pi --model`.

Each scenario cuts one or more **slices** (XPath against a named doc),
sends them with plain-language statements to a judge LLM via
`pi -p --no-tools …` (blind: the judge never sees expected answers),
and compares the judge's YES/NO + verbatim evidence against
expectations:

- verdict is computed by `eval.py`, not the model: `OK iff (answer==YES) == expect`
- canaries are `expect:false` **near-misses** (names that exist elsewhere
  in the document but not in the judged slice - e.g. `RLCCN` in the
  OAES table) to punish judges that answer from vibes instead of from
  the slice
- slices anchor on stable text (captions, headings, names, tokens),
  never on figure/section numbers, which shift between document
  revisions

Exit codes: 0 all OK; 1 assertion or judge-format failures; 2
mechanical errors (bad XPath, missing doc, judge call failed) or
interrupted mid-run (results incomplete).

**Retries.** Malformed judge responses (unparseable JSON, missing or
duplicated ids, invalid answers, YES without evidence) are never
accepted: the same prompt is retried with the same model, up to 3
attempts per scenario. Wrong answers re-run the scenario up to
`--retry N` times (default 1): a statement passes if **any** attempt
judged it correctly. Extraction regressions fail every attempt - the
XML never changes between retries - while judge flakes do not; retried
statements are annotated (`wrong on attempt(s) 1, passed on attempt
2`) so the noise stays visible. With `--dump-dir`, later attempts are
saved as `NAME.response-2.txt`, `NAME.response-3.txt`, … next to the
first `NAME.response.txt`.

## Statement notation

Statements use a small notation to declare how strictly each claim
should be read (the judge is taught the same rules):

- `'single-quoted'` spans are **literal**: matched character by
  character, with markup tags transparent - `'29h to 77h'` matches
  `<tbd>29</tbd>h to 77h`
- `~tilded~` spans are **paraphrase**: matched by meaning, wording may
  differ; names and numbers inside still read exactly (`~RLCC~` never
  matches RLCCN)
- unmarked statements (counts, structure, markup claims) are judged
  as written

Authoring conventions: names, numbers and identifiers always go in
`'...'`; `~...~` is for prose claims; canaries (expect-false
near-misses) are literal absence claims. Prefer pinning facts
positively ("the last row consists of a single cell") over loose
quantifiers ("at least one row…") - the latter make judges scan and
miscount.

## Regenerating fixtures

After editing `nvmwonk.py` or updating a `.docx`, re-extract and
re-run the suite:

```bash
nix develop --command python3 nvmwonk.py extract INPUT.docx OUTPUT.xml [-i ID] [-t TITLE]
nix develop --command python3 eval.py --model 'provider/model-id'
```

(The pi extension does the extraction automatically when the xml is
missing or the docx is newer — see `extensions/pi/README.md`.)
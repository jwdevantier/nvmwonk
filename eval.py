#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
#
# SPDX-License-Identifier: BSD-2-Clause

"""
eval.py - LLM-judged assertion suite for extracted NVMe spec XML.

Each scenario in the assertions file cuts one or more slices (XPath
expressions against named documents), then hands the serialized slices plus
a list of statements to a judge LLM:

    pi -p --no-tools --no-extensions --no-session --no-skills \
        --no-context-files --no-prompt-templates \
        --system-prompt <judge persona>  <message: slices + statements>

The judge answers YES/NO per statement (with verbatim evidence) as JSON.
Expected answers live only in the assertions file - the judge never sees
them (blind judging: nothing to be agreeable to). eval.py computes:

    verdict = (answer == YES) == expect

Canary statements (expect:false near-misses - names that exist elsewhere in
the document but not in the judged slice) punish judges that answer from
vibes instead of from the slice.

Malformed judge responses are never accepted: the same prompt is retried
with the same model (max 3 attempts per scenario). Wrong answers re-run
the scenario up to --retry times (default 1): a statement counts as OK if
any attempt judged it correctly - extraction regressions fail every
attempt (the XML never changes), judge flakes do not.

Usage:
  eval.py [assertions.json] --model PATTERN [options]

Options:
  --model PATTERN   judge model - REQUIRED for evaluation runs; passed
                    straight through to pi --model (e.g. 'provider/model-id').
                    Omitted: prints `pi --list-models` + an error, exit 2.
                    Not needed for --dry-run / --list.
  --scenario NAME   run only this scenario (repeatable)
  --retry N         re-run scenarios with wrong answers N times
                    (default 1; 0 disables)
  --timeout SECS    per judge call (default 300)
  --budget BYTES    per-slice serialization budget (default 40000)
  --dry-run         print slice stats and the exact judge prompts, no LLM
  --dump-dir DIR    write per-scenario prompt/response files for triage
  --list            list scenarios and exit

Exit codes: 0 all statements OK; 1 assertion or judge-format failures;
2 mechanical errors (bad input, XPath error, missing doc, judge call failed)
or interrupted mid-run (results incomplete).

The assertions file format (see assertions.json):

  {"scenarios": [{"name": ..., "note": ...,
                  "slices": [{"label": ..., "doc": ..., "xpath": ...}],
                  "statements": [{"id": "A1", "statement": ..., "expect": true}]}]}
"""

import argparse
import json
import os
import re
import subprocess
import sys

from lxml import etree

from nvmwonk import NSMAP, breadcrumb, load, result_element

DEFAULT_BUDGET = 40000
DEFAULT_TIMEOUT = 300
MAX_FORMAT_ATTEMPTS = 3  # malformed responses per scenario before giving up

JUDGE_CONTRACT = """Respond with ONLY a JSON object (no prose, no code fences):
{"results": [{"id": "A1", "answer": "YES", "evidence": "verbatim quote"}, {"id": "A2", "answer": "NO", "evidence": ""}]}
- one entry per statement id, each id exactly once
- "answer" is exactly "YES" or "NO"
- "evidence": short verbatim quote from the data proving a YES (about 200 chars max); "" for NO
- you may add a "note" field to flag ambiguity; it does not affect grading"""

JUDGE_SYSTEM_PROMPT = """You are a meticulous verifier of XML data extracted from NVMe specification documents. You will be given labeled data slices and a list of numbered statements. Judge each statement strictly against the data provided - nothing else.

Rules:
- Judge ONLY from the provided slices: they are your entire universe. Do not use knowledge of the NVMe specifications and do not assume anything about documents you are not shown.
- Answer YES only if the slice data supports the statement; otherwise answer NO. When in doubt, answer NO.
- Read names and numbers exactly, character by character. RLCC, RLCCN and RLCX are three different names; "bit 22" and "bit 23" are different claims. A statement about a name that does not appear in the referenced slice is false even if a similar name appears elsewhere in the data.
- A statement about a specific labeled slice is false unless the supporting data is in that slice.
- An empty slice (0 matches) supports no positive statement about its contents.
- Attributes count as data: caption="...", heading="...", added="true" are all visible to you.
- Inline markup has specific meanings: <content added="true"> marks newly added text; <tbd> marks a value to be assigned at integration time; <note> marks an editor note. Markup elements contribute their inner text to the surrounding text: <tbd>42</tbd>h reads '42h'.
- Statement notation marks how strictly a claim is to be read:
  - 'single-quoted' spans are LITERAL: match character by character within a single element's text or a single attribute value; markup tags are transparent, but a literal is never stitched across separate cells or attributes.
  - ~tilded~ spans are PARAPHRASE: the slice must contain text conveying the same meaning, wording may differ; names and numbers inside are still read exactly (RLCC never matches RLCCN).
  - Unmarked statements (counts, structure, markup claims) are judged as written.

Output format:
""" + JUDGE_CONTRACT


class SliceError(Exception):
    """Mechanical slice failure (bad XPath, missing doc) - no LLM call spent."""


# ── assertions file ────────────────────────────────────────────────────────

def load_assertions(path):
    """Parse + validate; returns (scenarios, base_dir).
    doc paths resolve relative to the assertions file's directory."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if (not isinstance(data, dict)
            or not isinstance(data.get("scenarios"), list)
            or not data["scenarios"]):
        raise ValueError("assertions file must be an object with a non-empty"
                         " 'scenarios' array")
    base_dir = os.path.dirname(os.path.abspath(path))
    names = set()
    scenarios = []
    for i, sc in enumerate(data["scenarios"]):
        if not isinstance(sc, dict):
            raise ValueError(f"scenario #{i + 1} is not an object")
        name = sc.get("name") or f"scenario-{i + 1}"
        if name in names:
            raise ValueError(f"duplicate scenario name: {name}")
        names.add(name)
        where = f"scenario {name}"

        slices = sc.get("slices")
        if not isinstance(slices, list) or not slices:
            raise ValueError(f"{where}: 'slices' must be a non-empty array")
        labels = set()
        for sl in slices:
            for key in ("label", "doc", "xpath"):
                if not isinstance(sl.get(key), str) or not sl[key].strip():
                    raise ValueError(f"{where}: slice needs non-empty string"
                                     f" {key!r}")
            if sl["label"] in labels:
                raise ValueError(f"{where}: duplicate slice label"
                                 f" {sl['label']!r}")
            labels.add(sl["label"])

        statements = sc.get("statements")
        if not isinstance(statements, list) or not statements:
            raise ValueError(f"{where}: 'statements' must be a non-empty"
                             " array")
        ids = set()
        norm = []
        for j, st in enumerate(statements):
            if (not isinstance(st, dict)
                    or not isinstance(st.get("statement"), str)
                    or not st["statement"].strip()):
                raise ValueError(f"{where}: statement #{j + 1} needs non-empty"
                                 " 'statement'")
            if not isinstance(st.get("expect"), bool):
                raise ValueError(f"{where}: statement #{j + 1} needs boolean"
                                 " 'expect'")
            sid = st.get("id") or f"A{j + 1}"
            if sid in ids:
                raise ValueError(f"{where}: duplicate statement id {sid!r}")
            ids.add(sid)
            norm.append({"id": sid, "statement": st["statement"],
                         "expect": st["expect"]})

        scenarios.append({"name": name, "note": sc.get("note"),
                          "slices": slices, "statements": norm})
    return scenarios, base_dir


# ── slice cutting ──────────────────────────────────────────────────────────

class Slicer:
    def __init__(self, base_dir, budget):
        self.base_dir = base_dir
        self.budget = budget
        self._trees = {}

    def _tree(self, doc):
        path = doc if os.path.isabs(doc) else os.path.join(self.base_dir, doc)
        if path not in self._trees:
            if not os.path.exists(path):
                raise SliceError(f"document not found: {doc}"
                                 f" (looked for {path})")
            self._trees[path] = load(path)
        return self._trees[path]

    def cut(self, sl):
        """Evaluate one slice spec -> (block_text, n_matches, n_shown, bytes)."""
        docname = os.path.basename(sl["doc"])
        tree = self._tree(sl["doc"])
        try:
            hits = tree.xpath(sl["xpath"], namespaces=NSMAP)
        except etree.XPathError as e:
            raise SliceError(f"XPath error in slice {sl['label']!r}: {e}")
        if not isinstance(hits, list):  # count()/boolean() -> scalar
            hits = [hits]

        chunks, total = [], 0
        truncated = False
        for hit in hits:
            chunk = self._serialize(hit, docname)
            if chunks and total + len(chunk) > self.budget:
                truncated = True
                break
            chunks.append(chunk)
            total += len(chunk)

        lines = [f"=== SLICE: {sl['label']} (doc: {docname}) ===",
                 f"xpath: {sl['xpath']}",
                 f"matches: {len(hits)}"]
        if truncated:
            lines.append(f"NOTE: only the first {len(chunks)} of {len(hits)}"
                         " matches are shown (size budget). Anything absent"
                         " from the shown matches cannot be judged present.")
        lines.extend(chunks if chunks else ["(no results)"])
        lines.append(f"=== END SLICE: {sl['label']} ===")
        return "\n".join(lines), len(hits), len(chunks), total

    def _serialize(self, hit, docname):
        if isinstance(hit, etree._Element):
            return etree.tostring(result_element(hit, docname),
                                  pretty_print=True).decode()
        if isinstance(hit, etree._ElementUnicodeResult):
            res = etree.Element("result", doc=docname)
            parent = hit.getparent()
            if parent is not None:
                res.append(breadcrumb(parent))
            attrname = getattr(hit, "attrname", None)
            if attrname:
                etree.SubElement(res, "attribute", name=attrname,
                                 value=str(hit))
            else:
                etree.SubElement(res, "text").text = str(hit)
            return etree.tostring(res, pretty_print=True).decode()
        # boolean / number result
        res = etree.Element("result", doc=docname)
        v = etree.SubElement(res, "value")
        if isinstance(hit, bool):
            v.text = "true" if hit else "false"
        elif isinstance(hit, float) and hit.is_integer():
            v.text = str(int(hit))
        else:
            v.text = str(hit)
        return etree.tostring(res, pretty_print=True).decode()


# ── judge ──────────────────────────────────────────────────────────────────

def build_message(scenario, blocks):
    lines = ["Judge each statement against the data slices below. Statements"
             " refer to slices by their label.", ""]
    lines.extend(blocks)
    lines.append("")
    lines.append("STATEMENTS:")
    for st in scenario["statements"]:
        lines.append(f"{st['id']}: {st['statement']}")
    lines.append("")
    lines.append(JUDGE_CONTRACT)
    return "\n".join(lines)


def show_models_and_error():
    """--model missing on an evaluation run: show `pi --list-models`
    output, then the error below it. Returns exit code 2."""
    print("available models (`pi --list-models`):", file=sys.stderr)
    try:
        r = subprocess.run(["pi", "--list-models"], capture_output=True,
                           text=True, timeout=60)
        if r.stdout.strip():
            print(r.stdout.rstrip(), file=sys.stderr)
        if r.stderr.strip():
            print(r.stderr.rstrip(), file=sys.stderr)
    except FileNotFoundError:
        print("  (pi executable not found on PATH)", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("  (pi --list-models timed out)", file=sys.stderr)
    print(file=sys.stderr)
    print("error: --model is required: the judge model must be explicit -"
          " no silent defaults", file=sys.stderr)
    print("  pick one from the list above, e.g."
          " --model 'provider/model-id'", file=sys.stderr)
    return 2


def run_judge(message, model, timeout):
    cmd = ["pi", "-p", "--no-tools", "--no-extensions", "--no-session",
           "--no-skills", "--no-context-files", "--no-prompt-templates",
           "--system-prompt", JUDGE_SYSTEM_PROMPT]
    if model:
        cmd += ["--model", model]
    cmd.append(message)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "judge call timed out"
    except FileNotFoundError:
        return None, "pi executable not found on PATH"
    if r.returncode != 0:
        return None, f"pi exited {r.returncode}: {r.stderr.strip()[:300]}"
    out = r.stdout.strip()
    if not out:
        return None, "pi produced no output"
    return out, None


def parse_verdicts(raw, expected_ids):
    """-> (answers, problems, extra_ids); answers None => whole response
    unparseable (problems holds the error message)."""
    text = raw.strip()
    if text.startswith("```"):  # tolerate code fences
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    obj = None
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)  # salvage outermost braces
        if m:
            try:
                obj = json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    if not isinstance(obj, dict) or not isinstance(obj.get("results"), list):
        return None, "response is not a JSON object with a 'results' array", []
    expected = set(expected_ids)
    answers, problems, extras = {}, {}, []
    for entry in obj["results"]:
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("id", "")).strip()
        ans = str(entry.get("answer", "")).strip().upper()
        ev = str(entry.get("evidence") or "")
        note = str(entry.get("note") or "")
        if sid not in expected:
            extras.append(sid or "<no id>")
        elif sid in answers:
            problems[sid] = "duplicate id in response"
        elif ans not in ("YES", "NO"):
            problems[sid] = f"invalid answer {str(entry.get('answer'))!r}"
        elif ans == "YES" and not ev.strip():
            problems[sid] = "YES answer without evidence"
        else:
            answers[sid] = (ans, ev, note)
    for sid in expected_ids:
        if sid not in answers and sid not in problems:
            problems[sid] = "missing from response"
    return answers, problems, extras


# ── scenario execution + reporting ─────────────────────────────────────────

def dump_response(dump_dir, name, call_no, raw):
    """Attempt 1 keeps the plain name; later attempts get -2, -3, ..."""
    if not dump_dir:
        return
    os.makedirs(dump_dir, exist_ok=True)
    fname = (f"{name}.response.txt" if call_no == 1 else
             f"{name}.response-{call_no}.txt")
    with open(os.path.join(dump_dir, fname), "w", encoding="utf-8") as f:
        f.write(raw)


def run_scenario(sc, slicer, model, timeout, dry_run, dump_dir, retry):
    """-> {"slice_stats": [...], "results"|"message"|"mechanical"|
    "format_failure": ...}   ("message" = dry-run: the judge prompt)

    Malformed responses are retried (same prompt, same model) up to
    MAX_FORMAT_ATTEMPTS times; wrong answers re-run the scenario up to
    `retry` times. A statement counts as OK if any accepted attempt
    judged it correctly."""
    blocks, stats = [], []
    for sl in sc["slices"]:
        try:
            block, n, shown, size = slicer.cut(sl)
        except SliceError as e:
            return {"mechanical": str(e)}
        blocks.append(block)
        stats.append((sl["label"], os.path.basename(sl["doc"]), n, shown, size))

    message = build_message(sc, blocks)
    if dump_dir:
        os.makedirs(dump_dir, exist_ok=True)
        with open(os.path.join(dump_dir, sc["name"] + ".prompt.txt"), "w",
                  encoding="utf-8") as f:
            f.write(message)

    if dry_run:
        return {"slice_stats": stats, "message": message}

    expected_ids = [st["id"] for st in sc["statements"]]
    expects = {st["id"]: st["expect"] for st in sc["statements"]}
    attempts = []          # accepted responses: [{sid: (ans, ev, note)}]
    format_failures = 0    # malformed responses seen so far
    n_answer_retries = 0   # answer-retries used so far
    n_format_retries = 0   # malformed responses retried (not fatal)
    call_no = 0

    while True:
        raw, err = run_judge(message, model, timeout)
        if err:
            return {"mechanical": f"judge error: {err}"}
        call_no += 1
        dump_response(dump_dir, sc["name"], call_no, raw)

        answers, problems, extras = parse_verdicts(raw, expected_ids)
        if answers is None or problems:
            format_failures += 1
            if format_failures >= MAX_FORMAT_ATTEMPTS:
                if isinstance(problems, str):
                    last = problems
                else:
                    last = "; ".join(f"{sid}: {msg}"
                                     for sid, msg in problems.items())
                return {"format_failure":
                        f"malformed judge responses in {format_failures}"
                        f" attempts, last: {last}"}
            n_format_retries += 1
            continue  # same prompt, fresh sample

        attempts.append(answers)
        wrong = [sid for sid in expected_ids
                 if (answers[sid][0] == "YES") != expects[sid]]
        if not wrong or n_answer_retries >= retry:
            break
        n_answer_retries += 1

    results = []
    for st in sc["statements"]:
        sid = st["id"]
        oks = [(a[sid][0] == "YES") == st["expect"] for a in attempts]
        ans, ev, note = attempts[-1][sid]  # report the latest sample
        ok = any(oks)
        r = {**st, "answer": ans, "evidence": ev, "note": note,
             "verdict": "OK" if ok else "ERROR"}
        wrong_at = [str(i + 1) for i, o in enumerate(oks) if not o]
        if ok and wrong_at:
            first_ok = oks.index(True) + 1
            r["flake"] = (f"wrong on attempt(s) {','.join(wrong_at)},"
                          f" passed on attempt {first_ok}")
        elif not ok:
            r["flake"] = f"wrong on all {len(oks)} attempt(s)"
        results.append(r)

    out = {"slice_stats": stats, "results": results,
           "answer_retries": n_answer_retries,
           "format_retries": n_format_retries}
    if extras:
        out["extra_ids"] = extras
    return out


def print_header(idx, total, sc):
    pad = max(3, 62 - len(sc["name"]) - len(str(idx)) - len(str(total)))
    print(f"== [{idx}/{total}] {sc['name']} " + "=" * pad)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="LLM-judged assertion suite for extracted spec XML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[1] if __doc__ else None)
    ap.add_argument("assertions", nargs="?", default="assertions.json",
                    help="assertions JSON file (default: assertions.json)")
    ap.add_argument("--scenario", action="append", default=[],
                    metavar="NAME", help="run only this scenario (repeatable)")
    ap.add_argument("--retry", type=int, default=1, metavar="N",
                    help="re-run scenarios with wrong answers N times"
                         " (default 1; 0 disables)")
    ap.add_argument("--model", default=None, metavar="PATTERN",
                    help="judge model, REQUIRED for evaluation runs; passed"
                         " straight through to pi --model")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                    help=f"judge call timeout in seconds (default"
                         f" {DEFAULT_TIMEOUT})")
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET,
                    help=f"per-slice byte budget (default {DEFAULT_BUDGET})")
    ap.add_argument("--dry-run", action="store_true",
                    help="print slice stats and judge prompts, skip the LLM")
    ap.add_argument("--dump-dir", default=None, metavar="DIR",
                    help="write per-scenario prompt/response files for triage")
    ap.add_argument("--list", action="store_true",
                    help="list scenarios and exit")
    args = ap.parse_args(argv)
    if args.retry < 0:
        ap.error("--retry must be >= 0")

    try:
        scenarios, base_dir = load_assertions(args.assertions)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if args.scenario:
        unknown = [s for s in args.scenario
                   if s not in {sc["name"] for sc in scenarios}]
        if unknown:
            print(f"error: unknown scenario(s): {', '.join(unknown)}",
                  file=sys.stderr)
            return 2
        scenarios = [sc for sc in scenarios if sc["name"] in args.scenario]

    if args.list:
        for sc in scenarios:
            n = len(sc["statements"])
            labels = ", ".join(sl["label"] for sl in sc["slices"])
            print(f"{sc['name']:28s} {n:2d} statements  slices: {labels}")
        return 0

    if not args.model and not args.dry_run:
        return show_models_and_error()

    slicer = Slicer(base_dir, args.budget)
    total = len(scenarios)
    tot_ok = tot_err = 0
    n_format_failed = tot_answer_retries = tot_format_retries = 0
    mechanical, failed = [], []
    dry = args.dry_run
    interrupted = False

    for idx, sc in enumerate(scenarios, 1):
        print_header(idx, total, sc)
        if sc.get("note") and not dry:
            print(f"  note: {sc['note']}")
        try:
            out = run_scenario(sc, slicer, args.model, args.timeout,
                               dry, args.dump_dir, args.retry)
        except KeyboardInterrupt:
            print("  -- interrupted --", file=sys.stderr)
            interrupted = True
            break

        for label, doc, n, shown, size in out.get("slice_stats", []):
            trunc = "" if shown >= n else f"  [TRUNCATED {shown}/{n}]"
            print(f"  slice {label:14s} {doc:14s} {n} match(es)"
                  f"  {size} B{trunc}")
        if dry:
            print("  ---- judge prompt " + "-" * 40)
            print(out["message"])
            print("  ---- statements with expectations (author view) ----")
            for st in sc["statements"]:
                exp = "YES" if st["expect"] else "NO"
                print(f"  {st['id']:5s} [expect {exp}] {st['statement']}")
            print()
            continue

        if "mechanical" in out:
            print(f"  MECHANICAL-ERROR: {out['mechanical']}")
            mechanical.append(sc["name"])
            print()
            continue

        if "format_failure" in out:
            print(f"  FORMAT-FAILURE: {out['format_failure']}")
            failed.append(sc["name"])
            n_format_failed += 1
            print()
            continue

        for r in out["results"]:
            exp = "YES" if r["expect"] else "NO"
            if r["verdict"] == "OK":
                line = (f"  {r['id']:5s} {r['answer']:4s} expected {exp:3s}"
                        f"  OK")
            else:
                line = (f"  {r['id']:5s} {r['answer']:4s} expected {exp:3s}"
                        f"  ERROR   evidence: {r['evidence'][:120]!r}")
            if r.get("flake"):
                line += f"  ({r['flake']})"
            print(line)
            if r.get("note"):
                print(f"        note: {r['note'][:120]}")
        if out.get("extra_ids"):
            print(f"  judge returned unknown ids: {out['extra_ids']}")

        n_ok = sum(1 for r in out["results"] if r["verdict"] == "OK")
        n_err = sum(1 for r in out["results"] if r["verdict"] == "ERROR")
        tot_ok += n_ok
        tot_err += n_err
        tot_answer_retries += out.get("answer_retries", 0)
        tot_format_retries += out.get("format_retries", 0)
        n_all = len(out["results"])
        if n_err:
            failed.append(sc["name"])
        retr = []
        if out.get("answer_retries"):
            retr.append(f"{out['answer_retries']} answer")
        if out.get("format_retries"):
            retr.append(f"{out['format_retries']} format")
        suffix = f"  [retried: {' + '.join(retr)}]" if retr else ""
        print(f"  -> {n_ok}/{n_all} OK{suffix}\n")

    # ── summary ──
    if dry:
        print(f"[dry run] {total} scenario(s), no LLM calls made")
        return 0
    n_stmt = tot_ok + tot_err
    print(f"SUMMARY: {len(scenarios)} scenario(s), {tot_ok}/{n_stmt}"
          f" statements OK"
          + (f", {tot_err} ERROR" if tot_err else "")
          + (f", {n_format_failed} format-failed" if n_format_failed else "")
          + (f", {len(mechanical)} mechanical" if mechanical else ""))
    if tot_answer_retries or tot_format_retries:
        print(f"retries: {tot_answer_retries} answer,"
              f" {tot_format_retries} format")
    if failed:
        print("FAILED: " + ", ".join(failed))
    if mechanical:
        print("MECHANICAL: " + ", ".join(mechanical))
    if interrupted:
        print("INTERRUPTED: incomplete run - results above are partial")
        return 2
    if mechanical:
        return 2
    return 0 if (tot_err or n_format_failed) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

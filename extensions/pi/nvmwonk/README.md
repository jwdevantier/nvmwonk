# pi / nvmwonk spec tools

A set of tools for the [pi](https://github.com/earendil-works/pi-mono)
harness, built on top of [nvmwonk](../../nvmwonk.py) — a CLI for
parsing and querying NVMe specifications and technical proposals (TPs).
Drop this directory into your project's `extensions/` (or symlink it)
and the tools appear in your pi session.

## Summary

You're meant to refer to documents in chat ("look at TP4176", "what
does §5.1 of the base spec say about ANA?"), and the extension makes
that work. When you point the agent at a `.docx`, it calls
`spec_register` to parse the doc into structured XML and add an entry
to the manifest; from then on, queries against that document work by
key.

The manifest supports **multiple documents under the same key with
different versions** — e.g. `BASE@2.3` and `BASE@2.4` registered
side-by-side. A bare key (`BASE`) resolves when only one revision is
registered; with several, the agent must qualify with `@VERSION` or
the tool errors out listing what's available.

## Install

- **Temporary**, single session:
  ```
  pi -e <path>/extensions/pi/nvmwonk
  ```
- **Permanent**: copy (or symlink) the extension directory into pi's
  extensions folder. On Linux that's
  `~/.pi/agent/extensions/`; ask pi for the right path on your
  platform. Example:
  ```
  cp -rfa extensions/pi/nvmwonk ~/.pi/agent/extensions/
  ```

## Finding nvmwonk

The extension resolves the `nvmwonk` binary on every tool call, in
this order:

1. `$NVMWONK_BIN` (full path to either a built binary or a `.py`
   script) — explicit override wins
2. `nvmwonk` on `PATH`

If neither resolves, the tool returns a clear error in the chat — not
an empty tool row — so both you and the LLM can see it and react.

## Per-user state

Spec documents (`.docx`) are working-group material — each user must
obtain them. They are never committed.

The extension stores per-user state under `extensionStateDir()`
(XDG-compliant on Linux, `~/Library/Application Support` on macOS,
`%APPDATA%` on Windows):

```
<stateDir>/
├── documents.json   registry (per-user)
└── docs/            copied .docx + derived .xml
```

## Addressing

- `key` — short identifier chosen by the user (`BASE`, `NVM`,
  `TP4176`). Matched case-insensitively.
- `KEY@VERSION` — e.g. `BASE@2.3`. A bare key works when only one
  revision is registered; if several are, the error lists them.
- `docx` → `xml` by extension swap (`docs/foo.docx` → `docs/foo.xml`).
  Extraction runs on first request that needs the doc, and whenever
  the `docx` is newer than the `xml` (mtime staleness).
- The user-supplied source path is **never stored** — `spec_register`
  copies the `.docx` into `<stateDir>/docs/` first.

## Manifest

```json
{
  "documents": [
    { "key": "BASE", "version": "2.3", "file": "docs/base-2.3.docx" },
    { "key": "TP4176", "version": "4176", "file": "docs/tp4176.docx",
      "id": "4176", "title": "Rate Limiting" }
  ]
}
```

- `file` — relative to `<stateDir>`, always starts with `docs/`.
- `id`, `title` (optional) — passed to `nvmwonk extract`; TPs need both
  (they become the `id`/`title` attributes on the document root).

## Lifecycle

```
obtain the docx (anywhere)
  → spec_register:  copy into <stateDir>/docs/, write manifest entry, extract
  → later queries:  extract runs automatically if xml missing or stale
```

If the `docx` is missing but the `xml` is present, queries still work
(re-extraction is simply impossible). If both are missing, tools name
the expected path.

## pi tools

- `spec_docs` — list registered docs + state-dir paths
- `spec_register` — copy a `.docx` into the state dir, write manifest
  entry, extract
- `spec_figures`, `spec_figure_get`, `spec_section_get`, `spec_query` —
  one tool per `nvmwonk query` subcommand; `doc` takes keys (`BASE`,
  `NVM`, `BASE@2.3`, comma-separated, or `all` — the default)

Typical conversation: "register `~/Downloads/tp4188.docx` as TP4188,
version 4188, title 'Foo'" — the agent calls `spec_register` and the
document is immediately queryable as `TP4188`.
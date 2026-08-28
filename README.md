# nvmwonk

A CLI for parsing NVMe Technical Proposals and published specifications
(`.docx`) into structured, LLM-friendly XML, plus an XPath query
companion. Also ships as a [pi](https://github.com/earendil-works/pi-mono)
agent extension ([here](./extensions/pi/nvmwonk/)) that lets an LLM refer
to specs in chat and have them parsed and queried on the fly.

## CLI

```bash
# Enter the dev shell (Python + lxml + python-docx)
nix develop

# Parse a .docx into structured XML
python3 nvmwonk.py extract INPUT.docx OUTPUT.xml [-i ID] [-t TITLE]

# Query the XML (one subcommand per query type)
python3 nvmwonk.py query figures FILES...        # list all figures
python3 nvmwonk.py query figure  REF FILES...     # one figure, verbatim
python3 nvmwonk.py query section REF FILES...     # one section, verbatim
python3 nvmwonk.py query xpath 'EXPR' FILES...    # raw XPath 1.0
```

Exit codes: 0 = matched, 1 = no match, 2 = usage/XPath error.

Works for Technical Proposals (TP markup resolved to semantic tags) and
published specs alike: heading numbers and figure numbers are
reconstructed from Word's list numbering / SEQ fields, so a Base
Specification extraction has `3.1.3 Controller Types` and `Figure 31: …`
— the same keys NVMe TPs cross-reference.

## Stand-alone binary

Self-contained single-file executables via PyInstaller:

- `scripts/build.sh` — produces `dist/nvmwonk` for the build host
- `scripts/build-portable.sh` — additionally rewrites the ELF
  interpreter (Nix hosts only) so the binary runs on stock Linux

`nix develop .#bundler` provides a suitable development environment
for running PyInstaller.

## pi extension

`extensions/pi/nvmwonk` exposes the CLI as agent-callable tools
(`spec_docs`, `spec_register`, `spec_figures`, `spec_figure_get`,
`spec_section_get`, `spec_query`). It manages a per-user document
registry and routes queries to `nvmwonk` for parsing and searching.

See `extensions/pi/README.md` for install, configuration, and the
per-user state layout.

## Markup conventions

NVMe TP markup is resolved to a small set of tags:

| Docx formatting | XML |
|---|---|
| Blue text | `<content added="true">` |
| Blue + Yellow highlight | `<tbd>` |
| Red strikethrough | omitted |
| Purple strikethrough | omitted (text moved elsewhere) |
| Purple | `<content added="true">` (moved from elsewhere) |
| Orange | plain text (source TP could not be resolved reliably) |
| Green | `<note>` |

All other formatting (bold, italic, etc.) is stripped, and consecutive
runs with the same marker are merged.

## Schema

```
tp > metadata > title
tp > body > (section | spec-changes | annex)*   — sections nest recursively
  section@heading      e.g. "3.1.3 Controller Types" (numbers reconstructed)
  annex@heading        e.g. "Annex A. Sanitize Operation Considerations (Informative)"
  spec-changes@spec    TP-only, e.g. "NVM Express Base Specification 2.3"
  p                    ordinary paragraphs
  table@caption > row(@header="true")? > cell    tables preserved verbatim
  inline (TPs only): content@added="true", tbd, note, br
```

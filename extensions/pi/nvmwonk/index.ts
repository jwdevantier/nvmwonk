/**
 * SPDX-FileCopyrightText: 2025 Jesper Wendel Devantier <jwd@defmacro.it>
 *
 * SPDX-License-Identifier: BSD-2-Clause
 *
 * Spec Tools - document registry + XPath lookups into the extracted spec XML.
 *
 * Per-user state lives in extensionStateDir() (XDG-compliant on Linux,
 * ~/Library/Application Support on macOS, %APPDATA% on Windows):
 *
 *   <stateDir>/
 *   ├── documents.json   manifest of registered docs (per-user)
 *   └── docs/            copied .docx sources + derived .xml extractions
 *                        (gitignored when in-repo, but in state dir this is moot)
 *
 * The xml is derived by extension swap (x.docx -> x.xml) and extracted
 * automatically on first use or when the docx is newer (mtime staleness check).
 *
 * Tools:
 *   spec_docs      - list registered documents + state-dir paths
 *   spec_register  - copy a docx into <stateDir>/docs/, upsert manifest entry, extract
 *   spec_figures   - nvmwonk query figures
 *   spec_figure_get, spec_section_get, spec_query - nvmwonk query commands
 *
 * The `doc` parameter takes manifest keys: 'BASE', 'TP4176', 'BASE@2.3',
 * a comma-separated list, or 'all' (default). Keys match
 * case-insensitively; a bare key with several revisions errors with the
 * available KEY@VERSION list.
 *
 * nvmwonk.py needs python3 + lxml (this repo's `nix develop` shell, or any
 * python with lxml installed). All query output is XML, passed through from
 * nvmwonk, byte-capped with a truncation notice.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import fs from "node:fs";

const MAX_BYTES = 30 * 1024;

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// Per-user state: manifest + docs live in extensionStateDir(), which respects
// XDG on Linux, ~/Library/Application Support on macOS, %APPDATA% on Windows.
// Created on first access.
const STATE_DIR = extensionStateDir();
const MANIFEST_PATH = path.join(STATE_DIR, "documents.json");
const DATA_DIR = path.join(STATE_DIR, "docs");

// ── nvmwonk resolution ───────────────────────────────────────────────────

/** Search PATH for an executable named `prog`. Returns full path or null. */
function findOnPath(prog: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const full = path.join(dir, prog);
		try {
			fs.accessSync(full, fs.constants.X_OK);
			return full;
		} catch {
			// not present / not executable here; keep searching
		}
	}
	return null;
}

/** How to invoke nvmwonk, OR an error describing why we can't.
 *  Resolved per call so env changes are picked up. Never throws —
 *  callers branch on `kind` so they can surface the error to the user
 *  via renderResult instead of producing an empty tool result. */
type NvmwonkInvocation =
	| { kind: "ok"; command: string; prefixArgs: string[] }
	| { kind: "err"; error: string };

/**
 * Resolve how to invoke nvmwonk. Priority:
 *   1. $NVMWONK_BIN       — explicit override; can be either a built binary
 *                           (from scripts/build-portable.sh) or a .py path
 *                           (run via python3). Wins over PATH so a specific
 *                           install/selection always takes precedence.
 *   2. `nvmwonk` on PATH  — most common fallback (installed CLI, dev shell, etc.)
 * Returns `{kind: "err", error}` with a clear actionable message if
 * neither is found.
 */
function resolveNvmwonk(): NvmwonkInvocation {
	const explicit = process.env.NVMWONK_BIN;
	if (explicit) {
		if (explicit.endsWith(".py")) {
			return { kind: "ok", command: "python3", prefixArgs: [explicit] };
		}
		return { kind: "ok", command: explicit, prefixArgs: [] };
	}
	const onPath = findOnPath("nvmwonk");
	if (onPath) {
		return { kind: "ok", command: onPath, prefixArgs: [] };
	}
	return {
		kind: "err",
		error:
			"nvmwonk not found: NVMWONK_BIN is unset and `nvmwonk` is not on PATH.\n\n" +
			"Fix: either\n" +
			"  • set NVMWONK_BIN=/absolute/path/to/nvmwonk (.py script or built binary), or\n" +
			"  • install nvmwonk so `nvmwonk` resolves on PATH.",
	};
}

// ── per-user state directory ──────────────────────────────────────────────────

/**
 * Return the platform-appropriate per-user state directory for this extension.
 *   Linux / *BSD:    $XDG_STATE_HOME/pi/extensions/nvmwonk  (fallback ~/.local/state)
 *   macOS:           ~/Library/Application Support/pi/extensions/nvmwonk
 *   Windows:         %APPDATA%/pi/extensions/nvmwonk
 *
 * Creates the directory (recursively) unless `create: false` is passed.
 * Throws if no usable HOME / APPDATA env var exists for the platform.
 */
function extensionStateDir(opts: { create?: boolean } = {}): string {
	const base = resolveStateBase();
	const full = path.resolve(base, "pi", "extensions", "nvmwonk");
	if (opts.create !== false) {
		fs.mkdirSync(full, { recursive: true });
	}
	return full;
}

function resolveStateBase(): string {
	if (process.platform === "win32") {
		const appdata = process.env.APPDATA;
		if (!appdata) throw new Error("APPDATA is not set; cannot determine Windows state directory");
		return appdata;
	}
	if (process.platform === "darwin") {
		const home = process.env.HOME;
		if (!home) throw new Error("HOME is not set; cannot determine macOS state directory");
		return path.join(home, "Library", "Application Support");
	}
	// Linux, *BSD, and other Unix-likes follow XDG.
	const xdg = process.env.XDG_STATE_HOME;
	if (xdg) return xdg;
	const home = process.env.HOME;
	if (!home) {
		throw new Error("HOME (and XDG_STATE_HOME) are unset; cannot determine state directory");
	}
	return path.join(home, ".local", "state");
}

const SCHEMA_CHEATSHEET = [
	"XML schema of the queried documents:",
	"  tp > metadata > title",
	"  tp > body > (section | spec-changes | annex)* - sections nest recursively",
	"  section@heading - e.g. '3.1.3 Controller Types' (numbers included)",
	"  annex@heading - e.g. 'Annex A. Sanitize Operation Considerations (Informative)'",
	"  spec-changes@spec - TP-only wrapper, e.g. 'NVM Express Base Specification 2.3'",
	"  p - ordinary paragraphs",
	"  table@caption > row(@header='true')? > cell - spec tables preserved verbatim",
	"  TP-only inline markup: content@added='true' (new text), tbd (value assigned",
	"  at integration time), note (editor note), br",
	"Figure captions look like 'Figure 31: Log Page Support Requirements';",
	"TP-internal new figures use tokens, e.g. 'Figure FIGCDW11: Rate Limits – Command Dword 11'.",
	"XPath is XPath 1.0 (libxml2); EXSLT regex namespace re: is registered",
	"(e.g. //section[re:test(@heading, 'Identify', 'i')]).",
].join("\n");

interface DocEntry {
	key: string;
	version: string;
	file: string;
	id?: string;
	title?: string;
}

// ── manifest ────────────────────────────────────────────────────────────────

/** Returns entries plus a problem string when the manifest is missing or
 *  structurally broken (entries array unusable). */
function loadManifest(): { docs: DocEntry[]; problem?: string } {
	let raw: string;
	try {
		raw = fs.readFileSync(MANIFEST_PATH, "utf8");
	} catch {
		return { docs: [], problem: `manifest not found: ${MANIFEST_PATH}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return {
			docs: [],
			problem: `manifest is not valid JSON (${MANIFEST_PATH}): ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	const arr = (parsed as { documents?: unknown })?.documents;
	if (!Array.isArray(arr)) {
		return { docs: [], problem: `manifest has no 'documents' array: ${MANIFEST_PATH}` };
	}
	const docs = arr.filter(
		(d): d is DocEntry =>
			!!d &&
			typeof (d as DocEntry).key === "string" &&
			typeof (d as DocEntry).version === "string" &&
			typeof (d as DocEntry).file === "string",
	);
	return { docs };
}

function docxOf(e: DocEntry): string {
	return path.join(STATE_DIR, e.file);
}

/** Extension swap: docs/x.docx -> docs/x.xml (the derived document name). */
function xmlOf(e: DocEntry): string {
	return /\.docx$/i.test(e.file)
		? path.join(STATE_DIR, e.file.replace(/\.docx$/i, ".xml"))
		: path.join(STATE_DIR, e.file + ".xml");
}

/**
 * Resolve a `doc` parameter to manifest entries. Accepts 'all' (default),
 * 'KEY', 'KEY@VERSION', comma-separated lists. Keys match
 * case-insensitively; versions exactly.
 */
function resolveDocs(doc: string | undefined): { entries: DocEntry[]; problem?: string } {
	const { docs, problem } = loadManifest();
	if (problem) return { entries: [], problem };
	if (docs.length === 0) {
		return { entries: [], problem: `no documents registered in ${MANIFEST_PATH} - add one with spec_register` };
	}
	const spec = (doc ?? "all").trim();
	const available = () => docs.map((d) => `${d.key}@${d.version}`).join(", ");
	if (!spec || spec.toLowerCase() === "all") return { entries: docs };

	const picked: DocEntry[] = [];
	for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
		const at = part.indexOf("@");
		const key = (at === -1 ? part : part.slice(0, at)).toLowerCase();
		const ver = at === -1 ? undefined : part.slice(at + 1);
		const matches = docs.filter(
			(d) => d.key.toLowerCase() === key && (ver === undefined || d.version === ver),
		);
		if (matches.length === 0) {
			return { entries: [], problem: `unknown document '${part}'; available: ${available()}` };
		}
		if (ver === undefined && matches.length > 1) {
			return { entries: [], problem: `'${part}' is ambiguous: ${matches.map((d) => `${d.key}@${d.version}`).join(", ")} - use KEY@VERSION` };
		}
		picked.push(...matches);
	}
	const seen = new Set<string>();
	return {
		entries: picked.filter((d) => {
			const id = `${d.key}@${d.version}`.toLowerCase();
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		}),
	};
}

/** One-line key list for tool descriptions, built at extension load. */
const DOCS_HINT = (() => {
	const { docs, problem } = loadManifest();
	if (problem || docs.length === 0) {
		return "Document key (e.g. 'BASE', 'TP4176', 'BASE@2.3'); call spec_docs to list registered documents. Default: all.";
	}
	return `Document key: ${docs.map((d) => `${d.key}@${d.version}`).join(", ")} - or 'all' (default). Use KEY@VERSION when a key has several revisions.`;
})();

function truncate(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_BYTES) return text;
	// Cut on a line boundary before the cap; close the root element so the
	// consumer still gets parseable-ish XML, plus an explicit notice.
	const buf = Buffer.from(text, "utf8").subarray(0, MAX_BYTES);
	let cut = buf.toString("utf8");
	const lastNl = cut.lastIndexOf("\n");
	if (lastNl > 0) cut = cut.slice(0, lastNl);
	const rootTag = text.match(/<(\w+)[\s>]/)?.[1] ?? "results";
	return `${cut}\n<truncated>output exceeded ${MAX_BYTES} bytes; refine the query (narrower xpath, specific figure ref) to see more</truncated>\n</${rootTag}>\n`;
}

// ── result helpers ────────────────────────────────────────────────────────────
//
// Errors are returned as {content, details} results rather than thrown — that
// way renderResult fires and the user sees the failure inline instead of
// getting an empty tool row (which is how throwing-from-execute looks in some
// paths of the Pi runtime).

function buildErrorResult(error: string) {
	return {
		content: [{ type: "text" as const, text: error }],
		details: { error },
	};
}

/** First non-empty line of a tool result's content, for compact display. */
function firstContentLine(result: any): string {
	const text = result?.content?.[0]?.text ?? "";
	return text.split("\n").find((l: string) => l.trim()) ?? "(no output)";
}

/** Default renderResult used by every tool in this extension. */
function defaultRenderResult(result: any, { expanded, isPartial }: any, theme: any, label: string) {
	if (isPartial) return new Text(theme.fg("warning", "running…"), 0, 0);
	const details = result?.details ?? {};
	if (details.error) {
		const first = firstContentLine(result).split("\n")[0];
		return new Text(theme.fg("error", `✗ ${label}: ${first}`), 0, 0);
	}
	const ok = details.ok !== false;
	const text = result?.content?.[0]?.text ?? "";
	const firstLine = text.split("\n").find((l: string) => l.trim()) ?? "";
	const truncated = details.truncated ? theme.fg("warning", " (truncated)") : "";
	const status = ok
		? theme.fg("success", `✓ ${label}: `) + theme.fg("dim", firstLine.slice(0, 120))
		: theme.fg("warning", `! ${label}: `) + theme.fg("dim", firstLine.slice(0, 120));
	const out = new Text(status + truncated, 0, 0);
	if (expanded && text) {
		const lines = text.split("\n").slice(0, 20);
		let extra = "";
		for (const line of lines) extra += `\n${theme.fg("muted", line)}`;
		if (text.split("\n").length > 20) extra += `\n${theme.fg("muted", "…")}`;
		return new Text(status + truncated + extra, 0, 0);
	}
	return out;
}

// ── extraction + query plumbing ─────────────────────────────────────────────

/** Make sure the xml exists and is not stale; returns its absolute path.
 *  Runs `nvmwonk extract` when the docx is present and (xml missing or docx newer).
 *  Throws on any failure — callers wrap with buildErrorResult. */
async function ensureExtracted(
	pi: ExtensionAPI,
	entry: DocEntry,
	nk: NvmwonkOk,
	signal?: AbortSignal,
): Promise<string> {
	const docx = docxOf(entry);
	const xml = xmlOf(entry);
	const docxOk = fs.existsSync(docx);
	const xmlOk = fs.existsSync(xml);
	if (!docxOk && !xmlOk) {
		throw new Error(
			`document ${entry.key}@${entry.version} is registered but neither '${entry.file}' nor its xml exists - ` +
				`obtain the docx and register it (spec_register) or place it at ${docx}`,
		);
	}
	if (docxOk && (!xmlOk || fs.statSync(docx).mtimeMs > fs.statSync(xml).mtimeMs)) {
		const args = [...nk.prefixArgs, "extract", docx, xml];
		if (entry.id !== undefined) {
			args.push("--id", String(entry.id));
		}
		if (entry.title !== undefined) {
			args.push("--title", String(entry.title));
		}
		const r = await pi.exec(nk.command, args, { signal, cwd: repoRoot });
		if (r.code !== 0) {
			throw new Error(
				`nvmwonk extract failed for ${entry.key}@${entry.version} (exit ${r.code}): ${(r.stderr || r.stdout || "").trim()}`,
			);
		}
	}
	return xml;
}

/** Resolved `ok` form of NvmwonkInvocation (the only kind `ensureExtracted` and
 *  `runQuery` accept; resolution happens once in the caller). */
type NvmwonkOk = { command: string; prefixArgs: string[] };

export default function (pi: ExtensionAPI) {
	async function runQuery(
		nk: NvmwonkOk,
		args: string[],
		signal?: AbortSignal,
	): Promise<{ text: string; isError: boolean }> {
		const result = await pi.exec(
			nk.command,
			[...nk.prefixArgs, "query", ...args],
			{ signal, cwd: repoRoot },
		);
		const stdout = result.stdout?.trim() ?? "";
		const stderr = result.stderr?.trim() ?? "";
		if (result.code !== 0 && result.code !== 1) {
			return {
				text: `nvmwonk query failed (exit ${result.code}):\n${stderr || stdout}`,
				isError: true,
			};
		}
		if (result.code === 1) {
			return { text: `No matches.\n${stdout}`, isError: false };
		}
		return { text: truncate(stdout), isError: false };
	}

	/** Resolve docs, auto-extract, run a query.
	 *  Returns a complete tool result — never throws, so renderResult always
	 *  fires (including for the nvmwonk-not-found case). */
	async function runSpec(
		queryArgs: string[],
		doc: string | undefined,
		signal?: AbortSignal,
	) {
		const nk = resolveNvmwonk();
		if (nk.kind === "err") return buildErrorResult(nk.error);

		const { entries, problem } = resolveDocs(doc);
		if (problem) return buildErrorResult(problem);

		const files: string[] = [];
		try {
			for (const e of entries) files.push(await ensureExtracted(pi, e, nk, signal));
		} catch (e: any) {
			return buildErrorResult(e.message ?? String(e));
		}

		const r = await runQuery(nk, [...queryArgs, ...files], signal);
		if (r.isError) return buildErrorResult(r.text);
		return {
			content: [{ type: "text", text: r.text }],
			details: { ok: true },
		};
	}

	// ── registry tools ──

	pi.registerTool(
		defineTool({
			name: "spec_docs",
			label: "Spec Documents",
			description:
				"List all registered spec documents - key, version, docx/xml presence, extraction status - and the per-user state directory (manifest + data). Keys address documents in the other spec_* tools ('BASE', 'TP4176', 'BASE@2.3', comma-separated, 'all').",
			promptSnippet: "List registered spec documents and their keys",
			promptGuidelines: [
				"Use spec_docs to discover available documents and their keys before querying them with the other spec_* tools.",
			],
			parameters: Type.Object({}),
			async execute() {
				const { docs, problem } = loadManifest();
				const lines: string[] = [
					`state dir: ${STATE_DIR}`,
					`  manifest: ${MANIFEST_PATH}`,
					`  data:     ${DATA_DIR} (.docx copies + extracted .xml; per-user)`,
					"",
				];
				if (problem) lines.push(problem);
				if (!problem && docs.length === 0) {
					lines.push("no documents registered - add one with spec_register");
				}
				for (const d of docs) {
					const docx = docxOf(d);
					const xml = xmlOf(d);
					const docxOk = fs.existsSync(docx);
					const xmlOk = fs.existsSync(xml);
					let status: string;
					if (docxOk && xmlOk) {
						status =
							fs.statSync(docx).mtimeMs > fs.statSync(xml).mtimeMs
								? "stale xml (re-extracts on next use)"
								: "docx present, xml extracted";
					} else if (docxOk) {
						status = "docx present, xml not yet extracted (extracts on first use)";
					} else if (xmlOk) {
						status = "docx MISSING, xml present (queries work; re-extraction impossible)";
					} else {
						status = "MISSING (neither docx nor xml at the expected path)";
					}
					const extra = [
						d.id ? `id=${d.id}` : null,
						d.title ? `title='${d.title}'` : null,
					]
						.filter(Boolean)
						.join(" ");
					lines.push(`${d.key}@${d.version}  ${d.file}  [${status}]${extra ? `  ${extra}` : ""}`);
				}
				if (fs.existsSync(DATA_DIR)) {
					const registered = new Set(docs.map((d) => path.resolve(STATE_DIR, d.file)));
					const strays = fs
						.readdirSync(DATA_DIR)
						.filter((f) => /\.docx$/i.test(f) && !registered.has(path.join(DATA_DIR, f)));
					if (strays.length > 0) {
						lines.push("", `unregistered docx in docs/ (not addressable): ${strays.join(", ")}`);
						lines.push(`register with spec_register, or paste an entry into ${MANIFEST_PATH}`);
					}
				}
				lines.push(
					"",
					"to add a document: spec_register(source, key, version[, id, title]) - copies the docx into docs/, upserts the manifest entry, extracts",
				);
				return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "spec_register",
			label: "Spec Register",
			description:
				"Register a spec document: copy the .docx into docs/ (copied, never referenced in place - user-supplied paths do not survive), upsert its entry in documents.json, and extract the xml immediately. Use when the user provides a document, e.g. 'register ~/Downloads/tp4188.docx as TP4188'. The user-assigned key (BASE, NVM, TP4176, ...) is the identifier used by all spec_* tools.",
			promptSnippet: "Register a docx as a queryable spec document",
			promptGuidelines: [
				"Use spec_register when the user points at a .docx to add; keys are user-chosen identifiers (BASE, NVM, TP4176, ...).",
			],
			parameters: Type.Object({
				source: Type.String({
					description: "Path to the .docx file (absolute preferred; relative resolved against cwd)",
				}),
				key: Type.String({
					description: "User-assigned identifier, e.g. BASE, NVM, TP4188",
				}),
				version: Type.String({
					description: "Revision string, e.g. '2.3' or the TP number '4188'",
				}),
				id: Type.Optional(
					Type.String({ description: "nvmwonk extract --id - the TP number for TPs (root id attribute)" }),
				),
				title: Type.Optional(
					Type.String({ description: "nvmwonk extract --title - e.g. 'Rate Limiting' (root title attribute)" }),
				),
			}),
			async execute(_id, params, signal) {
				const src = path.resolve(process.cwd(), params.source);
				if (!fs.existsSync(src)) return buildErrorResult(`source not found: ${src}`);
				if (!/\.docx$/i.test(src)) return buildErrorResult(`source is not a .docx file: ${src}`);
				fs.mkdirSync(DATA_DIR, { recursive: true });
				const dest = path.join(DATA_DIR, path.basename(src));
				const copied = path.resolve(src) !== dest;
				if (copied) fs.copyFileSync(src, dest);

				const entry: DocEntry = {
					key: params.key,
					version: params.version,
					file: path.relative(STATE_DIR, dest).split(path.sep).join("/"),
				};
				if (params.id !== undefined) entry.id = params.id;
				if (params.title !== undefined) entry.title = params.title;

				const { docs } = loadManifest();
				const merged = [...docs];
				const idx = merged.findIndex(
					(d) => d.key.toLowerCase() === entry.key.toLowerCase() && d.version === entry.version,
				);
				if (idx >= 0) merged[idx] = entry;
				else merged.push(entry);
				fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ documents: merged }, null, 2) + "\n");

				const nk = resolveNvmwonk();
				if (nk.kind === "err") {
					return buildErrorResult(
						`manifest entry saved (${entry.key}@${entry.version}, ${entry.file}), but extraction was skipped:\n\n` +
							nk.error,
					);
				}

				let xml: string;
				try {
					xml = await ensureExtracted(pi, entry, nk, signal);
				} catch (e) {
					return buildErrorResult(
						`manifest entry saved (${entry.key}@${entry.version}, ${entry.file}), but extraction failed: ` +
							`${e instanceof Error ? e.message : String(e)} - fix the docx or the manifest entry, then re-register`,
					);
				}
				const lines = [
					`registered ${entry.key}@${entry.version}`,
					`  docx: ${entry.file}${copied ? ` (copied from ${src})` : " (already in docs/)"}`,
					`  xml:  ${path.relative(STATE_DIR, xml)} (${fs.statSync(xml).size} bytes, extracted)`,
					`  manifest: ${MANIFEST_PATH}`,
					`  queryable now as key '${entry.key}'${merged.length > 1 ? ` (with ${merged.length - 1} other document(s))` : ""}`,
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
			},
			renderCall(args: any, theme: any) {
				const k = args.key ?? "?";
				const v = args.version ?? "?";
				return new Text(
					theme.fg("toolTitle", theme.bold("spec_register ")) +
						theme.fg("accent", `${k}@${v}`),
					0,
					0,
				);
			},
			renderResult(result: any, options: any, theme: any) {
				return defaultRenderResult(result, options, theme, "register");
			},
		}),
	);

	// ── query tools (nvmwonk query, one per command) ──

	pi.registerTool(
		defineTool({
			name: "spec_figures",
			label: "Spec Figures",
			description:
				"List all figures in the spec documents (captioned tables plus graphic-only captions), with figure number/token, caption, document, and section breadcrumb. Use this to find figure refs for spec_figure_get. " +
				SCHEMA_CHEATSHEET,
			promptSnippet: "List figures in the registered spec documents",
			promptGuidelines: [
				"Use spec_figures to discover figure numbers/tokens before calling spec_figure_get, instead of guessing figure numbers.",
			],
			parameters: Type.Object({
				doc: Type.Optional(Type.String({ description: DOCS_HINT })),
			}),
			async execute(_id, params, signal) {
				return runSpec(["figures"], params.doc, signal);
			},
			renderCall(_args: any, theme: any) {
				return new Text(theme.fg("toolTitle", theme.bold("spec_figures")), 0, 0);
			},
			renderResult(result: any, options: any, theme: any) {
				return defaultRenderResult(result, options, theme, "figures");
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "spec_figure_get",
			label: "Spec Figure Get",
			description:
				"Extract one figure verbatim by figure number ('31', '328', '815') or token ('FIGCDW11', 'RLDB'), with substring fallback on caption text. Table figures return the full <table> (all rows/cells, TP inline markup preserved); graphic-only figures (result kind='paragraph') return the caption paragraph plus a <context> of surrounding prose - the image itself is not in the XML. " +
				SCHEMA_CHEATSHEET,
			promptSnippet: "Extract a figure's table from the spec documents by number or token",
			promptGuidelines: [
				"Use spec_figure_get to retrieve register layouts, log pages, feature definitions and other spec tables when implementing against the spec.",
			],
			parameters: Type.Object({
				ref: Type.String({
					description: "Figure number ('31'), token ('FIGCDW11'), or caption substring",
				}),
				doc: Type.Optional(Type.String({ description: DOCS_HINT })),
			}),
			async execute(_id, params, signal) {
				return runSpec(["figure", params.ref], params.doc, signal);
			},
			renderCall(args: any, theme: any) {
				return new Text(
					theme.fg("toolTitle", theme.bold("spec_figure_get ")) +
						theme.fg("accent", `${args.ref ?? "?"}`),
					0,
					0,
				);
			},
			renderResult(result: any, options: any, theme: any) {
				return defaultRenderResult(result, options, theme, "figure");
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "spec_section_get",
			label: "Spec Section Get",
			description:
				"Extract a whole section of a spec document verbatim - heading, all paragraphs, tables, and nested subsections - by section number ('3.1.3', '5.NEW.1', 'Annex A') or heading substring ('Controller Types'). Multiple matches (e.g. repeated 'Command Completion') come back with breadcrumbs for disambiguation. " +
				SCHEMA_CHEATSHEET,
			promptSnippet: "Extract a spec section (text + figures) by number or title",
			promptGuidelines: [
				"Use spec_section_get to read a spec section's full content (prose and figures) when implementing against the spec; prefer it over reading the XML files directly.",
			],
			parameters: Type.Object({
				ref: Type.String({
					description: "Section number ('3.1.3', '5.NEW.1', 'Annex A') or heading substring",
				}),
				doc: Type.Optional(Type.String({ description: DOCS_HINT })),
			}),
			async execute(_id, params, signal) {
				return runSpec(["section", params.ref], params.doc, signal);
			},
			renderCall(args: any, theme: any) {
				return new Text(
					theme.fg("toolTitle", theme.bold("spec_section_get ")) +
						theme.fg("accent", `${args.ref ?? "?"}`),
					0,
					0,
				);
			},
			renderResult(result: any, options: any, theme: any) {
				return defaultRenderResult(result, options, theme, "section");
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "spec_query",
			label: "Spec Query",
			description:
				"Run a raw XPath 1.0 expression against the spec XML and get matching nodes (each wrapped in <result> with its section breadcrumb). Examples: '//tbd' (unresolved TP values), \"//section[contains(@heading,'Identify')]\", '//table[contains(@caption,\"Log Page\")]', '//@caption'. " +
				SCHEMA_CHEATSHEET,
			promptSnippet: "Run raw XPath against the spec XML",
			promptGuidelines: [
				"Use spec_query for ad-hoc spec lookups (sections, prose paragraphs, TP tbd/added markup) that spec_figures and spec_figure_get do not cover.",
			],
			parameters: Type.Object({
				expr: Type.String({ description: "XPath 1.0 expression" }),
				doc: Type.Optional(Type.String({ description: DOCS_HINT })),
			}),
			async execute(_id, params, signal) {
				return runSpec(["xpath", params.expr], params.doc, signal);
			},
			renderCall(args: any, theme: any) {
				const expr = args.expr ?? "?";
				const display = expr.length > 60 ? expr.slice(0, 57) + "..." : expr;
				return new Text(
					theme.fg("toolTitle", theme.bold("spec_query ")) +
						theme.fg("accent", `"${display}"`),
					0,
					0,
				);
			},
			renderResult(result: any, options: any, theme: any) {
				return defaultRenderResult(result, options, theme, "xpath");
			},
		}),
	);
}

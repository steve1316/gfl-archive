import fs from "node:fs";
import path from "node:path";

import { createFlareSolverrClient } from "./flaresolverr.mjs";
import { fetchWithRetry, sleep } from "./http.mjs";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Module constants

/** IOPWiki's MediaWiki API endpoint. */
const API_BASE = "https://iopwiki.com/api.php";

/** Identifies this importer to IOPWiki, per its request for a descriptive User-Agent. */
const USER_AGENT = "gfl-archive-importer/1.0 (https://github.com/steve1316/gfl-archive)";

/** Minimum gap between sequential IOPWiki requests, so a 10-request bulk fetch stays polite. */
const REQUEST_DELAY_MS = 1000;

/** Where the fetched pages are cached by default. Git-ignored. Overridable per call via `options.cacheDir`. */
const DEFAULT_CACHE_DIR = path.resolve("tools/data/.cache");

/** Cache file name inside whichever cache directory is in effect. */
const CACHE_FILENAME = "iopwiki-pages.json";

/** `{{name|arg}}` templates whose text is dropped entirely rather than shown, case-insensitive. */
const DROPPED_TEMPLATES = new Set(["spoiler"]);

/** HTML entities `plainText` knows how to decode. Anything else is left as-is. */
const HTML_ENTITIES = {
	"&amp;": "&",
	"&nbsp;": " ",
	"&quot;": '"',
	"&#39;": "'",
	"&lt;": "<",
	"&gt;": ">"
};

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Fetching

/**
 * Fetch every IOPWiki page that embeds `Template:PlayableUnit`, which is every T-Doll page.
 *
 * Requests are sequential, at least a second apart, and follow the API's `continue` token until it disappears. Each one times out and is
 * retried once, see `fetchWithRetry`. Set `IOPWIKI_CACHE=reuse` to read the cache file back instead of touching the network, which fails
 * when there is no cache file. Otherwise this always refetches and overwrites that cache. The cache lives at `tools/data/.cache/iopwiki-pages.json`
 * by default. Pass `options.cacheDir` to use a different directory (tests must, so they never touch the real cache the importer relies on).
 * IOPWiki's Cloudflare challenges GitHub's runners, so the scheduled refresh sets FLARESOLVERR_URL.
 *
 * @param {object} [options] Options.
 * @param {string} [options.cacheDir] Directory the cache file lives in, instead of `tools/data/.cache`.
 * @param {(ms: number) => Promise<void>} [options.wait] Waits between requests and before a retry. Tests pass a stub so they do not sleep.
 * @param {string} [options.flareSolverrUrl] FlareSolverr's base URL. When set, every API request goes through a FlareSolverr browser
 *   session. Defaults to $FLARESOLVERR_URL, which only the CI refresh sets.
 * @returns {Promise<{ title: string, wikitext: string }[]>} Every doll page's title and raw wikitext.
 * @throws {Error} In reuse mode, when the cache file is missing.
 */
export async function fetchIopwikiPages({ cacheDir = DEFAULT_CACHE_DIR, wait = sleep, flareSolverrUrl = process.env.FLARESOLVERR_URL } = {}) {
	const cacheFile = path.join(cacheDir, CACHE_FILENAME);
	if (process.env.IOPWIKI_CACHE === "reuse") {
		if (!fs.existsSync(cacheFile)) {
			throw new Error(`IOPWIKI_CACHE=reuse but there is no cache file at ${cacheFile}. Run once without it to fetch from IOPWiki.`);
		}
		return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
	}
	const pages = [];
	const baseParams = {
		action: "query",
		generator: "embeddedin",
		geititle: "Template:PlayableUnit",
		geinamespace: "0",
		geilimit: "50",
		prop: "revisions",
		rvprop: "content",
		rvslots: "main",
		format: "json",
		formatversion: "2"
	};
	// Each round sends the original request plus only the latest `continue` object, as MediaWiki asks, so stale keys never carry over.
	let params = new URLSearchParams(baseParams);
	let first = true;
	const solver = flareSolverrUrl ? await createFlareSolverrClient(flareSolverrUrl, { wait }) : null;
	try {
		for (;;) {
			if (!first) {
				await wait(REQUEST_DELAY_MS);
			}
			first = false;
			const url = `${API_BASE}?${params.toString()}`;
			const response = solver ? await solver.get(url) : await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } }, { wait });
			if (!response.ok) {
				throw new Error(`IOPWiki API request failed: ${response.status} ${response.statusText}`);
			}
			const body = await response.json();
			if (body.error) {
				throw new Error(`IOPWiki API error ${body.error.code ?? "unknown"}: ${body.error.info ?? JSON.stringify(body.error)}`);
			}
			if (!body.query) {
				throw new Error(`IOPWiki API response is missing "query": ${JSON.stringify(body)}`);
			}
			for (const page of body.query.pages ?? []) {
				const content = page.revisions?.[0]?.slots?.main?.content;
				if (typeof content === "string") {
					pages.push({ title: page.title, wikitext: content });
				}
			}
			if (!body.continue) {
				break;
			}
			params = new URLSearchParams({ ...baseParams, ...body.continue });
		}
	} finally {
		if (solver) {
			await solver.close().catch((error) => console.warn(`warning: closing the FlareSolverr session failed (${error.message})`));
		}
	}
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(cacheFile, JSON.stringify(pages));
	return pages;
}

/**
 * Fetch one IOPWiki page's wikitext, cached like `fetchIopwikiPages`. `IOPWIKI_CACHE=reuse` reads the cache back instead of the network, and
 * fails when the page was never cached. The scheduled refresh sets FLARESOLVERR_URL, since IOPWiki's Cloudflare challenges GitHub's runners.
 *
 * @param {string} title The page's title, such as "Girls' Frontline Original Soundtrack".
 * @param {object} [options] Options.
 * @param {string} [options.cacheDir] Directory the cache file lives in, instead of `tools/data/.cache`.
 * @param {(ms: number) => Promise<void>} [options.wait] Waits before a retry. Tests pass a stub so they do not sleep.
 * @param {string} [options.flareSolverrUrl] FlareSolverr's base URL. Defaults to $FLARESOLVERR_URL, which only the CI refresh sets.
 * @returns {Promise<string>} The page's wikitext.
 * @throws {Error} When the request or the API fails, when the page does not exist, or in reuse mode when there is no cache file.
 */
export async function fetchIopwikiPageText(title, { cacheDir = DEFAULT_CACHE_DIR, wait = sleep, flareSolverrUrl = process.env.FLARESOLVERR_URL } = {}) {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	const cacheFile = path.join(cacheDir, `iopwiki-page-${slug}.json`);
	if (process.env.IOPWIKI_CACHE === "reuse") {
		if (!fs.existsSync(cacheFile)) {
			throw new Error(`IOPWIKI_CACHE=reuse but there is no cache file at ${cacheFile}. Run once without it to fetch from IOPWiki.`);
		}
		return JSON.parse(fs.readFileSync(cacheFile, "utf8")).wikitext;
	}
	const params = new URLSearchParams({ action: "query", titles: title, prop: "revisions", rvprop: "content", rvslots: "main", format: "json", formatversion: "2" });
	const url = `${API_BASE}?${params.toString()}`;
	const solver = flareSolverrUrl ? await createFlareSolverrClient(flareSolverrUrl, { wait }) : null;
	try {
		const response = solver ? await solver.get(url) : await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } }, { wait });
		if (!response.ok) {
			throw new Error(`IOPWiki API request failed: ${response.status} ${response.statusText}`);
		}
		const body = await response.json();
		if (body.error) {
			throw new Error(`IOPWiki API error ${body.error.code ?? "unknown"}: ${body.error.info ?? JSON.stringify(body.error)}`);
		}
		const wikitext = body.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
		if (typeof wikitext !== "string") {
			throw new Error(`IOPWiki has no page "${title}"`);
		}
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify({ title, wikitext }));
		return wikitext;
	} finally {
		if (solver) {
			await solver.close().catch((error) => console.warn(`warning: closing the FlareSolverr session failed (${error.message})`));
		}
	}
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Template parsing

/**
 * Split a template's inner content on its top-level `|` characters, without splitting inside a nested
 * `[[...]]` link. Used once braces are already known absent (the content is a single, innermost template).
 *
 * @param {string} inner Template content between `{{` and `}}`.
 * @returns {string[]} The template name followed by its arguments, in order.
 */
function splitTemplateArgs(inner) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner.startsWith("[[", i)) {
			depth++;
			i++;
		} else if (inner.startsWith("]]", i)) {
			depth = Math.max(0, depth - 1);
			i++;
		} else if (inner[i] === "|" && depth === 0) {
			parts.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(inner.slice(start));
	return parts;
}

/**
 * Resolve one already-innermost `{{name|arg1|arg2}}` template body to its plain-text replacement.
 *
 * A `spoiler` template is always dropped. Any other template resolves to its last positional (unnamed,
 * i.e. no `key=`) argument when that argument is itself free of wiki markup, and to an empty string
 * otherwise.
 *
 * @param {string} inner The template body between `{{` and `}}`.
 * @returns {string} The template's plain-text replacement.
 */
function resolveTemplate(inner) {
	const parts = splitTemplateArgs(inner);
	const name = (parts[0] ?? "").trim().toLowerCase();
	if (DROPPED_TEMPLATES.has(name)) {
		return "";
	}
	const positional = parts.slice(1).filter((part) => !part.includes("="));
	const last = positional.at(-1);
	if (last === undefined) {
		return "";
	}
	const trimmed = last.trim();
	return /[[\]{}<>]/.test(trimmed) ? "" : trimmed;
}

/**
 * Extract the named parameters of the top-level `{{PlayableUnit ...}}` template from a page's wikitext.
 *
 * `<!-- ... -->` comments (including multi-line ones) are stripped first, since a `|` or `{{`/`}}` inside a
 * comment is not real template syntax and would otherwise corrupt parameter splitting. Nested `{{...}}`
 * templates and `[[...]]` links are then tracked by depth, so a `|` inside either never splits a parameter.
 * Content after the template's matching `}}` (such as a trailing `[[Category:...]]`) is ignored.
 *
 * @param {string} wikitext Raw page wikitext.
 * @returns {Record<string, string> | null} Parameter values keyed by trimmed, lowercased name, or null when
 *   no `{{PlayableUnit` template is found.
 */
export function parsePlayableUnit(wikitext) {
	const cleaned = wikitext.replace(/<!--[\s\S]*?-->/g, "");
	const start = cleaned.search(/\{\{\s*PlayableUnit\b/i);
	if (start === -1) {
		return null;
	}
	let braceDepth = 0;
	let contentStart = -1;
	let contentEnd = -1;
	for (let i = start; i < cleaned.length; i++) {
		if (cleaned.startsWith("{{", i)) {
			braceDepth++;
			if (braceDepth === 1) {
				contentStart = i + 2;
			}
			i++;
		} else if (cleaned.startsWith("}}", i)) {
			braceDepth--;
			i++;
			if (braceDepth === 0) {
				contentEnd = i - 1;
				break;
			}
		}
	}
	if (contentEnd === -1) {
		return null;
	}
	const content = cleaned.slice(contentStart, contentEnd);
	const segments = [];
	let braces = 0;
	let links = 0;
	let segStart = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.startsWith("{{", i)) {
			braces++;
			i++;
		} else if (content.startsWith("}}", i)) {
			braces = Math.max(0, braces - 1);
			i++;
		} else if (content.startsWith("[[", i)) {
			links++;
			i++;
		} else if (content.startsWith("]]", i)) {
			links = Math.max(0, links - 1);
			i++;
		} else if (content[i] === "|" && braces === 0 && links === 0) {
			segments.push(content.slice(segStart, i));
			segStart = i + 1;
		}
	}
	segments.push(content.slice(segStart));
	const fields = {};
	// segments[0] is the template name itself ("PlayableUnit"), not a parameter.
	for (const segment of segments.slice(1)) {
		const eq = segment.indexOf("=");
		if (eq === -1) {
			continue;
		}
		const key = segment.slice(0, eq).trim().toLowerCase();
		if (key) {
			fields[key] = segment.slice(eq + 1).trim();
		}
	}
	return fields;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Plain text and field readers

/**
 * Reduce one raw `parsePlayableUnit` field value to plain display text.
 *
 * Order: `<!-- ... -->` comments are stripped, `<ref>` tags (paired and self-closing) are removed, templates
 * are resolved innermost-first (see `resolveTemplate`), `[[a|b]]` links resolve to `b` and `[[a]]` to `a`,
 * `<br/>` becomes ", ", any other HTML tag is stripped, `''` / `'''` / `'''''` emphasis is removed (a run of four
 * keeps one literal apostrophe, as MediaWiki does), HTML entities are decoded, and finally whitespace is collapsed
 * and trimmed.
 *
 * @param {string} value A raw field value from `parsePlayableUnit`.
 * @returns {string} Plain text.
 */
export function plainText(value) {
	let text = value;
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<ref\b[^>]*\/>/gi, "");
	text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "");
	while (/\{\{[^{}]*\}\}/.test(text)) {
		text = text.replace(/\{\{([^{}]*)\}\}/g, (_match, inner) => resolveTemplate(inner));
	}
	while (/\[\[[^[\]]*\]\]/.test(text)) {
		text = text.replace(/\[\[([^[\]]*)\]\]/g, (_match, inner) => {
			const pipe = inner.indexOf("|");
			return (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
		});
	}
	text = text.replace(/<br\s*\/?>/gi, ", ");
	text = text.replace(/<[^>]+>/g, "");
	text = text.replace(/'{2,}/g, (run) => (run.length === 4 ? "'" : "'".repeat(Math.max(0, run.length - 5))));
	text = text.replace(/&[a-zA-Z#0-9]+;/g, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity);
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Find the doll's EN release year and month inside its raw `releasedon` field.
 *
 * @param {string} releasedon Raw `releasedon` field value, holding one `{{doll_server_alias|...}}` per server.
 * @returns {{ year: number, month: number } | null} The EN year and month, or null when either is missing.
 */
export function parseEnRelease(releasedon) {
	if (!releasedon) {
		return null;
	}
	const templates = releasedon.match(/\{\{doll_server_alias\|[^}]*\}\}/g) ?? [];
	for (const template of templates) {
		if (!/\|\s*server\s*=\s*EN\b/i.test(template)) {
			continue;
		}
		const year = template.match(/\|\s*year\s*=\s*(\d+)/);
		const month = template.match(/\|\s*month\s*=\s*(\d+)/);
		if (year && month) {
			return { year: Number(year[1]), month: Number(month[1]) };
		}
	}
	return null;
}

/**
 * Find the doll's Wikipedia article title from a `[[wikipedia:Title]]` or `[[wikipedia:Title|text]]` link.
 *
 * Looks in `weaponinfo` first, then falls back to every other field, in insertion order.
 *
 * @param {Record<string, string>} fields Parsed `PlayableUnit` fields.
 * @returns {string | null} The Wikipedia title, underscores normalised to spaces, or null when no field has one.
 */
export function wikipediaTitle(fields) {
	const findIn = (text) => {
		const match = typeof text === "string" ? text.match(/\[\[\s*wikipedia\s*:\s*([^|\]]+)/i) : null;
		return match ? match[1].trim().replaceAll("_", " ") : null;
	};
	const fromWeaponInfo = findIn(fields.weaponinfo);
	if (fromWeaponInfo) {
		return fromWeaponInfo;
	}
	for (const value of Object.values(fields)) {
		const found = findIn(value);
		if (found) {
			return found;
		}
	}
	return null;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchIopwikiPageText, fetchIopwikiPages, parseEnRelease, parsePlayableUnit, plainText, wikipediaTitle } from "../lib/iopwiki.mjs";

const hk416 = fs.readFileSync("tools/data/test/fixtures/iopwiki-hk416.wikitext", "utf8");
const beowulf = fs.readFileSync("tools/data/test/fixtures/iopwiki-beowulf.wikitext", "utf8");
const dorothy = fs.readFileSync("tools/data/test/fixtures/iopwiki-dorothy.wikitext", "utf8");

/** Stands in for the real waits between requests and before a retry, so tests do not sleep. */
const noWait = async () => {};

// Only the fetchIopwikiPages tests below touch a cache directory. Each gets its own throwaway one, never
// the real tools/data/.cache the importer uses.
let cacheDir;

test.beforeEach(() => {
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfl-iopwiki-test-"));
});

test.afterEach(() => {
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("parses HK416's index, faction, manufacturer and nationality", () => {
	const fields = parsePlayableUnit(hk416);
	assert.equal(fields.index, "65");
	assert.equal(plainText(fields.faction), "Squad 404");
	assert.equal(plainText(fields.manufacturer), "Heckler & Koch");
	assert.equal(plainText(fields.nationality), "Germany");
});

test("nested {{artist name|...}} templates and their pipes do not split the artist parameter or hide the next one", () => {
	const fields = parsePlayableUnit(hk416);
	assert.match(fields.artist, /NIXOO/);
	assert.match(fields.artist, /White Negroni/);
	assert.equal(fields.fullname, "Heckler & Koch HK416");
});

test("a [[wikipedia:Title|text]] link inside a <ref> still resolves as the doll's Wikipedia title", () => {
	const fields = parsePlayableUnit(hk416);
	assert.equal(wikipediaTitle(fields), "Heckler & Koch HK416");
});

test("returns null when the wikitext has no PlayableUnit template", () => {
	assert.equal(parsePlayableUnit("Just some prose, no template here."), null);
});

test("Beowulf's EN release parses to year 2024, month 9", () => {
	const fields = parsePlayableUnit(beowulf);
	assert.deepEqual(parseEnRelease(fields.releasedon), { year: 2024, month: 9 });
});

test("a releasedon with no EN year or month parses to null", () => {
	const fields = parsePlayableUnit(hk416);
	assert.equal(parseEnRelease(fields.releasedon), null);
});

test("parses a collab doll (Dorothy), including an empty parameter", () => {
	const fields = parsePlayableUnit(dorothy);
	assert.equal(fields.index, "1019");
	assert.equal(fields.classification, "SMG");
	assert.equal(fields.rarity, "EXTRA");
	assert.equal(fields.voiceactor, "");
});

test("plainText drops a {{spoiler|...}} template, keeping the rest of the value", () => {
	const value = "Unknown Manufacturer\n{{spoiler|Modified into a T-Doll by [[Dier]]}}";
	assert.equal(plainText(value), "Unknown Manufacturer");
});

test("plainText removes <ref>...</ref> and self-closing <ref .../> tags", () => {
	assert.equal(plainText("Germany<ref>[[wikipedia:Foo|bar]]</ref>"), "Germany");
	assert.equal(plainText('Text<ref name="x" />More'), "TextMore");
});

test("plainText resolves [[a|b]] to b and [[a]] to a", () => {
	assert.equal(plainText("[[Griffin & Kryuger]]"), "Griffin & Kryuger");
	assert.equal(plainText("[[wikipedia:Kar98k|Wikipedia entry]]"), "Wikipedia entry");
});

test("plainText resolves another template's last positional argument, when it is plain text", () => {
	assert.equal(plainText("{{artist name|NIXOO}}"), "NIXOO");
	assert.equal(plainText("{{doll_server_alias|server=EN|alias=416}}"), "");
});

test("plainText turns <br/> into a comma-space and strips other HTML tags", () => {
	assert.equal(plainText("A<br/>B"), "A, B");
	assert.equal(plainText('<div class="spoiler">Neural Upgrade</div>'), "Neural Upgrade");
});

test("plainText decodes HTML entities and collapses whitespace", () => {
	assert.equal(plainText("Smith &amp; Wesson"), "Smith & Wesson");
	assert.equal(plainText("A&nbsp;&nbsp;B   C"), "A B C");
});

test("wikipediaTitle normalises underscores to spaces", () => {
	const fields = { weaponinfo: "See [[wikipedia:Karabiner_98k|Kar98k]] for details." };
	assert.equal(wikipediaTitle(fields), "Karabiner 98k");
});

test("wikipediaTitle returns null when no field has a wikipedia link", () => {
	assert.equal(wikipediaTitle({ nationality: "Germany", faction: "[[Squad 404]]" }), null);
});

test("an HTML comment between two real parameters (as on the Beowulf fixture) does not corrupt either field", () => {
	const fields = parsePlayableUnit(beowulf);
	assert.equal(fields.max_hp, "121");
	assert.equal(fields.min_dmg, "23");
	assert.equal(fields.fix_min, undefined);
	assert.equal(fields.fix_max, undefined);
	for (const value of Object.values(fields)) {
		assert.doesNotMatch(value, /<!--/);
	}
});

test("a comment containing pipes and braces is stripped before parameter splitting, not treated as syntax", () => {
	const wikitext = "{{PlayableUnit\n|a=1<!-- comment | with {{braces}} and a pipe -->\n|b=2}}";
	assert.deepEqual(parsePlayableUnit(wikitext), { a: "1", b: "2" });
});

test("plainText strips HTML comments, including a multi-line one with an embedded >", () => {
	assert.equal(plainText("Before <!-- hidden --> After"), "Before After");
	assert.equal(plainText("Before <!-- a\nmulti-line > comment --> After"), "Before After");
});

test("IOPWIKI_CACHE=reuse fails when there is no cache file, without fetching", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("network should not be called in reuse mode");
	};
	process.env.IOPWIKI_CACHE = "reuse";
	try {
		await assert.rejects(fetchIopwikiPages({ cacheDir }), /IOPWIKI_CACHE=reuse.*no cache file/);
	} finally {
		delete process.env.IOPWIKI_CACHE;
		globalThis.fetch = original;
	}
});

test("IOPWIKI_CACHE=reuse reads the cache file back without fetching", async () => {
	const pages = [{ title: "Cached", wikitext: "{{PlayableUnit|index=2}}" }];
	fs.writeFileSync(path.join(cacheDir, "iopwiki-pages.json"), JSON.stringify(pages));
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("network should not be called in reuse mode");
	};
	process.env.IOPWIKI_CACHE = "reuse";
	try {
		assert.deepEqual(await fetchIopwikiPages({ cacheDir }), pages);
	} finally {
		delete process.env.IOPWIKI_CACHE;
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages rejects with the API's error code when IOPWiki answers 200 with an error body", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: "badtitle", info: "Bad title" } }) });
	try {
		await assert.rejects(fetchIopwikiPages({ cacheDir }), /badtitle/);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages rejects when IOPWiki still answers with an HTTP 500 after one retry", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) };
	};
	try {
		await assert.rejects(fetchIopwikiPages({ cacheDir, wait: noWait }), /500/);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages retries a network error once and carries on", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls === 1) {
			throw new TypeError("fetch failed");
		}
		return { ok: true, status: 200, json: async () => ({ query: { pages: [{ title: "Test", revisions: [{ slots: { main: { content: "{{PlayableUnit|index=1}}" } } }] }] } }) };
	};
	try {
		assert.deepEqual(await fetchIopwikiPages({ cacheDir, wait: noWait }), [{ title: "Test", wikitext: "{{PlayableUnit|index=1}}" }]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages rejects when the response has no query object", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ batchcomplete: true }) });
	try {
		await assert.rejects(fetchIopwikiPages({ cacheDir }), /query/);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages writes its cache under the given cacheDir, not the real tools/data/.cache", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ query: { pages: [{ title: "Test", revisions: [{ slots: { main: { content: "{{PlayableUnit|index=1}}" } } }] }] } })
	});
	try {
		const pages = await fetchIopwikiPages({ cacheDir });
		assert.deepEqual(pages, [{ title: "Test", wikitext: "{{PlayableUnit|index=1}}" }]);
		assert.ok(fs.existsSync(path.join(cacheDir, "iopwiki-pages.json")));
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPages sends the original request plus only the latest continue object each round", async () => {
	const page = (title) => ({ title, revisions: [{ slots: { main: { content: `{{PlayableUnit|index=${title.length}}}` } } }] });
	const bodies = [
		{ query: { pages: [page("A")] }, continue: { rvcontinue: "r1", continue: "||" } },
		{ query: { pages: [page("BB")] }, continue: { geicontinue: "g2", continue: "gcontinue||" } },
		{ query: { pages: [page("CCC")] } }
	];
	const urls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		urls.push(new URL(url).searchParams);
		return { ok: true, status: 200, json: async () => bodies[urls.length - 1] };
	};
	try {
		const pages = await fetchIopwikiPages({ cacheDir, wait: noWait });
		assert.deepEqual(
			pages.map((entry) => entry.title),
			["A", "BB", "CCC"]
		);
		assert.equal(urls.length, 3);
		assert.equal(urls[0].has("rvcontinue"), false);
		assert.equal(urls[1].get("rvcontinue"), "r1");
		assert.equal(urls[1].get("continue"), "||");
		assert.equal(urls[2].get("geicontinue"), "g2");
		assert.equal(urls[2].get("continue"), "gcontinue||");
		assert.equal(urls[2].has("rvcontinue"), false, "the first round's rvcontinue must not carry over");
		for (const params of urls) {
			assert.equal(params.get("geititle"), "Template:PlayableUnit");
		}
	} finally {
		globalThis.fetch = original;
	}
});

test("plainText strips '' italic, ''' bold and ''''' bold italic markup but keeps a single apostrophe", () => {
	assert.equal(plainText("Heckler & Koch '''M'''aschinen'''P'''istole 7"), "Heckler & Koch MaschinenPistole 7");
	assert.equal(plainText("''Italic'' and '''''both'''''"), "Italic and both");
	assert.equal(plainText("Kitty's '''Colt''''s''' gun"), "Kitty's Colt's gun");
});

test("fetchIopwikiPages routes every IOPWiki request through FlareSolverr when given its URL", async () => {
	const commands = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		assert.ok(String(url).startsWith("http://solver.test/"), `unexpected direct request to ${url}`);
		const payload = JSON.parse(init.body);
		commands.push(payload.cmd);
		if (payload.cmd === "request.get") {
			const body = { query: { pages: [{ title: "M887", revisions: [{ slots: { main: { content: "{{PlayableUnit|index=424}}" } } }] }] } };
			return { json: async () => ({ status: "ok", solution: { status: 200, response: `<pre>${JSON.stringify(body).replaceAll("&", "&amp;")}</pre>` } }) };
		}
		return { json: async () => ({ status: "ok", session: "s1" }) };
	};
	try {
		const pages = await fetchIopwikiPages({ cacheDir, wait: async () => {}, flareSolverrUrl: "http://solver.test" });
		assert.deepEqual(pages, [{ title: "M887", wikitext: "{{PlayableUnit|index=424}}" }]);
		assert.deepEqual(commands, ["sessions.create", "request.get", "sessions.destroy"]);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchIopwikiPageText reads a page back from its cache in reuse mode", async () => {
	fs.writeFileSync(path.join(cacheDir, "iopwiki-page-girls-frontline-original-soundtrack.json"), JSON.stringify({ title: "Girls' Frontline Original Soundtrack", wikitext: "cached text" }));
	process.env.IOPWIKI_CACHE = "reuse";
	try {
		assert.equal(await fetchIopwikiPageText("Girls' Frontline Original Soundtrack", { cacheDir }), "cached text");
	} finally {
		delete process.env.IOPWIKI_CACHE;
	}
});

test("fetchIopwikiPageText in reuse mode fails when the page was never cached", async () => {
	process.env.IOPWIKI_CACHE = "reuse";
	try {
		await assert.rejects(fetchIopwikiPageText("Some Page", { cacheDir }), /no cache file/);
	} finally {
		delete process.env.IOPWIKI_CACHE;
	}
});

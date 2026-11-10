/**
 * Parse one upstream text table.
 *
 * Lines are `key,value`, split on the first comma only. Files use CRLF, and `battle_skill_config.txt` starts with two BOMs.
 *
 * @param {string} source The whole file.
 * @returns {Map<string, string>} Raw values keyed by text key, still escaped.
 */
export function parseTextTable(source) {
	const table = new Map();
	for (const line of source.replace(/^\uFEFF+/, "").split(/\r?\n/)) {
		const comma = line.indexOf(",");
		if (comma > 0) {
			table.set(line.slice(0, comma), line.slice(comma + 1));
		}
	}
	return table;
}

/**
 * Undo the text tables' escapes. `//c` is a comma and `//n` a newline. A leftover `// ` is an upstream typo for a comma, as in "damage// rate of fire".
 *
 * Upstream often drops the space after `//c` ("armor//cMaximum") or follows a full stop with one ("30 points.//c30%"). Both are given normal spacing.
 * Digits after a comma are left alone so numbers like "1,000" survive.
 *
 * @param {string} value An escaped value.
 * @returns {string} The plain text.
 */
export function unescapeText(value) {
	return value
		.replaceAll("//c", ",")
		.replaceAll("//n", "\n")
		.replaceAll("// ", ", ")
		.replace(/\.,[ \t]*/g, ". ")
		.replace(/,(?=[A-Za-z])/g, ", ");
}

/**
 * Tidy a display name. Upstream names can hold non-breaking spaces and newlines, which break search and wrapping.
 *
 * @param {string} value A name.
 * @returns {string} The name with each whitespace run turned into one space, trimmed.
 */
export function cleanName(value) {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Remove Unity rich text colour tags, keeping the text inside them.
 *
 * @param {string} value Text that may contain `<color=...>` tags.
 * @returns {string} The text without tags.
 */
export function stripMarkup(value) {
	return value.replace(/<\/?color(=[^>]*)?>/g, "");
}

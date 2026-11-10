// Docs prose is written one sentence per line. A paragraph on a single line of 1,000+ characters cannot be
// read in an editor or edited surgically (an edit has to re-paste the whole paragraph), so lines over the
// limit fail `npm run lint`. Markdown joins consecutive lines of a paragraph, so the rendered page is the same.
// Skipped: code fences, tables, headings, blockquotes, HTML and link-reference lines. docs/archive is history.
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(import.meta.dirname, "..", "docs");
const LIMIT = 600;

const problems = [];
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort()) {
	let fence = false;
	fs.readFileSync(path.join(DIR, name), "utf8").split(/\r?\n/).forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence || line.length <= LIMIT || /^\s*(\||#|>|<|\[[^\]]+\]:)/.test(line)) return;
		problems.push(`docs/${name}:${index + 1}: ${line.length} characters (limit ${LIMIT}); split the paragraph into one sentence per line`);
	});
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}

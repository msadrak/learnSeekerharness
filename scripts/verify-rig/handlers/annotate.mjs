// Example handlers for fake-llm.mjs: scanned-page annotation.
//   teacher  a user message holding a doc id (doc_…), a quoted passage and "page N" → propose_annotation; then plain text
//   boxer    a request with an image (the scan reader asked where the quote sits) → canned 0–1000 [ymin, xmin, ymax, xmax] boxes
// Boxes match the lines drawn by make-scan-pdf.mjs. A quote with no entry answers {"found": false}.
const BOXES = {
	"I think therefore I am": '{"found": true, "lines": [[237, 100, 287, 900], [300, 100, 350, 560]]}',
	"Sideways in the file": '{"found": true, "lines": [[417, 125, 500, 875]]}',
};

export default function respond({ toolNames, hasImage, lastRole, lastText, userText }) {
	if (hasImage) {
		const asked = userText.replace(/^Passage to locate:\n/, "").trim();
		return { text: BOXES[asked] ?? '{"found": false}' };
	}
	if (lastRole === "tool") return { text: `Done: ${lastText.slice(0, 200)}` };
	const doc = lastText.match(/doc_[0-9a-f]{12}/)?.[0];
	const quote = lastText.match(/"([^"]+)"/)?.[1];
	const page = Number(lastText.match(/page (\d+)/)?.[1]);
	if (doc && quote && page && toolNames.includes("propose_annotation")) {
		return { tool: { name: "propose_annotation", args: { document: doc, quote, page, note: `Note on "${quote}"` } } };
	}
	return undefined;
}

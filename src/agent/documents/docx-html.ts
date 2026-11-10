import mammoth from "mammoth";
import { parseHTML } from "linkedom";

/** Attributes/elements that never survive into the viewer: the HTML is rendered
 *  with dangerouslySetInnerHTML, so Word content gets the same distrust as any
 *  uploaded markup even though mammoth already emits a small safe subset. */
const REMOVED_ELEMENTS = ["script", "iframe", "object", "embed"];

/** Sanitize mammoth's HTML: no event handlers, no scripting URLs, no active elements. */
export function sanitizeDocxHtml(html: string): string {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	for (const el of document.querySelectorAll(REMOVED_ELEMENTS.join(","))) el.remove();
	for (const el of document.querySelectorAll("*")) {
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on")) el.removeAttribute(attr.name);
			else if (name === "href" && !/^(https?:|mailto:|#)/i.test(attr.value.trim())) el.removeAttribute(attr.name);
		}
	}
	return document.body.innerHTML;
}

/** A Word document as semantic HTML (mammoth defaults: images as data URIs,
 *  comments and highlights ignored), sanitized. */
export async function docxToHtml(bytes: Uint8Array): Promise<string> {
	const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
	return sanitizeDocxHtml(value);
}

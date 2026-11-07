/**
 * Plain (non-markdown) learner text with its LaTeX and code kept intact
 * in right-to-left paragraphs (Persian locale wave). Typed math like
 * "مشتق $x^3$ چیست؟" is raw text here — no KaTeX — and the bidi algorithm
 * treats its `$`, `^`, `(` as neutrals that join the surrounding Persian
 * run, scrambling "$x^3$" into "$$x^3". Each `$…$`, `$$…$$` and `…`
 * span becomes a left-to-right <bdi> island, the same isolation the
 * markdown renderer gives rendered math and code.
 */

const LTR_SPAN = /(\$\$[^$]+\$\$|\$[^$\n]+\$|`[^`\n]+`)/;

export function BidiText({ text }: { text: string }) {
	const pieces = text.split(LTR_SPAN);
	if (pieces.length === 1) return <>{text}</>;
	return (
		<>
			{pieces.map((piece, i) =>
				// split() with one capture group alternates text / match.
				i % 2 === 1 ? (
					<bdi key={i} dir="ltr">
						{piece}
					</bdi>
				) : (
					piece
				),
			)}
		</>
	);
}

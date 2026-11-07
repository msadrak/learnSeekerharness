/**
 * The block-direction rule for mixed Persian/English markdown (Persian
 * locale wave): any Persian letter in a block → rtl, otherwise ltr; math
 * and code never vote. Rendered through MessageResponse — the dir the
 * learner's browser actually sees.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("markdown block direction", () => {
	it("a Persian sentence that OPENS with a Latin word is rtl (first-strong would say ltr)", () => {
		assert.match(render("LaTeX یک زبان حروف‌چینی است."), /<p[^>]*dir="rtl"/);
	});

	it("a Persian sentence that opens with math is rtl", () => {
		assert.match(render("$x^2 + 1$ همیشه مثبت است."), /<p[^>]*dir="rtl"/);
	});

	it("English prose stays ltr", () => {
		assert.match(render("The derivative of $x^2$ is $2x$."), /<p[^>]*dir="ltr"/);
	});

	it("Persian inside inline code doesn't flip an English sentence", () => {
		assert.match(render("Type `سلام` into the box."), /<p[^>]*dir="ltr"/);
	});

	it("a Persian list carries rtl on the list and its items", () => {
		const html = render("- مشتق\n- انتگرال");
		assert.match(html, /<ul[^>]*dir="rtl"/);
		assert.match(html, /<li[^>]*dir="rtl"/);
	});

	it("blocks decide independently in a mixed document", () => {
		const html = render("## Limits\n\nحد تابع $f$ در نقطه $a$ برابر $L$ است.");
		assert.match(html, /<h2[^>]*dir="ltr"/);
		assert.match(html, /<p[^>]*dir="rtl"/);
	});
});

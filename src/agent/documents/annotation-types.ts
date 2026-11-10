import type { AnnotationFailure, PageRegion } from "../../core/documents.ts";

/** One annotation to write. `page` (PDF) is the page the proposal located. With `regions` (a scanned page) the highlight goes on those
 *  rectangles and the text layer is never consulted. */
export interface AnnotationInput {
	id: string;
	quote: string;
	page?: number;
	regions?: readonly PageRegion[];
	note: string;
}

export type AnnotationOutcome =
	| { id: string; result: "written" }
	| { id: string; result: "failed"; failure: AnnotationFailure; message: string };

export const AUTHOR = "LearnHarness";

export function failed(id: string, failure: AnnotationFailure, message: string): AnnotationOutcome {
	return { id, result: "failed", failure, message };
}

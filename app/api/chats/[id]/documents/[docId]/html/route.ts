import { documentErrorResponse, documentHtmlResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** A Word document as sanitized semantic HTML: `{ html }`. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
	const { id, docId } = await params;
	try {
		return await documentHtmlResponse(id, docId);
	} catch (err) {
		const response = documentErrorResponse(err);
		if (response) return response;
		throw err;
	}
}

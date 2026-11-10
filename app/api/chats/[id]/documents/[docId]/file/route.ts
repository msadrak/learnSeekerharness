import { documentErrorResponse, documentFileResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** A registered document's raw bytes (re-guarded against the file-access policy on every read). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
	const { id, docId } = await params;
	try {
		return await documentFileResponse(id, docId);
	} catch (err) {
		const response = documentErrorResponse(err);
		if (response) return response;
		throw err;
	}
}

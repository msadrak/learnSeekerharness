import { documentErrorResponse, regionErrorResponse, transcribeRegion } from "@/src/server";

export const dynamic = "force-dynamic";

/** Transcribe one rectangle of a PDF page with the scan-reader model: {page, region:{x,y,w,h}} (fractions of the page) → {transcript, snapshotId, width, height}. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
	const { id, docId } = await params;
	const body = await req.json().catch(() => null);
	try {
		return Response.json(await transcribeRegion(id, docId, body, { signal: req.signal }), { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		const response = regionErrorResponse(err) ?? documentErrorResponse(err);
		if (response) return response;
		throw err;
	}
}

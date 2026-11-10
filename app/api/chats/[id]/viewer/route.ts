import { documentErrorResponse, getViewer, updateViewerLayout } from "@/src/server";

export const dynamic = "force-dynamic";

/** The session's document viewer state (empty when it never opened a document). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const viewer = getViewer(id);
	if (!viewer) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ viewer }, { headers: { "Cache-Control": "no-store" } });
}

/** Replace the learner-owned layout: tabs, active tab, panel visibility, reading positions. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	try {
		const viewer = updateViewerLayout(id, body);
		if (!viewer) return Response.json({ error: "Not found" }, { status: 404 });
		return Response.json({ viewer });
	} catch (err) {
		const response = documentErrorResponse(err);
		if (response) return response;
		throw err;
	}
}

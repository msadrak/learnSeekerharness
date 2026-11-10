import { decideAnnotations } from "@/src/server";
import { ANNOTATION_ID_RE } from "@/src/core";

export const dynamic = "force-dynamic";

/** The learner's decision on proposed annotations: accept (written into the real file) or reject. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { decision?: unknown; ids?: unknown } | null;
	const decision = body?.decision;
	const ids = body?.ids;
	if (decision !== "accept" && decision !== "reject") {
		return Response.json({ error: "decision must be accept or reject." }, { status: 400 });
	}
	if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((i) => typeof i !== "string" || !ANNOTATION_ID_RE.test(i))) {
		return Response.json({ error: "ids must be 1 to 100 annotation ids." }, { status: 400 });
	}
	const result = await decideAnnotations(id, ids as string[], decision);
	if (!result) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(result);
}

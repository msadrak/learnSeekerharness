/**
 * GET    /api/subscriptions/sessions/:sid — poll a login session.
 * POST   — answer the open prompt: body {promptId, value}.
 * DELETE — cancel the login (frees its callback port).
 */
import { answerLoginPrompt, cancelLogin, getLoginSession } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sid: string }> };

export async function GET(_req: Request, { params }: Params) {
	const { sid } = await params;
	const session = getLoginSession(sid);
	if (!session) return Response.json({ error: "unknown login session" }, { status: 404 });
	return Response.json({ session }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, { params }: Params) {
	const { sid } = await params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || !("promptId" in body) || !("value" in body) || typeof body.promptId !== "string" || typeof body.value !== "string") {
		return Response.json({ error: "body must be {promptId: string, value: string}" }, { status: 400 });
	}
	const result = answerLoginPrompt(sid, body.promptId, body.value);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ session: result.session });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { sid } = await params;
	const session = cancelLogin(sid);
	if (!session) return Response.json({ error: "unknown login session" }, { status: 404 });
	return Response.json({ session });
}

/**
 * POST /api/subscriptions/:provider/login — start an OAuth plan login.
 * Returns the login session ({id, status, events, prompt}); poll
 * /api/subscriptions/sessions/:sid for the URL to open / code to show /
 * question to answer.
 */
import { startLogin } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function POST(_req: Request, { params }: Params) {
	const { provider } = await params;
	const result = startLogin(provider);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ session: result.session });
}

/** DELETE /api/subscriptions/:provider — log out: drop the stored OAuth login (idempotent). */
import { logoutSubscription } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function DELETE(_req: Request, { params }: Params) {
	const { provider } = await params;
	await logoutSubscription(provider);
	return Response.json({ ok: true });
}

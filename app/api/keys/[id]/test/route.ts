/**
 * POST /api/keys/:id/test — probe the stored key against its provider's own
 * API (one authenticated GET). The result never carries the key. Same
 * writable-id gate as PUT/DELETE /api/keys/:id.
 */
import { isWritableAuthKey, testProviderKey } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!isWritableAuthKey(id)) {
		return Response.json({ error: `unknown key "${id}"` }, { status: 404 });
	}
	return Response.json(await testProviderKey(id));
}

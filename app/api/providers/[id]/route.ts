/**
 * PUT /api/providers/:id — replace one custom provider (the body's
 * provider.id must equal :id; renames are delete + create). Same body as
 * POST /api/providers. DELETE — remove it and its stored key (idempotent).
 */
import { removeCustomProvider, saveCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || !("provider" in body)) {
		return Response.json({ error: "body must be {provider, apiKey?}" }, { status: 400 });
	}
	const candidate = body.provider;
	if (!candidate || typeof candidate !== "object" || !("id" in candidate) || candidate.id !== id) {
		return Response.json({ error: "provider.id must match the URL" }, { status: 400 });
	}
	const apiKey = "apiKey" in body ? body.apiKey : undefined;
	if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
		return Response.json({ error: "apiKey must be a string or null" }, { status: 400 });
	}
	const result = await saveCustomProvider(candidate, apiKey);
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json({ provider: result.provider });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	await removeCustomProvider(id);
	return Response.json({ ok: true });
}

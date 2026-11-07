/**
 * GET /api/providers — the user-declared custom model endpoints
 * (custom-providers wave). Definitions plus `hasKey`; a stored key is NEVER
 * returned. POST — create/replace one: body {provider, apiKey?}.
 * `apiKey`: omitted = leave the stored key; null or "" = clear; string = set.
 */
import { customProviderViews, saveCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ providers: customProviderViews() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || !("provider" in body)) {
		return Response.json({ error: "body must be {provider, apiKey?}" }, { status: 400 });
	}
	const apiKey = "apiKey" in body ? body.apiKey : undefined;
	if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
		return Response.json({ error: "apiKey must be a string or null" }, { status: 400 });
	}
	const result = await saveCustomProvider(body.provider, apiKey);
	if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
	return Response.json({ provider: result.provider });
}

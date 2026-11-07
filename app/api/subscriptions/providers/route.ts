/**
 * GET /api/subscriptions/providers — every provider offering an OAuth plan login
 * (Claude Pro/Max, GitHub Copilot, ChatGPT/Codex, Gemini CLI, Antigravity …)
 * with its connection state (subscriptions wave). No secrets.
 */
import { subscriptionProviders } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ providers: subscriptionProviders() }, { headers: { "Cache-Control": "no-store" } });
}

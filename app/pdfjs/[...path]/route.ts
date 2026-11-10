import { pdfjsAssetResponse } from "@/src/server";

/** The document viewer's pdf.js worker and assets. Deliberately outside /api: pdf.js
 *  workers fetch these without the desktop window's API capability. Only a fixed
 *  allow-list of the package is served. */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
	const { path } = await params;
	return pdfjsAssetResponse(path);
}

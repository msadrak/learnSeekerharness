import { BodyLimitError, documentErrorResponse, openDocumentPath, openUploadedDocument, readBoundedFormData } from "@/src/server";
import { MAX_DOCUMENT_UPLOAD_BODY_BYTES } from "@/lib/document-limits.ts";

export const dynamic = "force-dynamic";

/** Open a document in the session's viewer: JSON `{ path }` (desktop files stay in place)
 *  or multipart `file` (browser-only mode: stored once per content hash). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		let opened;
		if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
			let form: FormData;
			try {
				form = await readBoundedFormData(req, MAX_DOCUMENT_UPLOAD_BODY_BYTES);
			} catch (err) {
				const oversized = err instanceof BodyLimitError;
				return Response.json(
					{ error: oversized ? "Documents are limited to 100 MB." : "Could not read the upload. It may be incomplete; please select the file again." },
					{ status: oversized ? 413 : 400 },
				);
			}
			const file = form.get("file");
			if (!(file instanceof File)) return Response.json({ error: "A file is required." }, { status: 400 });
			opened = await openUploadedDocument(id, file);
		} else {
			const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
			if (typeof body?.path !== "string" || body.path.length === 0) return Response.json({ error: "A path is required." }, { status: 400 });
			opened = await openDocumentPath(id, body.path, "learner");
		}
		if (!opened) return Response.json({ error: "Not found" }, { status: 404 });
		return Response.json(opened);
	} catch (err) {
		const response = documentErrorResponse(err);
		if (response) return response;
		throw err;
	}
}

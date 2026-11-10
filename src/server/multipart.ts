/** A multipart request exceeded its byte allowance before parsing. */
export class BodyLimitError extends Error {}

/** Bound actual body bytes before multipart parsing, including requests without
 * a trustworthy Content-Length. Next's proxy may truncate first; parsing that
 * incomplete body is a separate, handled refusal, never a partial import. */
export async function readBoundedFormData(request: Request, maxBodyBytes: number): Promise<FormData> {
	if (Number(request.headers.get("content-length")) > maxBodyBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new BodyLimitError();
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("Missing request body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBodyBytes) throw new BodyLimitError();
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} finally {
		// Do not wait for a tee's other consumer to finish before refusing an upload.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

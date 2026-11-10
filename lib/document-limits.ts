/** Document viewer limits shared by the upload route, the registry and the browser. */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
/** One upload request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_DOCUMENT_UPLOAD_BODY_BYTES = 101 * 1024 * 1024;
export const DOCUMENT_ACCEPT = ".pdf,.docx,.md,.markdown";

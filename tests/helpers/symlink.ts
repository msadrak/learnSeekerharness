import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Why this machine cannot create FILE symlinks, or false when it can (use as a node:test `skip` option).
 * Directory junctions never need a privilege, so tests should prefer them; only a test that is about a symlink
 * to a file needs this. On Windows, file symlinks need Developer Mode or an elevated shell.
 */
export const NO_FILE_SYMLINKS: string | false = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-symlink-probe-"));
	try {
		fs.writeFileSync(path.join(dir, "target"), "");
		fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
		return false;
	} catch {
		return "this machine cannot create file symlinks (Windows needs Developer Mode or an elevated shell)";
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})();

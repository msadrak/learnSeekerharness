// Lifecycle of the isolated browser-verification rig (see README.md in this folder).
//
//   node scripts/verify-rig/rig.mjs copy      repo → sibling copy, without node_modules, .next, .git, data, tests or key files (run again to resync)
//   node scripts/verify-rig/rig.mjs install   npm ci inside the copy
//   node scripts/verify-rig/rig.mjs scratch   scratch data dir whose providers.json / settings.json point every model slot at the fake model
//   node scripts/verify-rig/rig.mjs down      delete the copy and the scratch dir
//
// Never link or junction node_modules into the copy, and never use a git worktree: both have wiped the main repo's node_modules.
// `down` removes with fs.rmSync, which unlinks symlinks and junctions instead of following them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const COPY = path.resolve(process.env.LH_RIG_COPY ?? path.join(REPO, "..", "lh-verify-copy"));
const SCRATCH = path.resolve(process.env.LH_RIG_SCRATCH ?? path.join(REPO, "..", "lh-verify-scratch"));
const FAKE_PORT = Number(process.env.LH_RIG_FAKE_PORT ?? 4010);

/** Anything with one of these names, at any depth. */
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git"]);
/** Only at the repo root. */
const SKIP_AT_ROOT = new Set(["data", "tests", "dist", ".visual-smoke", ".fresh-data", "credentials.json", "chatgpt-credentials.json", "auth.json"]);

function copy() {
	fs.mkdirSync(COPY, { recursive: true });
	fs.cpSync(REPO, COPY, {
		recursive: true,
		filter(source) {
			const relative = path.relative(REPO, source);
			if (relative === "") return true;
			const parts = relative.split(path.sep);
			return !parts.some((part) => SKIP_ANYWHERE.has(part)) && !SKIP_AT_ROOT.has(parts[0]);
		},
	});
	console.log(`copied ${REPO} → ${COPY}`);
}

function install() {
	// Run npm's own CLI with this node: the `npm` shim fails to start in Git Bash on Windows.
	const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const [command, args] = fs.existsSync(cli) ? [process.execPath, [cli]] : ["npm", []];
	const result = spawnSync(command, [...args, "ci", "--no-audit", "--no-fund"], { cwd: COPY, stdio: "inherit", shell: command === "npm" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function scratch() {
	const data = path.join(SCRATCH, "data");
	fs.mkdirSync(data, { recursive: true });
	const model = { provider: "fake", id: "m1" };
	fs.writeFileSync(
		path.join(data, "providers.json"),
		`${JSON.stringify({ version: 1, providers: [{ id: "fake", name: "Fake", api: "openai-completions", baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, models: [{ id: "m1", name: "Fake model", contextWindow: 100000, maxTokens: 4096, input: ["text", "image"] }] }] }, null, "\t")}\n`,
	);
	const slot = { model, thinkingLevel: "off" };
	fs.writeFileSync(path.join(data, "settings.json"), `${JSON.stringify({ version: 1, models: { strong: slot, cheap: slot, vision: slot } }, null, "\t")}\n`);
	console.log(`scratch data in ${SCRATCH}`);
	console.log(`next dev:  LH_DATA_DIR=${data} LH_AUTH_FILE=${path.join(SCRATCH, "auth.json")} LH_CREDENTIALS_FILE=${path.join(SCRATCH, "credentials.json")} NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next dev -p 3100   (cwd: ${COPY})`);
}

function down() {
	for (const dir of [COPY, SCRATCH]) {
		if (!fs.existsSync(dir)) continue;
		if (path.resolve(dir) === REPO || REPO.startsWith(path.resolve(dir) + path.sep)) throw new Error(`refusing to delete ${dir}: it contains the repo`);
		fs.rmSync(dir, { recursive: true, force: true });
		console.log(`removed ${dir}`);
	}
}

const actions = { copy, install, scratch, down };
const action = process.argv[2];
if (!(action in actions)) {
	console.error(`usage: node scripts/verify-rig/rig.mjs ${Object.keys(actions).join("|")}`);
	process.exit(2);
}
actions[action]();

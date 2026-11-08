/** Offline visual smoke for the Persian UI redesign: theme (dark/light), RTL
 * and the main surfaces, in en and fa. No providers/accounts.
 * Run: LH_TEST_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/smoke-visual.mjs
 * A temporary HOME/LH_DATA_DIR is seeded (3 graph nodes + one practice chat
 * with a clean "solved" conclude), `next dev` is started on a free port,
 * 20 screenshots are taken and copied to ./.visual-smoke/. Everything else is
 * deleted; only this script's own processes are stopped.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const chromePath = process.env.LH_TEST_CHROME;
if (!chromePath) {
	console.error("smoke-visual: set LH_TEST_CHROME to a Chrome/Chromium executable path");
	process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-visual-"));
const require = createRequire(import.meta.url);
const outDir = path.join(root, ".visual-smoke");
const children = [];
const browsers = [];
const screenshots = [];
const checks = [];
let serverLogs = "";
const pageErrors = [];
const consoleErrors = []; // diagnostics only: benign 404/503s from offline fixtures land here
let origin;
let shuttingDown = false;

async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((resolve) => listener.close(resolve));
	return port;
}
async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	timer.unref();
	await exited;
	clearTimeout(timer);
}
async function startup(child, getLogs, marker, timeout = 120000) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Startup timed out: ${getLogs()}`)), timeout);
		const inspect = () => { if (marker.test(getLogs())) finish(); };
		const exited = (code) => finish(new Error(`Process exited ${code}: ${getLogs()}`));
		function finish(error) {
			clearTimeout(timer);
			child.stdout.off("data", inspect);
			child.stderr.off("data", inspect);
			child.off("exit", exited);
			if (error) reject(error); else resolve();
		}
		child.stdout.on("data", inspect);
		child.stderr.on("data", inspect);
		child.once("exit", exited);
		inspect();
	});
}
// The CSS pipeline may minify hex colours (#ffffff -> #fff); compare the colour, not the spelling.
const expandHex = (value) => (/^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value).toLowerCase();
async function put(pathname, body) {
	const res = await fetch(origin + pathname, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	assert.ok(res.ok, `PUT ${pathname} -> ${res.status} ${await res.text()}`);
}
async function shot(page, name) {
	const file = path.join(home, "visual", `${name}.png`);
	await page.screenshot({ path: file });
	screenshots.push(file);
}
async function settle(page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const chord = async (page, key, modifier = "Control") => {
	await page.keyboard.down(modifier);
	await page.keyboard.press(key);
	await page.keyboard.up(modifier);
};

async function cleanup() {
	shuttingDown = true;
	for (const browser of browsers) await browser.close().catch(() => {});
	for (const child of children) await stop(child);
	fs.rmSync(path.join(home, "chrome-profile"), { recursive: true, force: true, maxRetries: 5 });
}

try {
	fs.mkdirSync(path.join(home, "data"), { recursive: true });
	fs.mkdirSync(path.join(home, "visual"), { recursive: true });
	fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
	const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
	const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
	const fonts = Object.fromEntries(
		["Inter", "JetBrains Mono", "Source Sans 3"].map((family) => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`]),
	);
	// Vazirmatn is a single-axis arabic-subset family; mock it the same way.
	const vazir = getGoogleFontsUrl("Vazirmatn", getFontAxes("Vazirmatn", ["variable"], ["normal"]), "swap");
	fonts[vazir] = "@font-face { font-family: 'Vazirmatn'; src: local('Tahoma'), local('Arial'); font-weight: 100 900; }";
	fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);

	const port = await freePort();
	origin = `http://127.0.0.1:${port}`;
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: home,
		NODE_ENV: "development",
		LH_DATA_DIR: path.join(home, "data"),
		LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1",
		NEXT_TELEMETRY_DISABLED: "1",
		NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs"),
	};
	const seed = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/fixtures/seed-visual.ts"], { cwd: root, env, encoding: "utf8" });
	assert.equal(seed.status, 0, `seed failed: ${seed.stderr || seed.stdout}`);

	const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	children.push(server);
	const capture = (data) => { serverLogs = (serverLogs + data).slice(-28000); };
	server.stdout.on("data", capture);
	server.stderr.on("data", capture);
	await startup(server, () => serverLogs, /Ready in/);

	const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: path.join(home, "chrome-profile"), args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--disable-default-apps"] });
	browsers.push(browser);
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	page.setDefaultTimeout(30000);
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol === "data:" || url.protocol === "about:" || url.origin === origin) return request.continue();
		return request.abort();
	});
	page.on("pageerror", (error) => { if (!shuttingDown) pageErrors.push(error.message); });
	page.on("console", (message) => { if (message.type() === "error" && !shuttingDown) consoleErrors.push(message.text()); });

	for (const language of ["en", "fa"]) {
		for (const mode of ["dark", "light"]) {
			const tag = `${language}-${mode}`;
			await put("/api/settings/appearance", { language, mode });

			await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
			await page.waitForSelector("aside");
			await page.waitForSelector('[data-testid="mastery-legend"]', { timeout: 60000 });
			// The canvas paints after layout settles: some pixel must be non-transparent.
			await page.waitForFunction(() => {
				const canvas = document.querySelector("canvas");
				const ctx = canvas?.getContext("2d");
				if (!canvas || !ctx || canvas.width === 0) return false;
				const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
				for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
				return false;
			}, { timeout: 30000 });
			await settle(page);
			const facts = await page.evaluate(() => {
				const aside = document.querySelector("aside").getBoundingClientRect();
				const root = document.documentElement;
				return {
					dir: root.dir,
					classes: [...root.classList],
					background: getComputedStyle(root).getPropertyValue("--background").trim(),
					asideCenter: aside.left + aside.width / 2,
					innerWidth,
				};
			});
			assert.equal(facts.dir, language === "fa" ? "rtl" : "ltr", `${tag}: html dir`);
			assert.ok(facts.classes.includes(mode), `${tag}: html class ${mode}`);
			assert.equal(expandHex(facts.background), mode === "light" ? "#fafaf9" : "#141414", `${tag}: --background`);
			if (language === "fa") assert.ok(facts.asideCenter > facts.innerWidth / 2, `${tag}: sidebar on the right`);
			else assert.ok(facts.asideCenter < facts.innerWidth / 2, `${tag}: sidebar on the left`);
			await shot(page, `${tag}-home`);

			await page.goto(`${origin}/chat/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
			await page.waitForSelector('[data-testid="example-chips"], [data-file-path-input]');
			await settle(page);
			await shot(page, `${tag}-new-session`);

			await chord(page, "Comma");
			await page.waitForSelector('[data-testid="settings-dialog"]');
			await page.waitForSelector('[data-testid="settings-nav-keys"]');
			await page.waitForSelector('[data-testid="provider-search"]', { timeout: 30000 });
			await settle(page);
			await shot(page, `${tag}-settings-providers`);
			await page.click('[data-testid="settings-nav-appearance"]');
			await page.waitForSelector('[data-testid="select-mode"]');
			await settle(page);
			await shot(page, `${tag}-settings-appearance`);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]'));

			await chord(page, "KeyP");
			await page.waitForSelector("[cmdk-root]");
			await page.waitForFunction(() => !document.querySelector("[cmdk-loading]") && document.querySelectorAll("[cmdk-group]").length >= 4, { timeout: 30000 });
			await settle(page);
			await shot(page, `${tag}-palette`);
			await page.keyboard.press("Escape");
			checks.push(`${tag}: dir/class/--background/sidebar side/mastery legend/graph painted/palette 4 groups`);
		}
	}
	assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.cpSync(path.join(home, "visual"), outDir, { recursive: true });
	console.log(JSON.stringify({ checks: checks.length, detail: checks, screenshots: screenshots.map((file) => path.join(outDir, path.basename(file))) }, null, 2));
	await cleanup();
	fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
	process.exit(0);
} catch (error) {
	console.error(error);
	console.error(serverLogs.slice(-4000));
	if (pageErrors.length) console.error(`page errors:\n${pageErrors.join("\n")}`);
	if (consoleErrors.length) console.error(`console errors:\n${consoleErrors.join("\n")}`);
	await cleanup();
	console.error(`temp dir kept for inspection: ${home}`);
	process.exit(1);
}

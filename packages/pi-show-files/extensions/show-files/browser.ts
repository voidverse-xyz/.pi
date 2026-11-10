/**
 * Optional headless-browser snapshot + "open externally" for the HTML preview.
 *
 * Everything here is **local-only and best-effort**:
 *   - files are loaded as `file://` URLs (via `pathToFileURL`, so odd paths are
 *     encoded safely — no string interpolation into a shell);
 *   - outbound requests are forced through an unreachable loopback proxy, with
 *     DNS resolution and background networking disabled as additional layers;
 *     `data:` URIs and the local `file://` render remain available;
 *   - browsers/openers are spawned with an **argv array** through `execFile`
 *     (never a shell), with a timeout;
 *   - every entry point resolves to a typed result the caller renders as a
 *     graceful fallback — nothing here throws into the render loop.
 *
 * No new dependency: it reuses a Chromium that's already on the machine
 * (Playwright's cached download, or a system Chrome/Chromium), and the platform
 * opener (`xdg-open`/`open`). If none is found the caller shows best-effort text.
 */

import { execFile } from "node:child_process";
import { constants, mkdirSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

async function isExecutable(p: string): Promise<boolean> {
	try {
		await access(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

// Chromium binaries Playwright has already downloaded (headless-shell first — it's
// the lighter, screenshot-oriented build), newest cache dirs tried in order.
async function playwrightChromiums(): Promise<string[]> {
	const root = join(homedir(), ".cache", "ms-playwright");
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	names.sort().reverse(); // higher build number first
	const shells: string[] = [];
	const fulls: string[] = [];
	for (const n of names) {
		if (n.startsWith("chromium_headless_shell-"))
			shells.push(join(root, n, "chrome-headless-shell-linux64", "chrome-headless-shell"));
		else if (n.startsWith("chromium-")) fulls.push(join(root, n, "chrome-linux64", "chrome"));
	}
	return [...shells, ...fulls];
}

const SYSTEM_CHROMIUMS = [
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/microsoft-edge",
	"/snap/bin/chromium",
	"/opt/google/chrome/chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * Locate a usable Chromium: an explicit override first, then Playwright's cached
 * download, then a system install. Returns null when nothing is found.
 */
export async function findChromium(): Promise<string | null> {
	const envOverrides = [process.env.PI_SHOW_FILES_CHROMIUM, process.env.CHROME_PATH].filter(
		(p): p is string => !!p,
	);
	const candidates = [...envOverrides, ...(await playwrightChromiums()), ...SYSTEM_CHROMIUMS];
	for (const p of candidates) {
		if (await isExecutable(p)) return p;
	}
	return null;
}

export type SnapshotResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Screenshot a local HTML file to `outPng` with a headless Chromium. Network is
 * blocked; the process is killed after `timeoutMs`.
 */
export function renderHtmlSnapshot(
	chromium: string,
	htmlAbs: string,
	outPng: string,
	opts: { width?: number; height?: number; timeoutMs?: number } = {},
): Promise<SnapshotResult> {
	const width = opts.width ?? 1000;
	const height = opts.height ?? 1400;
	// chrome-headless-shell is already headless; only full Chrome needs the flag.
	const isHeadlessShell = /headless[-_]shell/.test(chromium);
	const args = [
		...(isHeadlessShell ? [] : ["--headless=new"]),
		"--disable-gpu",
		"--no-sandbox",
		"--hide-scrollbars",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		// Blocking DNS alone does not stop direct-IP requests. Force HTTP(S) and
		// websocket traffic through a closed loopback port as the primary network
		// barrier; the bypass rule also prevents Chromium exempting loopback URLs.
		"--proxy-server=http://127.0.0.1:9",
		"--proxy-bypass-list=<-loopback>",
		"--disable-extensions",
		"--disable-sync",
		"--mute-audio",
		"--host-resolver-rules=MAP * ~NOTFOUND", // block ALL outbound name resolution
		"--force-color-profile=srgb",
		"--run-all-compositor-stages-before-draw",
		`--window-size=${width},${height}`,
		`--screenshot=${outPng}`,
		pathToFileURL(htmlAbs).href,
	];
	return new Promise((resolve) => {
		// Owner-only private dir so no other user can pre-plant a symlink at the
		// predictable screenshot path (Chromium follows symlinks when writing).
		try {
			mkdirSync(dirname(outPng), { recursive: true, mode: 0o700 });
		} catch (e) {
			resolve({ ok: false, error: (e instanceof Error ? e.message : String(e)).split("\n")[0] });
			return;
		}
		execFile(
			chromium,
			args,
			{ timeout: opts.timeoutMs ?? 15000, maxBuffer: 8 * 1024 * 1024 },
			(err) => {
				if (err) {
					resolve({ ok: false, error: (err.message || String(err)).split("\n")[0] });
					return;
				}
				resolve({ ok: true, path: outPng });
			},
		);
	});
}

/** Deterministic temp path for a file's snapshot (so it can be mtime-cached). */
export function snapshotPathFor(htmlAbs: string): string {
	let h = 5381;
	for (let i = 0; i < htmlAbs.length; i++) h = (((h << 5) + h) ^ htmlAbs.charCodeAt(i)) >>> 0;
	return join(tmpdir(), "pi-show-files", `snap-${h.toString(36)}.png`);
}

/** Open a local file/URL in the platform's default app. Local-only; no network. */
export function openExternally(target: string): Promise<{ ok: boolean; error?: string }> {
	let cmd: string;
	let args: string[];
	if (process.platform === "darwin") {
		cmd = "open";
		args = [target];
	} else if (process.platform === "win32") {
		// `cmd.exe` re-parses its argv for metacharacters even when Node passes an
		// argv array, so a hostile path could inject a command. Refuse instead.
		if (/[&<>^|"%`\r\n]/.test(target)) {
			return Promise.resolve({ ok: false, error: "refused: path contains shell metacharacters" });
		}
		cmd = "cmd";
		args = ["/c", "start", "", target];
	} else {
		cmd = "xdg-open";
		args = [target];
	}
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5000 }, (err) => {
			resolve(err ? { ok: false, error: (err.message || String(err)).split("\n")[0] } : { ok: true });
		});
	});
}

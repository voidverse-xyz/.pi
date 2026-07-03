export interface ReviewGroup {
	id: string;
	title: string;
	layer: string;
	paths: string[];
	commitMessage: string;
	order: number;
}

const LOCAL_DEV_PATHS = new Set([
	"backend/server.js",
	"backend/routes/routes.js",
	"backend/notify/socket/socket.js",
]);

const LOCAL_DEV_PATTERNS = [
	/https:\/\//i,
	/http:\/\//i,
	/certificate\.generate/i,
	/createServer\s*\(\s*\{/i,
];

export function isLocalDevOnly(path: string, diff: string): boolean {
	const norm = path.replace(/\\/g, "/");
	if (!LOCAL_DEV_PATHS.has(norm)) return false;
	if (!diff.trim()) return false;
	const meaningful = diff
		.split("\n")
		.filter((line) => line.startsWith("+") || line.startsWith("-"))
		.filter((line) => !line.startsWith("+++") && !line.startsWith("---"));
	if (meaningful.length === 0) return false;
	return meaningful.every((line) => LOCAL_DEV_PATTERNS.some((p) => p.test(line)));
}

interface PathMeta {
	path: string;
	kind: string;
	domain: string;
	layer: string;
	order: number;
}

function metaForPath(path: string): PathMeta {
	const p = path.replace(/\\/g, "/").toLowerCase();

	if (p.includes("/database/schemas/") || p.endsWith("/database/database.js")) {
		return { path, kind: "schema", domain: "db", layer: "schema", order: 10 };
	}

	const controller = p.match(/\/controllers\/([^/]+)\.js$/);
	if (controller) {
		const name = controller[1]!;
		const domain = name === "index" ? "barrel" : name.replace(/\.js$/, "");
		return { path, kind: "controller", domain, layer: "backend", order: 20 };
	}

	const route = p.match(/\/routes\/([^/]+)\.js$/);
	if (route) {
		const name = route[1]!;
		const domain = name === "index" || name === "routes" ? "mount" : name.replace(/\.js$/, "");
		return { path, kind: "routes", domain, layer: "backend", order: 30 };
	}

	if (p.includes("/services/backend/")) {
		const svc = p.match(/\/services\/backend\/([^/]+)\.js$/);
		const domain = svc?.[1]?.replace(/\.js$/, "") ?? "service";
		return { path, kind: "service", domain, layer: "frontend", order: 40 };
	}

	if (p.includes("/hooks/") || p.includes("/context/")) {
		const hook = p.match(/\/(hooks|context)\/([^/]+)/);
		const domain = hook?.[2]?.replace(/\.js$/, "") ?? "hook";
		return { path, kind: "hook", domain, layer: "frontend", order: 50 };
	}

	if (p.includes("/app/") || p.includes("/components/")) {
		const ui = p.match(/\/(app|components)\/(.+)/);
		const domain = ui?.[2]?.split("/")[0] ?? "ui";
		return { path, kind: "ui", domain, layer: "frontend", order: 60 };
	}

	if (p.includes("/languages/") || (p.endsWith(".json") && p.includes("lang"))) {
		return { path, kind: "i18n", domain: "i18n", layer: "i18n", order: 70 };
	}

	if (p.startsWith("plan/") || p.startsWith("plans/") || p.startsWith("docs/")) {
		const doc = p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "doc";
		return { path, kind: "docs", domain: doc, layer: "docs", order: 90 };
	}

	const parts = p.split("/");
	const domain = parts.length > 1 ? parts[parts.length - 2]! : "misc";
	return { path, kind: "other", domain, layer: "other", order: 80 };
}

function groupKey(meta: PathMeta): string {
	if (meta.kind === "schema") return "schema:db";
	if (meta.kind === "i18n") return "i18n:all";
	return `${meta.kind}:${meta.domain}`;
}

function titleFor(kind: string, domain: string, paths: string[]): string {
	switch (kind) {
		case "schema":
			return "Schema + DB wiring";
		case "controller":
			return domain === "barrel" ? "Controller barrel" : `${capitalize(domain)} controller`;
		case "routes":
			return domain === "mount" ? "Route mounts" : `${capitalize(domain)} routes`;
		case "service":
			return `${capitalize(domain)} service facade`;
		case "hook":
			return `${capitalize(domain)} hook/context`;
		case "ui":
			return `${capitalize(domain)} UI`;
		case "i18n":
			return "i18n translations";
		case "docs":
			return `${capitalize(domain)} docs`;
		default: {
			const file = paths[0]?.split("/").pop() ?? "changes";
			return file;
		}
	}
}

function commitMessageFor(kind: string, domain: string, paths: string[]): string {
	switch (kind) {
		case "schema":
			return "add schema changes";
		case "controller":
			return domain === "barrel" ? "update controller exports" : `add ${domain} controller`;
		case "routes":
			return domain === "mount" ? "update route mounts" : `add ${domain} routes`;
		case "service":
			return `add ${domain} service facade`;
		case "hook":
			return `add ${domain} hook`;
		case "ui":
			return `update ${domain} ui`;
		case "i18n":
			return "update translations";
		case "docs":
			return `update ${domain} docs`;
		default: {
			const base = paths[0]?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "changes";
			return `update ${base}`;
		}
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function classifyPaths(
	paths: string[],
	excluded: string[] = [],
): { groups: ReviewGroup[]; excluded: string[] } {
	const excludedSet = new Set(excluded.map((p) => p.replace(/\\/g, "/")));
	const buckets = new Map<string, { meta: PathMeta; paths: string[] }>();

	for (const path of paths) {
		const norm = path.replace(/\\/g, "/");
		if (excludedSet.has(norm)) continue;

		const meta = metaForPath(norm);
		const key = groupKey(meta);
		const existing = buckets.get(key);
		if (existing) {
			existing.paths.push(norm);
		} else {
			buckets.set(key, { meta, paths: [norm] });
		}
	}

	const groups: ReviewGroup[] = [...buckets.values()]
		.map(({ meta, paths: groupPaths }) => {
			const sortedPaths = [...groupPaths].sort();
			return {
				id: groupKey(meta),
				title: titleFor(meta.kind, meta.domain, sortedPaths),
				layer: meta.layer,
				paths: sortedPaths,
				commitMessage: commitMessageFor(meta.kind, meta.domain, sortedPaths),
				order: meta.order,
			};
		})
		.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

	return { groups, excluded: [...excludedSet] };
}

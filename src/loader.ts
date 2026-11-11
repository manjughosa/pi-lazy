import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, LoadResult, ResolvedEntry } from "./types.ts";

type AnyHandler = (event: any, ctx: ExtensionContext) => any;

interface LoadTrack {
	tools: string[];
	commands: string[];
	commandHandlers: Map<string, (args: string, ctx: any) => Promise<void>>;
	sessionStartHandlers: AnyHandler[];
	resourcesDiscoverHandlers: AnyHandler[];
}

function fileUrl(path: string): string {
	return pathToFileURL(path).href;
}

function asFactory(mod: unknown): ((api: ExtensionAPI) => unknown) | null {
	if (typeof mod === "function") return mod as (api: ExtensionAPI) => unknown;
	if (mod && typeof mod === "object") {
		const d = (mod as { default?: unknown }).default;
		if (typeof d === "function") return d as (api: ExtensionAPI) => unknown;
	}
	return null;
}

let cachedPiPackageJson: string | null | undefined;
let cachedCreateJiti: ((...args: any[]) => any) | null | undefined;
let aliasesPromise: Promise<Record<string, string>> | undefined;
let jitiInstance: any | undefined;

function resolvePiPackageJson(): string | null {
	if (cachedPiPackageJson !== undefined) return cachedPiPackageJson;
	const finish = (value: string | null) => (cachedPiPackageJson = value);

	// Prefer the package that is executing Pi, not pi-lazy's own installed copy.
	// The latter can be an older version and its private dependency tree is not
	// necessarily compatible with the live host runtime.
	try {
		const bin = realpathSync(process.argv[1] ?? "");
		let dir = dirname(bin);
		for (let i = 0; i < 10; i++) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const name = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string }).name;
					if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent") {
						return finish(pkgPath);
					}
				} catch {
					/* ignore */
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* ignore */
	}

	try {
		const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
		return finish(fileURLToPath(url));
	} catch {
		/* fall through */
	}
	try {
		const require = createRequire(import.meta.url);
		return finish(require.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		/* fall through */
	}

	// Common global npm layouts
	for (const guess of [
		join(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
		join(dirname(process.execPath), "../lib/node_modules/@mariozechner/pi-coding-agent/package.json"),
	]) {
		if (existsSync(guess)) return finish(guess);
	}

	return finish(null);
}

function resolveJitiCreate(): ((...args: any[]) => any) | null {
	if (cachedCreateJiti !== undefined) return cachedCreateJiti;
	const candidates: string[] = [];
	const pushResolve = (from: string) => {
		try {
			const require = createRequire(from);
			candidates.push(require.resolve("jiti"));
		} catch {
			/* ignore */
		}
	};

	const piPkg = resolvePiPackageJson();
	if (piPkg) pushResolve(piPkg);
	pushResolve(fileURLToPath(import.meta.url));

	// Walk up from pi package for nested node_modules/jiti (global npm installs)
	if (piPkg) {
		let dir = dirname(piPkg);
		for (let i = 0; i < 6; i++) {
			const nested = join(dir, "node_modules", "jiti", "lib", "jiti.cjs");
			const nestedPkg = join(dir, "node_modules", "jiti", "package.json");
			if (existsSync(nestedPkg)) {
				try {
					const require = createRequire(nestedPkg);
					candidates.push(require.resolve("jiti"));
				} catch {
					if (existsSync(nested)) candidates.push(nested);
				}
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	for (const jitiPath of [...new Set(candidates)]) {
		try {
			const require = createRequire(jitiPath);
			const jitiMod = require(jitiPath) as {
				createJiti?: (...args: any[]) => any;
			} & ((...args: any[]) => any);

			// jiti v2 CJS: default export is createJiti itself AND has .createJiti.
			// Prefer the real createJiti API (returns instance with async .import).
			// Never wrap with sync j(path) — that rewrites ESM/TS to CJS and breaks
			// top-level await (e.g. rpiv-todo / rpiv-ask-user-question).
			if (typeof jitiMod?.createJiti === "function") {
				return (cachedCreateJiti = jitiMod.createJiti.bind(jitiMod));
			}
			if (typeof jitiMod === "function") {
				// Already createJiti (or a compatible factory).
				return (cachedCreateJiti = jitiMod);
			}
		} catch {
			/* try next */
		}
	}
	return (cachedCreateJiti = null);
}

async function importFactory(extensionPath: string): Promise<((api: ExtensionAPI) => unknown) | null> {
	// Prefer native import for compiled JS; fall back to jiti for TS.
	if (/\.(js|mjs|cjs)$/.test(extensionPath)) {
		try {
			const mod = await import(fileUrl(extensionPath));
			const factory = asFactory(mod);
			if (factory) return factory;
		} catch (err) {
			// Loader/linker failures occur before evaluation and are safe to retry with
			// jiti's host aliases. Runtime exceptions may already have performed side
			// effects, so preserve them instead of evaluating the module a second time.
			const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
			if (!(err instanceof SyntaxError) && ![
				"ERR_MODULE_NOT_FOUND",
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
				"ERR_UNKNOWN_FILE_EXTENSION",
			].includes(code)) {
				throw new Error(`Failed to import extension module ${extensionPath}: ${err instanceof Error ? err.message : String(err)}`, {
					cause: err,
				});
			}
		}
	}

	const createJiti = resolveJitiCreate();
	if (!createJiti) {
		throw new Error("jiti not available — cannot load TypeScript extensions at runtime");
	}

	try {
		const aliases = await (aliasesPromise ??= buildAliases());
		const jiti = (jitiInstance ??= createJiti(import.meta.url, {
			interopDefault: true,
			// Keep transformed extension modules fresh across reloads.
			moduleCache: false,
			alias: aliases,
		}));
		// jiti v2 instance exposes async .import (handles top-level await).
		if (jiti && typeof jiti.import === "function") {
			try {
				const mod = await jiti.import(extensionPath, { default: true });
				const factory = asFactory(mod);
				if (factory) return factory;
			} catch (firstErr) {
				// Retry namespace import only when default unwrap looked wrong,
				// not when the module itself failed to evaluate.
				const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
				if (/does not provide an export named|default/i.test(msg)) {
					const mod = await jiti.import(extensionPath);
					return asFactory(mod);
				}
				throw firstErr;
			}
			const mod = await jiti.import(extensionPath);
			return asFactory(mod);
		}
		throw new Error("jiti instance missing async import()");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to import extension module ${extensionPath}: ${message}`, { cause: err });
	}
}

function tryResolveFrom(fromPkgJson: string | null, spec: string): string | null {
	if (!fromPkgJson) return null;
	try {
		const require = createRequire(fromPkgJson);
		return require.resolve(spec);
	} catch {
		return null;
	}
}

function firstExisting(...paths: Array<string | null | undefined>): string | null {
	for (const p of paths) {
		if (p && existsSync(p)) return p;
	}
	return null;
}

async function buildAliases(): Promise<Record<string, string>> {
	const aliases: Record<string, string> = {};
	const piPkg = resolvePiPackageJson();
	const piRoot = piPkg ? dirname(piPkg) : null;
	// npm can nest Pi's dependencies or hoist them beside the scoped package.
	// Check both layouts; global Bun/npm installs use the latter.
	const piModuleRoots = piRoot
		? [join(piRoot, "node_modules"), dirname(dirname(piRoot))]
		: [];
	const requireFromPi = piPkg ? createRequire(piPkg) : null;
	const piModule = (pkg: string, file: string) =>
		firstExisting(...piModuleRoots.map((root) => join(root, pkg, file)));

	const set = (spec: string, path: string | null | undefined) => {
		if (path) aliases[spec] = path;
	};

	const resolveSpec = (spec: string): string | null => {
		try {
			const resolved = import.meta.resolve(spec);
			return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
		} catch {
			/* fall through */
		}
		if (requireFromPi) {
			try {
				return requireFromPi.resolve(spec);
			} catch {
				/* ignore */
			}
		}
		return tryResolveFrom(piPkg, spec);
	};

	// Core pi packages — prefer explicit dist files (package exports are often incomplete)
	const piCoding = firstExisting(
		resolveSpec("@earendil-works/pi-coding-agent"),
		piRoot ? join(piRoot, "dist/index.js") : null,
	);
	set("@earendil-works/pi-coding-agent", piCoding);
	set("@mariozechner/pi-coding-agent", piCoding);

	const agentCore = firstExisting(
		resolveSpec("@earendil-works/pi-agent-core"),
		piModule("@earendil-works/pi-agent-core", "dist/index.js"),
	);
	set("@earendil-works/pi-agent-core", agentCore);
	set("@mariozechner/pi-agent-core", agentCore);

	const tui = firstExisting(
		resolveSpec("@earendil-works/pi-tui"),
		piModule("@earendil-works/pi-tui", "dist/index.js"),
	);
	set("@earendil-works/pi-tui", tui);
	set("@mariozechner/pi-tui", tui);

	const aiCompat = firstExisting(
		resolveSpec("@earendil-works/pi-ai/compat"),
		piModule("@earendil-works/pi-ai", "dist/compat.js"),
	);
	const aiOauth = firstExisting(
		resolveSpec("@earendil-works/pi-ai/oauth"),
		piModule("@earendil-works/pi-ai", "dist/oauth.js"),
	);
	const aiProviders = firstExisting(
		resolveSpec("@earendil-works/pi-ai/providers/all"),
		piModule("@earendil-works/pi-ai", "dist/providers/all.js"),
	);

	// IMPORTANT: register longer subpaths before the package root alias
	set("@earendil-works/pi-ai/providers/all", aiProviders);
	set("@mariozechner/pi-ai/providers/all", aiProviders);
	set("@earendil-works/pi-ai/oauth", aiOauth);
	set("@mariozechner/pi-ai/oauth", aiOauth);
	set("@earendil-works/pi-ai/compat", aiCompat);
	set("@mariozechner/pi-ai/compat", aiCompat);
	const ai = firstExisting(
		resolveSpec("@earendil-works/pi-ai"),
		piModule("@earendil-works/pi-ai", "dist/index.js"),
	);
	set("@earendil-works/pi-ai", ai);
	set("@mariozechner/pi-ai", ai);

	// typebox subpath exports must be exact
	const typebox = resolveSpec("typebox");
	const typeboxCompile = resolveSpec("typebox/compile");
	const typeboxValue = resolveSpec("typebox/value");
	set("typebox", typebox);
	set("typebox/compile", typeboxCompile);
	set("typebox/value", typeboxValue);
	set("@sinclair/typebox", typebox);
	set("@sinclair/typebox/compile", typeboxCompile);
	set("@sinclair/typebox/value", typeboxValue);

	return aliases;
}

function createTrackingApi(pi: ExtensionAPI, track: LoadTrack): ExtensionAPI {
	const on = (event: string, handler: AnyHandler) => {
		if (event === "session_start") track.sessionStartHandlers.push(handler);
		if (event === "resources_discover") track.resourcesDiscoverHandlers.push(handler);
		return (pi.on as Function)(event, handler);
	};

	const registerTool = (tool: { name: string }) => {
		track.tools.push(tool.name);
		return pi.registerTool(tool as any);
	};

	const registerCommand = (name: string, options: unknown) => {
		track.commands.push(name);
		const handler = (options as { handler?: (args: string, ctx: any) => Promise<void> } | null)?.handler;
		if (typeof handler === "function") track.commandHandlers.set(name, handler);
		return pi.registerCommand(name, options as any);
	};

	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "on") return on;
			if (prop === "registerTool") return registerTool;
			if (prop === "registerCommand") return registerCommand;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;
}

async function importEntryFactories(entry: ResolvedEntry): Promise<ExtensionFactory[]> {
	const factories: ExtensionFactory[] = [];
	for (const extPath of entry.extensionPaths) {
		const factory = await importFactory(extPath);
		if (!factory) throw new Error(`Extension does not export a default factory: ${extPath}`);
		factories.push(factory);
	}
	return factories;
}

/**
 * Import an entry's modules without activating it.
 *
 * Importing is the expensive half of a load (transform plus module-graph
 * evaluation) and it touches nothing but the module registry, so it may overlap
 * with another entry's activation. Running factories stays strictly serial —
 * only the import is moved off the critical path.
 *
 * A failure here happened before any factory ran, so nothing was mutated: the
 * prefetch is simply dropped and the real load re-imports and reports the error.
 */
export function prefetchEntry(entry: ResolvedEntry): Promise<void> {
	if (entry.prefetchPromise) return entry.prefetchPromise;
	if (entry.prefetchedFactories) return Promise.resolve();
	if (entry.state !== "pending" || !entry.moduleLazyReady) return Promise.resolve();
	if (!entry.packageRoot || entry.extensionPaths.length === 0) return Promise.resolve();

	const started = Date.now();
	const promise = importEntryFactories(entry)
		.then((factories) => {
			entry.prefetchedFactories = factories;
			entry.prefetchMs = Date.now() - started;
		})
		.catch(() => {
			entry.prefetchedFactories = undefined;
		})
		.finally(() => {
			if (entry.prefetchPromise === promise) entry.prefetchPromise = undefined;
		});
	entry.prefetchPromise = promise;
	return promise;
}

/**
 * Load a resolved lazy package into the live host ExtensionAPI.
 */
export async function loadResolvedEntry(
	entry: ResolvedEntry,
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	deps: {
		loadDependency: (name: string, ancestry: string[]) => Promise<LoadResult>;
		ancestry?: string[];
	},
): Promise<LoadResult> {
	const { spec } = entry;
	const ancestry = deps.ancestry ?? [];
	if (ancestry.includes(spec.name)) {
		return {
			ok: false,
			name: spec.name,
			error: `dependency cycle: ${[...ancestry, spec.name].join(" -> ")}`,
		};
	}
	if (entry.state === "loaded") {
		return {
			ok: true,
			name: spec.name,
			alreadyLoaded: true,
			tools: entry.loadedTools,
			commands: entry.loadedCommands,
			// IMPORTANT: LoadResult must stay structuredClone-safe. Never include
			// commandHandlers (Map<string, Function>) here — pi structuredClones
			// tool-result `details` for the transcript and functions throw
			// DataCloneError: "... could not be cloned."
			loadMs: entry.loadMs,
		};
	}
	if (entry.state === "poisoned") {
		return { ok: false, name: spec.name, error: entry.error ?? "partial activation failed — restart required" };
	}
	if (entry.loadPromise) return entry.loadPromise;
	if (entry.state === "loading") {
		return { ok: false, name: spec.name, error: "already loading" };
	}
	if (!entry.moduleLazyReady) {
		return {
			ok: false,
			name: spec.name,
			error: "not module-lazy ready — run /lazy migrate and restart pi (package still eager-loaded by settings)",
		};
	}
	if (!entry.packageRoot || entry.extensionPaths.length === 0) {
		return {
			ok: false,
			name: spec.name,
			error: entry.packageRoot
				? "no extension entrypoints found in package"
				: `package not installed for ${spec.source}`,
		};
	}

	entry.state = "loading";
	const loadPromise = (async (): Promise<LoadResult> => {
		const started = Date.now();
		entry.initializationWarnings = [];
		const track: LoadTrack = {
			tools: [],
			commands: [],
			commandHandlers: new Map(),
			sessionStartHandlers: [],
			resourcesDiscoverHandlers: [],
		};
		const api = createTrackingApi(pi, track);
		let activationStarted = false;

		try {
			for (const dep of spec.dependencies ?? []) {
				const depResult = await deps.loadDependency(dep, [...ancestry, spec.name]);
				if (!depResult.ok && !depResult.alreadyLoaded) {
					throw new Error(`dependency ${dep} failed: ${depResult.error}`);
				}
			}

			// Import every entrypoint before allowing any factory to mutate the live API.
			// A prefetch may already have done this, or may still be in flight — wait
			// for it rather than transforming the same modules a second time.
			if (entry.prefetchPromise) await entry.prefetchPromise;
			const factories = entry.prefetchedFactories ?? (await importEntryFactories(entry));
			entry.prefetchedFactories = undefined;
			for (const factory of factories) {
				activationStarted = true;
				await factory(api);
			}

			// Replay session_start for factories that registered too late for the real event.
			if (ctx && track.sessionStartHandlers.length > 0) {
				const event = { type: "session_start" as const, reason: "startup" as const };
				for (const handler of track.sessionStartHandlers) {
					try {
						await handler(event, ctx);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						entry.initializationWarnings.push(`session_start: ${message}`);
						console.error(`[pi-lazy] session_start handler error in ${spec.name}: ${message}`);
					}
				}
			}

			// Best-effort resources_discover (skills/prompts already eager if not filtered)
			if (ctx && track.resourcesDiscoverHandlers.length > 0) {
				const event = { type: "resources_discover" as const, cwd: ctx.cwd, reason: "startup" as const };
				for (const handler of track.resourcesDiscoverHandlers) {
					try {
						await handler(event, ctx);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						entry.initializationWarnings.push(`resources_discover: ${message}`);
					}
				}
			}

			// Activate newly registered tools additively when possible
			if (track.tools.length > 0 && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
				try {
					const active = pi.getActiveTools();
					const merged = [...new Set([...active, ...track.tools])];
					pi.setActiveTools(merged);
				} catch {
					/* runtime may not be bound yet */
				}
			}

			const loadMs = Date.now() - started;
			entry.state = "loaded";
			entry.loadedAt = Date.now();
			entry.loadMs = loadMs;
			entry.loadedTools = [...new Set(track.tools)];
			entry.loadedCommands = [...new Set(track.commands)];
			entry.loadedCommandHandlers = track.commandHandlers;
			entry.error = undefined;

			return {
				ok: true,
				name: spec.name,
				loadMs,
				tools: entry.loadedTools,
				commands: entry.loadedCommands,
				// IMPORTANT: LoadResult must stay structuredClone-safe. Never include
				// commandHandlers (Map<string, Function>) here — pi structuredClones
				// tool-result `details` for the transcript and functions throw
				// DataCloneError: "... could not be cloned."
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			entry.state = activationStarted ? "poisoned" : "error";
			entry.error = activationStarted ? `${message} (partial activation may have occurred — restart required)` : message;
			return { ok: false, name: spec.name, error: entry.error };
		}
	})();
	entry.loadPromise = loadPromise;
	try {
		return await loadPromise;
	} finally {
		entry.loadPromise = undefined;
	}
}

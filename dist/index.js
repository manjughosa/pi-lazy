// src/index.ts
import { Type } from "typebox";
import { getAgentDir as getAgentDir4 } from "@earendil-works/pi-coding-agent";

// src/config.ts
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var CONFIG_VERSION = 1;
var DEFAULT_AFTER_START_INITIAL_DELAY_MS = 750;
function getLazyConfigPath(agentDir = getAgentDir()) {
  return join(agentDir, "lazy.json");
}
function getSettingsPath(agentDir = getAgentDir()) {
  return join(agentDir, "settings.json");
}
function defaultConfig() {
  return {
    version: 1,
    defaults: { lazy: true },
    auto: false,
    autoLoadLimit: 1,
    afterStartBatchSize: 1,
    afterStartDelayMs: 0,
    afterStartInitialDelayMs: DEFAULT_AFTER_START_INITIAL_DELAY_MS,
    afterStartPauseDuringTurn: true,
    afterStartAdaptiveYield: true,
    afterStartPrefetch: true,
    managerCompat: true,
    footerCompat: true,
    specs: [
      // VeryLazy — common after UI is up
      {
        name: "subagents",
        source: "npm:pi-subagents",
        lazy: "after-start",
        priority: 10,
        description: "Subagent orchestration"
      },
      {
        name: "todo",
        source: "npm:@juicesharp/rpiv-todo",
        lazy: "after-start",
        priority: 20,
        cmd: ["todo"],
        tools: ["todo"]
      },
      {
        name: "ask-user",
        source: "npm:@juicesharp/rpiv-ask-user-question",
        lazy: "after-start",
        priority: 20,
        tools: ["ask_user_question"]
      },
      // On-demand — heavy / situational
      {
        name: "web",
        source: "npm:pi-web-access",
        lazy: true,
        cmd: ["web"],
        tools: ["web_search", "fetch_content", "get_search_content"],
        keywords: ["web search", "search the web", "fetch url", "youtube"],
        description: "Web search / fetch / video"
      },
      {
        name: "mcp",
        source: "npm:pi-mcp-adapter",
        lazy: true,
        cmd: ["mcp"],
        keywords: ["mcp", "playwright", "clickup"],
        description: "MCP server bridge"
      }
    ]
  };
}
function normalizeMode(value, fallback = true) {
  if (value === false || value === true || value === "after-start") return value;
  return fallback;
}
function normalizePositiveInteger(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizeNonNegativeInteger(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeStringArray(value, field, issues) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array of strings`);
    return void 0;
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push(`${field} contains an empty or non-string value`);
      continue;
    }
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length > 0 ? result : void 0;
}
function normalizeSpec(value, index, defaultsLazy, issues) {
  const field = `specs[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object`);
    return null;
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!name) issues.push(`${field}.name must be a non-empty string`);
  if (!source) issues.push(`${field}.source must be a non-empty string`);
  if (!name || !source) return null;
  const lazy = value.lazy === void 0 ? defaultsLazy : normalizeMode(value.lazy, defaultsLazy);
  if (value.lazy !== void 0 && lazy === defaultsLazy && value.lazy !== defaultsLazy) {
    issues.push(`${field}.lazy must be false, true, or "after-start"`);
  }
  let priority;
  if (value.priority !== void 0) {
    if (typeof value.priority === "number" && Number.isFinite(value.priority) && Number.isInteger(value.priority)) {
      priority = value.priority;
    } else {
      issues.push(`${field}.priority must be a finite integer`);
    }
  }
  const description = value.description === void 0 || typeof value.description === "string" ? value.description : void 0;
  if (value.description !== void 0 && description === void 0) {
    issues.push(`${field}.description must be a string`);
  }
  return {
    name,
    source,
    lazy,
    ...priority === void 0 ? {} : { priority },
    ...description === void 0 ? {} : { description },
    cmd: normalizeStringArray(value.cmd, `${field}.cmd`, issues),
    tools: normalizeStringArray(value.tools, `${field}.tools`, issues),
    keys: normalizeStringArray(value.keys, `${field}.keys`, issues),
    event: normalizeStringArray(value.event, `${field}.event`, issues),
    keywords: normalizeStringArray(value.keywords, `${field}.keywords`, issues),
    dependencies: normalizeStringArray(value.dependencies, `${field}.dependencies`, issues)
  };
}
function reportConfigIssues(path, issues) {
  for (const issue of issues) console.error(`[pi-lazy] invalid ${path}: ${issue}`);
}
function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    const mode = existsSync(path) ? statSync(path).mode : 384;
    fd = openSync(tempPath, "wx", mode);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = void 0;
    renameSync(tempPath, path);
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
    }
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
    }
    throw err;
  }
}
function loadConfig(agentDir = getAgentDir()) {
  const path = getLazyConfigPath(agentDir);
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    try {
      saveConfig(cfg, agentDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pi-lazy] failed to create lazy.json: ${message}`);
    }
    return cfg;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) throw new Error("root must be a JSON object");
    const raw = parsed;
    const issues = [];
    const supportedVersion = raw.version === void 0 || raw.version === CONFIG_VERSION;
    if (!supportedVersion) {
      issues.push(`unsupported version ${String(raw.version)} (expected ${CONFIG_VERSION})`);
    }
    const defaults = isRecord(raw.defaults) ? raw.defaults : {};
    if (raw.defaults !== void 0 && !isRecord(raw.defaults)) issues.push("defaults must be an object");
    const defaultsLazy = normalizeMode(defaults.lazy, true);
    if (defaults.lazy !== void 0 && defaultsLazy === true && defaults.lazy !== true) {
      issues.push('defaults.lazy must be false, true, or "after-start"');
    }
    const specs = [];
    const names = /* @__PURE__ */ new Set();
    if (!supportedVersion) {
      issues.push("unsupported configuration is disabled until it is migrated");
    } else if (!Array.isArray(raw.specs)) {
      issues.push("specs must be an array; no packages will be managed until it is fixed");
    } else {
      for (let i = 0; i < raw.specs.length; i++) {
        const spec = normalizeSpec(raw.specs[i], i, defaultsLazy, issues);
        if (!spec) continue;
        if (names.has(spec.name)) {
          issues.push(`duplicate spec name '${spec.name}' at specs[${i}]`);
          continue;
        }
        names.add(spec.name);
        specs.push(spec);
      }
    }
    for (const spec of specs) {
      for (const dependency of spec.dependencies ?? []) {
        if (!names.has(dependency)) issues.push(`spec '${spec.name}' references unknown dependency '${dependency}'`);
      }
    }
    reportConfigIssues(path, issues);
    return {
      version: 1,
      defaults: { lazy: defaultsLazy },
      auto: raw.auto !== false,
      autoLoadLimit: normalizePositiveInteger(raw.autoLoadLimit, 1),
      afterStartBatchSize: normalizePositiveInteger(raw.afterStartBatchSize, 1),
      afterStartDelayMs: normalizeNonNegativeInteger(raw.afterStartDelayMs, 0),
      afterStartInitialDelayMs: normalizeNonNegativeInteger(
        raw.afterStartInitialDelayMs,
        DEFAULT_AFTER_START_INITIAL_DELAY_MS
      ),
      afterStartPauseDuringTurn: normalizeBoolean(raw.afterStartPauseDuringTurn, true),
      afterStartAdaptiveYield: normalizeBoolean(raw.afterStartAdaptiveYield, true),
      afterStartPrefetch: normalizeBoolean(raw.afterStartPrefetch, true),
      managerCompat: raw.managerCompat === true,
      footerCompat: raw.footerCompat === false ? false : true,
      specs
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pi-lazy] failed to parse lazy.json: ${message}`);
    return defaultConfig();
  }
}
function saveConfig(config, agentDir = getAgentDir()) {
  const path = getLazyConfigPath(agentDir);
  atomicWriteJson(path, config);
  return path;
}
function isManagedLazy(spec) {
  return spec.lazy !== false;
}

// src/loader.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
function fileUrl(path) {
  return pathToFileURL(path).href;
}
function asFactory(mod) {
  if (typeof mod === "function") return mod;
  if (mod && typeof mod === "object") {
    const d = mod.default;
    if (typeof d === "function") return d;
  }
  return null;
}
var cachedPiPackageJson;
var cachedCreateJiti;
var aliasesPromise;
var jitiInstance;
function resolvePiPackageJson() {
  if (cachedPiPackageJson !== void 0) return cachedPiPackageJson;
  const finish = (value) => cachedPiPackageJson = value;
  try {
    const bin = realpathSync(process.argv[1] ?? "");
    let dir = dirname2(bin);
    for (let i = 0; i < 10; i++) {
      const pkgPath = join2(dir, "package.json");
      if (existsSync2(pkgPath)) {
        try {
          const name = JSON.parse(readFileSync2(pkgPath, "utf-8")).name;
          if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent") {
            return finish(pkgPath);
          }
        } catch {
        }
      }
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  try {
    const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
    return finish(fileURLToPath(url));
  } catch {
  }
  try {
    const require2 = createRequire(import.meta.url);
    return finish(require2.resolve("@earendil-works/pi-coding-agent/package.json"));
  } catch {
  }
  for (const guess of [
    join2(dirname2(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
    join2(dirname2(process.execPath), "../lib/node_modules/@mariozechner/pi-coding-agent/package.json")
  ]) {
    if (existsSync2(guess)) return finish(guess);
  }
  return finish(null);
}
function resolveJitiCreate() {
  if (cachedCreateJiti !== void 0) return cachedCreateJiti;
  const candidates = [];
  const pushResolve = (from) => {
    try {
      const require2 = createRequire(from);
      candidates.push(require2.resolve("jiti"));
    } catch {
    }
  };
  const piPkg = resolvePiPackageJson();
  if (piPkg) pushResolve(piPkg);
  pushResolve(fileURLToPath(import.meta.url));
  if (piPkg) {
    let dir = dirname2(piPkg);
    for (let i = 0; i < 6; i++) {
      const nested = join2(dir, "node_modules", "jiti", "lib", "jiti.cjs");
      const nestedPkg = join2(dir, "node_modules", "jiti", "package.json");
      if (existsSync2(nestedPkg)) {
        try {
          const require2 = createRequire(nestedPkg);
          candidates.push(require2.resolve("jiti"));
        } catch {
          if (existsSync2(nested)) candidates.push(nested);
        }
        break;
      }
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const jitiPath of [...new Set(candidates)]) {
    try {
      const require2 = createRequire(jitiPath);
      const jitiMod = require2(jitiPath);
      if (typeof jitiMod?.createJiti === "function") {
        return cachedCreateJiti = jitiMod.createJiti.bind(jitiMod);
      }
      if (typeof jitiMod === "function") {
        return cachedCreateJiti = jitiMod;
      }
    } catch {
    }
  }
  return cachedCreateJiti = null;
}
async function importFactory(extensionPath) {
  if (/\.(js|mjs|cjs)$/.test(extensionPath)) {
    try {
      const mod = await import(fileUrl(extensionPath));
      const factory = asFactory(mod);
      if (factory) return factory;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (!(err instanceof SyntaxError) && ![
        "ERR_MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_UNKNOWN_FILE_EXTENSION"
      ].includes(code)) {
        throw new Error(`Failed to import extension module ${extensionPath}: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err
        });
      }
    }
  }
  const createJiti = resolveJitiCreate();
  if (!createJiti) {
    throw new Error("jiti not available \u2014 cannot load TypeScript extensions at runtime");
  }
  try {
    const aliases = await (aliasesPromise ??= buildAliases());
    const jiti = jitiInstance ??= createJiti(import.meta.url, {
      interopDefault: true,
      // Keep transformed extension modules fresh across reloads.
      moduleCache: false,
      alias: aliases
    });
    if (jiti && typeof jiti.import === "function") {
      try {
        const mod2 = await jiti.import(extensionPath, { default: true });
        const factory = asFactory(mod2);
        if (factory) return factory;
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (/does not provide an export named|default/i.test(msg)) {
          const mod2 = await jiti.import(extensionPath);
          return asFactory(mod2);
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
function tryResolveFrom(fromPkgJson, spec) {
  if (!fromPkgJson) return null;
  try {
    const require2 = createRequire(fromPkgJson);
    return require2.resolve(spec);
  } catch {
    return null;
  }
}
function firstExisting(...paths) {
  for (const p of paths) {
    if (p && existsSync2(p)) return p;
  }
  return null;
}
async function buildAliases() {
  const aliases = {};
  const piPkg = resolvePiPackageJson();
  const piRoot = piPkg ? dirname2(piPkg) : null;
  const piModuleRoots = piRoot ? [join2(piRoot, "node_modules"), dirname2(dirname2(piRoot))] : [];
  const requireFromPi = piPkg ? createRequire(piPkg) : null;
  const piModule = (pkg, file) => firstExisting(...piModuleRoots.map((root) => join2(root, pkg, file)));
  const set = (spec, path) => {
    if (path) aliases[spec] = path;
  };
  const resolveSpec = (spec) => {
    try {
      const resolved = import.meta.resolve(spec);
      return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    } catch {
    }
    if (requireFromPi) {
      try {
        return requireFromPi.resolve(spec);
      } catch {
      }
    }
    return tryResolveFrom(piPkg, spec);
  };
  const piCoding = firstExisting(
    resolveSpec("@earendil-works/pi-coding-agent"),
    piRoot ? join2(piRoot, "dist/index.js") : null
  );
  set("@earendil-works/pi-coding-agent", piCoding);
  set("@mariozechner/pi-coding-agent", piCoding);
  const agentCore = firstExisting(
    resolveSpec("@earendil-works/pi-agent-core"),
    piModule("@earendil-works/pi-agent-core", "dist/index.js")
  );
  set("@earendil-works/pi-agent-core", agentCore);
  set("@mariozechner/pi-agent-core", agentCore);
  const tui = firstExisting(
    resolveSpec("@earendil-works/pi-tui"),
    piModule("@earendil-works/pi-tui", "dist/index.js")
  );
  set("@earendil-works/pi-tui", tui);
  set("@mariozechner/pi-tui", tui);
  const aiCompat = firstExisting(
    resolveSpec("@earendil-works/pi-ai/compat"),
    piModule("@earendil-works/pi-ai", "dist/compat.js")
  );
  const aiOauth = firstExisting(
    resolveSpec("@earendil-works/pi-ai/oauth"),
    piModule("@earendil-works/pi-ai", "dist/oauth.js")
  );
  const aiProviders = firstExisting(
    resolveSpec("@earendil-works/pi-ai/providers/all"),
    piModule("@earendil-works/pi-ai", "dist/providers/all.js")
  );
  set("@earendil-works/pi-ai/providers/all", aiProviders);
  set("@mariozechner/pi-ai/providers/all", aiProviders);
  set("@earendil-works/pi-ai/oauth", aiOauth);
  set("@mariozechner/pi-ai/oauth", aiOauth);
  set("@earendil-works/pi-ai/compat", aiCompat);
  set("@mariozechner/pi-ai/compat", aiCompat);
  const ai = firstExisting(
    resolveSpec("@earendil-works/pi-ai"),
    piModule("@earendil-works/pi-ai", "dist/index.js")
  );
  set("@earendil-works/pi-ai", ai);
  set("@mariozechner/pi-ai", ai);
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
function createTrackingApi(pi, track) {
  const on = (event, handler) => {
    if (event === "session_start") track.sessionStartHandlers.push(handler);
    if (event === "resources_discover") track.resourcesDiscoverHandlers.push(handler);
    return pi.on(event, handler);
  };
  const registerTool = (tool) => {
    track.tools.push(tool.name);
    return pi.registerTool(tool);
  };
  const registerCommand = (name, options) => {
    track.commands.push(name);
    const handler = options?.handler;
    if (typeof handler === "function") track.commandHandlers.set(name, handler);
    return pi.registerCommand(name, options);
  };
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") return on;
      if (prop === "registerTool") return registerTool;
      if (prop === "registerCommand") return registerCommand;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
async function importEntryFactories(entry) {
  const factories = [];
  for (const extPath of entry.extensionPaths) {
    const factory = await importFactory(extPath);
    if (!factory) throw new Error(`Extension does not export a default factory: ${extPath}`);
    factories.push(factory);
  }
  return factories;
}
function prefetchEntry(entry) {
  if (entry.prefetchPromise) return entry.prefetchPromise;
  if (entry.prefetchedFactories) return Promise.resolve();
  if (entry.state !== "pending" || !entry.moduleLazyReady) return Promise.resolve();
  if (!entry.packageRoot || entry.extensionPaths.length === 0) return Promise.resolve();
  const started = Date.now();
  const promise = importEntryFactories(entry).then((factories) => {
    entry.prefetchedFactories = factories;
    entry.prefetchMs = Date.now() - started;
  }).catch(() => {
    entry.prefetchedFactories = void 0;
  }).finally(() => {
    if (entry.prefetchPromise === promise) entry.prefetchPromise = void 0;
  });
  entry.prefetchPromise = promise;
  return promise;
}
async function loadResolvedEntry(entry, pi, ctx, deps) {
  const { spec } = entry;
  const ancestry = deps.ancestry ?? [];
  if (ancestry.includes(spec.name)) {
    return {
      ok: false,
      name: spec.name,
      error: `dependency cycle: ${[...ancestry, spec.name].join(" -> ")}`
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
      loadMs: entry.loadMs
    };
  }
  if (entry.state === "poisoned") {
    return { ok: false, name: spec.name, error: entry.error ?? "partial activation failed \u2014 restart required" };
  }
  if (entry.loadPromise) return entry.loadPromise;
  if (entry.state === "loading") {
    return { ok: false, name: spec.name, error: "already loading" };
  }
  if (!entry.moduleLazyReady) {
    return {
      ok: false,
      name: spec.name,
      error: "not module-lazy ready \u2014 run /lazy migrate and restart pi (package still eager-loaded by settings)"
    };
  }
  if (!entry.packageRoot || entry.extensionPaths.length === 0) {
    return {
      ok: false,
      name: spec.name,
      error: entry.packageRoot ? "no extension entrypoints found in package" : `package not installed for ${spec.source}`
    };
  }
  entry.state = "loading";
  const loadPromise = (async () => {
    const started = Date.now();
    const track = {
      tools: [],
      commands: [],
      commandHandlers: /* @__PURE__ */ new Map(),
      sessionStartHandlers: [],
      resourcesDiscoverHandlers: []
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
      if (entry.prefetchPromise) await entry.prefetchPromise;
      const factories = entry.prefetchedFactories ?? await importEntryFactories(entry);
      entry.prefetchedFactories = void 0;
      for (const factory of factories) {
        activationStarted = true;
        await factory(api);
      }
      if (ctx && track.sessionStartHandlers.length > 0) {
        const event = { type: "session_start", reason: "startup" };
        for (const handler of track.sessionStartHandlers) {
          try {
            await handler(event, ctx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[pi-lazy] session_start handler error in ${spec.name}: ${message}`);
          }
        }
      }
      if (ctx && track.resourcesDiscoverHandlers.length > 0) {
        const event = { type: "resources_discover", cwd: ctx.cwd, reason: "startup" };
        for (const handler of track.resourcesDiscoverHandlers) {
          try {
            await handler(event, ctx);
          } catch {
          }
        }
      }
      if (track.tools.length > 0 && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
        try {
          const active = pi.getActiveTools();
          const merged = [.../* @__PURE__ */ new Set([...active, ...track.tools])];
          pi.setActiveTools(merged);
        } catch {
        }
      }
      const loadMs = Date.now() - started;
      entry.state = "loaded";
      entry.loadedAt = Date.now();
      entry.loadMs = loadMs;
      entry.loadedTools = [...new Set(track.tools)];
      entry.loadedCommands = [...new Set(track.commands)];
      entry.loadedCommandHandlers = track.commandHandlers;
      entry.error = void 0;
      return {
        ok: true,
        name: spec.name,
        loadMs,
        tools: entry.loadedTools,
        commands: entry.loadedCommands
        // IMPORTANT: LoadResult must stay structuredClone-safe. Never include
        // commandHandlers (Map<string, Function>) here — pi structuredClones
        // tool-result `details` for the transcript and functions throw
        // DataCloneError: "... could not be cloned."
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.state = activationStarted ? "poisoned" : "error";
      entry.error = activationStarted ? `${message} (partial activation may have occurred \u2014 restart required)` : message;
      return { ok: false, name: spec.name, error: entry.error };
    }
  })();
  entry.loadPromise = loadPromise;
  try {
    return await loadPromise;
  } finally {
    entry.loadPromise = void 0;
  }
}

// src/migrate.ts
import { copyFileSync, existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";

// src/resolve.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join3, relative, resolve, sep } from "node:path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeIsDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function npmPackageName(source) {
  if (source.startsWith("npm:")) {
    const rest = source.slice(4);
    if (rest.startsWith("@")) {
      const m = rest.match(/^(@[^/]+\/[^@]+)/);
      return m?.[1] ?? rest;
    }
    return rest.split("@")[0] ?? rest;
  }
  if (!source.includes(":") && !source.startsWith(".") && !source.startsWith("/")) {
    return source.startsWith("@") ? source.match(/^(@[^/]+\/[^@]+)/)?.[1] ?? source : source.split("@")[0];
  }
  return null;
}
function npmPackageIdentity(source) {
  const name = npmPackageName(source);
  if (!name) return null;
  const rest = source.startsWith("npm:") ? source.slice(4) : source;
  const selector = rest.slice(name.length);
  return { name, ...selector.startsWith("@") && selector.length > 1 ? { selector: selector.slice(1) } : {} };
}
function resolvePackageRoot(source, agentDir = getAgentDir2(), cwd = process.cwd()) {
  const npmName = npmPackageName(source);
  if (npmName) {
    const candidates = [
      join3(agentDir, "npm", "node_modules", npmName),
      join3(cwd, ".pi", "npm", "node_modules", npmName)
    ];
    for (const c of candidates) {
      if (safeIsDirectory(c)) return c;
    }
    return null;
  }
  if (source.startsWith("git:") || source.startsWith("https://") || source.startsWith("http://") || source.startsWith("ssh://")) {
    const gitRoot = join3(agentDir, "git");
    if (existsSync3(gitRoot)) {
    }
    return null;
  }
  const local = resolve(cwd, source);
  if (safeIsDirectory(local)) return local;
  return null;
}
function readPiManifest(packageRoot) {
  const pj = join3(packageRoot, "package.json");
  if (!existsSync3(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync3(pj, "utf-8"));
    if (!isRecord2(pkg) || !isRecord2(pkg.pi)) return null;
    const extensions = Array.isArray(pkg.pi.extensions) ? pkg.pi.extensions.filter((entry) => typeof entry === "string" && entry.length > 0) : void 0;
    return { extensions };
  } catch {
    return null;
  }
}
function isExtensionFile(name) {
  return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mts") || name.endsWith(".mjs");
}
function resolveExtensionEntries(packageRoot) {
  const manifest = readPiManifest(packageRoot);
  if (manifest?.extensions?.length) {
    const entries = [];
    for (const extPath of manifest.extensions) {
      const resolved = resolve(packageRoot, extPath);
      const withinRoot = relative(packageRoot, resolved);
      if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;
      if (!existsSync3(resolved)) continue;
      let st;
      try {
        st = statSync2(resolved);
      } catch {
        continue;
      }
      if (st.isFile() && isExtensionFile(resolved)) {
        entries.push(resolved);
        continue;
      }
      if (st.isDirectory()) {
        const indexTs2 = join3(resolved, "index.ts");
        const indexJs2 = join3(resolved, "index.js");
        if (existsSync3(indexTs2)) entries.push(indexTs2);
        else if (existsSync3(indexJs2)) entries.push(indexJs2);
        else {
          try {
            for (const item of readdirSync(resolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
              if (item.isFile() && isExtensionFile(item.name)) {
                entries.push(join3(resolved, item.name));
              }
            }
          } catch {
          }
        }
      }
    }
    if (entries.length > 0) return entries;
  }
  const indexTs = join3(packageRoot, "index.ts");
  const indexJs = join3(packageRoot, "index.js");
  if (existsSync3(indexTs)) return [indexTs];
  if (existsSync3(indexJs)) return [indexJs];
  return [];
}
function resolveSpecPaths(spec, agentDir = getAgentDir2(), cwd = process.cwd()) {
  const packageRoot = resolvePackageRoot(spec.source, agentDir, cwd);
  if (!packageRoot) {
    return { packageRoot: null, extensionPaths: [] };
  }
  return {
    packageRoot,
    extensionPaths: resolveExtensionEntries(packageRoot)
  };
}
function isModuleLazyInSettings(source, settingsPackages) {
  const matches = [];
  for (const entry of settingsPackages) {
    if (typeof entry === "string") {
      if (sourcesMatch(entry, source)) matches.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry;
      if (typeof obj.source === "string" && sourcesMatch(obj.source, source)) matches.push(entry);
    }
  }
  if (matches.length !== 1) return false;
  const match = matches[0];
  return !!match && typeof match === "object" && Array.isArray(match.extensions) && match.extensions.length === 0;
}
function normalizeSourceKey(source) {
  const trimmed = source.trim();
  const npm = npmPackageName(trimmed);
  if (npm) return `npm:${trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed}`;
  return trimmed;
}
function sourcesMatch(left, right) {
  const leftNpm = npmPackageIdentity(left);
  const rightNpm = npmPackageIdentity(right);
  if (leftNpm || rightNpm) {
    if (!leftNpm || !rightNpm || leftNpm.name !== rightNpm.name) return false;
    return !leftNpm.selector || !rightNpm.selector || leftNpm.selector === rightNpm.selector;
  }
  return normalizeSourceKey(left) === normalizeSourceKey(right);
}
function findSettingsPackageIndex(settingsPackages, source) {
  return findSettingsPackageIndices(settingsPackages, source)[0] ?? -1;
}
function discoverSpecsFromSettings(settingsPackages, existing) {
  const covered = new Set(existing.map((spec) => normalizeSourceKey(spec.source)));
  const discovered = [];
  const seen = /* @__PURE__ */ new Set();
  settingsPackages.forEach((entry) => {
    let source;
    let extensionFilter;
    if (typeof entry === "string") {
      source = entry;
    } else if (entry && typeof entry === "object" && typeof entry.source === "string") {
      source = entry.source;
      extensionFilter = entry.extensions;
    } else {
      return;
    }
    const key = normalizeSourceKey(source);
    if (covered.has(key) || seen.has(key)) return;
    seen.add(key);
    if (Array.isArray(extensionFilter) && extensionFilter.length > 0) return;
    discovered.push({
      name: specNameFromSource(source),
      source,
      lazy: false,
      keywords: [specNameFromSource(source)],
      description: "auto-discovered from settings.json \u2014 stays eager; set lazy/after-start by hand to defer it"
    });
  });
  return discovered;
}
function discoverLocalExtensions(agentDir, existing) {
  const extensionsDir = join3(agentDir, "extensions");
  if (!existsSync3(extensionsDir)) return [];
  const covered = new Set(existing.map((spec) => normalizeSourceKey(spec.source)));
  const found = [];
  let entries;
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, isDirectory: true }));
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dir = join3(extensionsDir, entry.name);
    const manifestPath = join3(dir, "package.json");
    if (!existsSync3(manifestPath)) continue;
    let declared = [];
    try {
      const manifest = JSON.parse(readFileSync3(manifestPath, "utf-8"));
      const list = manifest.pi?.extensions;
      if (!Array.isArray(list)) continue;
      declared = list.filter((v) => typeof v === "string");
    } catch {
      continue;
    }
    if (declared.length === 0) continue;
    const usable = declared.filter((rel) => {
      const resolved = resolve(dir, rel);
      if (!existsSync3(resolved)) return false;
      try {
        return statSync2(resolved).isFile();
      } catch {
        return false;
      }
    });
    if (usable.length === 0) continue;
    const source = dir;
    if (covered.has(normalizeSourceKey(source))) continue;
    const name = specNameFromSource(source);
    found.push({
      spec: {
        name,
        source,
        lazy: false,
        keywords: [name],
        description: "local extension under extensions/ \u2014 stays eager; set lazy/after-start by hand to defer it"
      },
      // Register it as a package so the entrypoint is pinned explicitly, but keep the
      // package eager. The extension was already being loaded by the extensions/
      // walk before this entry existed; registering it must not silently change when
      // that happens, so the default is the status quo and deferral is opt-in.
      settingsEntry: { source, extensions: usable.map((rel) => `+${rel.replace(/\\/g, "/")}`) }
    });
  }
  return found;
}
function specNameFromSource(source) {
  const bare = source.startsWith("npm:") ? source.slice(4) : source;
  const name = npmPackageName(source);
  if (name) return name;
  const normalized = bare.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? bare;
}
function findSettingsPackageIndices(settingsPackages, source) {
  const indices = [];
  settingsPackages.forEach((entry, index) => {
    if (typeof entry === "string") {
      if (sourcesMatch(entry, source)) indices.push(index);
      return;
    }
    if (entry && typeof entry === "object" && typeof entry.source === "string") {
      if (sourcesMatch(entry.source, source)) indices.push(index);
      return;
    }
  });
  return indices;
}

// src/migrate.ts
function packageSource(spec) {
  if (spec.source.startsWith("npm:") || spec.source.startsWith("git:") || spec.source.startsWith("http://") || spec.source.startsWith("https://") || spec.source.startsWith("ssh://") || spec.source.startsWith("/") || spec.source.startsWith(".")) {
    return spec.source;
  }
  return `npm:${spec.source}`;
}
function migrateSettings(agentDir = getAgentDir3()) {
  const settingsPath = getSettingsPath(agentDir);
  const config = loadConfig(agentDir);
  const managed = config.specs.filter(isManagedLazy);
  if (!existsSync4(settingsPath)) {
    return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: "settings.json not found" };
  }
  let settings;
  try {
    const parsed = JSON.parse(readFileSync4(settingsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings.json root must be an object");
    }
    settings = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: message };
  }
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const changed = [];
  const skipped = [];
  const added = [];
  for (const spec of config.specs) {
    const matches = findSettingsPackageIndices(packages, spec.source);
    if (matches.length > 1) {
      return {
        ok: false,
        settingsPath,
        changed,
        skipped,
        added,
        error: `duplicate settings.packages entries for ${spec.source} at indices ${matches.join(", ")}`
      };
    }
  }
  for (const spec of managed) {
    const source = packageSource(spec);
    const idx = findSettingsPackageIndex(packages, spec.source);
    if (idx === -1) {
      skipped.push(`${spec.name} (not registered; left alone)`);
      continue;
    }
    const current = packages[idx];
    if (typeof current === "string") {
      packages[idx] = { source: current, extensions: [] };
      changed.push(spec.name);
      continue;
    }
    if (current && typeof current === "object") {
      const filters = Array.isArray(current.extensions) ? current.extensions : [];
      if (filters.length === 0) {
        skipped.push(spec.name);
        continue;
      }
      const blocking = filters.some((t) => typeof t === "string" && (t.trim().startsWith("-") || t.trim().startsWith("!")));
      if (blocking) {
        skipped.push(`${spec.name} (yielded: entry has exclusions)`);
        continue;
      }
      const obj = { ...current };
      obj.extensions = [];
      if (typeof obj.source !== "string") obj.source = source;
      packages[idx] = obj;
      changed.push(spec.name);
      continue;
    }
    skipped.push(spec.name);
  }
  for (const spec of config.specs.filter((s) => s.lazy === false)) {
    const idx = findSettingsPackageIndex(packages, spec.source);
    if (idx === -1) continue;
    const current = packages[idx];
    if (!current || typeof current !== "object") continue;
    const obj = current;
    if (!(Array.isArray(obj.extensions) && obj.extensions.length === 0 && typeof obj.source === "string")) {
      continue;
    }
    const restored = { ...obj };
    delete restored.extensions;
    packages[idx] = Object.keys(restored).length === 1 ? restored.source : restored;
    changed.push(`${spec.name} (restored eager)`);
  }
  if (changed.length === 0) {
    return { ok: true, settingsPath, changed, skipped, added };
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.bak.lazy-${stamp}`;
  try {
    copyFileSync(settingsPath, backupPath);
    settings.packages = packages;
    atomicWriteJson(settingsPath, settings);
    return { ok: true, backupPath, settingsPath, changed, skipped, added };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, backupPath, settingsPath, changed, skipped, added, error: message };
  }
}

// src/index.ts
import { performance } from "node:perf_hooks";
import { copyFileSync as copyFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync5, readdirSync as readdirSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname3, join as join4 } from "node:path";
var MAX_ADAPTIVE_YIELD_MS = 250;
var PAUSE_TIMEOUT_MS = 6e4;
function sleep(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}
function drainResumeWaiters(rt) {
  const waiters = rt.resumeWaiters;
  rt.resumeWaiters = [];
  for (const resolve2 of waiters) resolve2();
}
function waitWhilePaused(rt, generation) {
  if (!rt.turnActive) return Promise.resolve();
  if (rt.queueCancelled || generation !== rt.sessionGeneration) return Promise.resolve();
  return new Promise((resolve2) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2();
    };
    const timer = setTimeout(finish, PAUSE_TIMEOUT_MS);
    timer.unref?.();
    rt.resumeWaiters.push(finish);
  });
}
function readSettingsPackages(agentDir) {
  const path = getSettingsPath(agentDir);
  if (!existsSync5(path)) return [];
  try {
    const settings = JSON.parse(readFileSync5(path, "utf-8"));
    return Array.isArray(settings.packages) ? settings.packages : [];
  } catch {
    return [];
  }
}
function buildCatalog(config, agentDir) {
  const packages = readSettingsPackages(agentDir);
  const map = /* @__PURE__ */ new Map();
  for (const spec of config.specs) {
    const managed = isManagedLazy(spec);
    const moduleLazyReady = managed && isModuleLazyInSettings(spec.source, packages);
    let state;
    if (!managed) {
      state = "eager";
    } else if (!moduleLazyReady) {
      state = "eager";
    } else {
      state = "pending";
    }
    map.set(spec.name, {
      spec,
      // Avoid filesystem/package.json scans for packages that are never loaded.
      packageRoot: "",
      extensionPaths: [],
      moduleLazyReady,
      state,
      normalizedKeywords: (spec.keywords ?? []).map((keyword) => keyword.toLowerCase())
    });
  }
  return map;
}
function formatStatus(rt) {
  const all = [...rt.entries.values()];
  const loaded = all.filter((e) => e.state === "loaded").length;
  const pending = all.filter((e) => e.state === "pending").length;
  const eager = all.filter((e) => e.state === "eager").length;
  const errors = all.filter((e) => e.state === "error" || e.state === "poisoned").length;
  const parts = [`lazy ${loaded}\u2191`, `${pending}\xB7`, `${eager}\u26A1`];
  if (errors) parts.push(`${errors}\u2717`);
  if (rt.restartRequired) parts.push("restart required");
  return parts.join(" ");
}
function scanIntoConfig(pi, rt, ctx, agentDir) {
  const currentPath = getLazyConfigPath(agentDir);
  const hadExisting = existsSync5(currentPath);
  const existingConfig = hadExisting ? loadConfig(agentDir) : defaultConfig();
  const before = existingConfig.specs.length;
  const settingsPath = getSettingsPath(agentDir);
  let packages = [];
  let settingsWarning = "";
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      packages = parsed && typeof parsed === "object" && Array.isArray(parsed.packages) ? parsed.packages : [];
    } catch (err) {
      settingsWarning = `settings.json could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    settingsWarning = "settings.json not found \u2014 no packages could be scanned.";
  }
  const discovered = discoverSpecsFromSettings(packages, existingConfig.specs);
  const localExts = discoverLocalExtensions(agentDir, [...existingConfig.specs, ...discovered]);
  const localSettingsAdded = localExts.filter(
    (e) => !packages.some((p) => (typeof p === "string" ? p : p?.source) === e.settingsEntry.source)
  );
  const next = { ...existingConfig, specs: [...existingConfig.specs, ...discovered, ...localExts.map((e) => e.spec)] };
  let backup = "";
  if (hadExisting) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    backup = `${currentPath}.bak.init-${stamp}`;
    copyFileSync2(currentPath, backup);
  }
  if (localSettingsAdded.length > 0 && existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.packages)) {
        parsed.packages = [...parsed.packages, ...localSettingsAdded.map((e) => e.settingsEntry)];
        atomicWriteJson(settingsPath, parsed);
      }
    } catch (err) {
      settingsWarning = `settings.json could not be updated with local extensions: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const path = saveConfig(next, agentDir);
  rt.restartRequired = true;
  rt.config = next;
  refreshStatus(pi, rt, ctx);
  const lines = [];
  if (!hadExisting) {
    lines.push(`no lazy.json found \u2014 created ${path} with default specs (${before}).`);
  } else {
    lines.push(`kept ${before} existing spec${before === 1 ? "" : "s"} \u2192 ${path}${backup ? `
backup: ${backup}` : ""}`);
  }
  if (discovered.length === 0) {
    lines.push("no new packages to add \u2014 config already covers settings.json.");
  } else {
    lines.push(`added ${discovered.length} discovered package${discovered.length === 1 ? "" : "s"}:`);
    for (const spec of discovered) lines.push(`  + ${spec.name}`);
    lines.push("left eager (lazy:false) \u2014 set lazy:true or after-start by hand to defer them.");
  }
  if (localExts.length > 0) {
    lines.push(`added ${localExts.length} local extension${localExts.length === 1 ? "" : "s"} from extensions/:`);
    for (const e of localExts) lines.push(`  + ${e.spec.name}  \u2192  ${e.settingsEntry.extensions.join(", ")}`);
    lines.push("left eager (lazy:false) \u2014 set lazy:true or after-start by hand to defer them.");
  }
  if (settingsWarning) lines.push(settingsWarning);
  return lines;
}
function snapshotDir(agentDir) {
  return join4(agentDir, "lazy-snapshots");
}
function snapshotPathFor(agentDir, name) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/:*?"<>|]/.test(trimmed)) return null;
  return join4(snapshotDir(agentDir), `${trimmed}.json`);
}
function snapshotSave(agentDir, name) {
  const path = snapshotPathFor(agentDir, name);
  const fail = (error) => ({ ok: false, path: path ?? "", specCount: 0, packageCount: 0, overwrote: false, error });
  if (!path) return fail(`invalid snapshot name "${name}" (avoid / \\ : * ? " < > | )`);
  const config = loadConfig(agentDir);
  let packages = null;
  const settingsPath = getSettingsPath(agentDir);
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    } catch (err) {
      return fail(`settings.json unreadable, cannot capture packages: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    return fail("settings.json not found \u2014 cannot capture a loading scheme without it");
  }
  try {
    mkdirSync2(snapshotDir(agentDir), { recursive: true });
    let previous;
    if (existsSync5(path)) {
      previous = `${path}.bak-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync2(path, previous);
    }
    atomicWriteJson(path, {
      name: name.trim(),
      savedAt: (/* @__PURE__ */ new Date()).toISOString(),
      version: 2,
      config,
      settings: { packages }
    });
    return { ok: true, path, specCount: config.specs.length, packageCount: packages.length, overwrote: previous !== void 0, previous };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
function snapshotRestore(agentDir, name) {
  const path = snapshotPathFor(agentDir, name);
  const empty = { ok: false, specCount: 0, packageCount: 0, added: [], removed: [], migrated: 0, backups: [] };
  if (!path || !existsSync5(path)) return { ...empty, error: `no saved snapshot named "${name}"` };
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync5(path, "utf-8"));
  } catch (err) {
    return { ...empty, error: `snapshot unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!snapshot.config || !Array.isArray(snapshot.config.specs)) {
    return { ...empty, error: "snapshot has no spec list \u2014 was it written by an older version?" };
  }
  if (!Array.isArray(snapshot.settings?.packages)) {
    return { ...empty, error: "snapshot carries no settings.packages \u2014 save it again with this version (a spec-only snapshot cannot register its packages)" };
  }
  const current = loadConfig(agentDir);
  const settingsPath = getSettingsPath(agentDir);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backups = [];
  const currentPackages = (() => {
    if (!existsSync5(settingsPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      return Array.isArray(parsed?.packages) ? parsed.packages : [];
    } catch {
      return [];
    }
  })();
  const sourceOf = (entry) => {
    const s = typeof entry === "string" ? entry : entry?.source;
    return typeof s === "string" ? s : null;
  };
  const nextSources = new Set(snapshot.settings.packages.map(sourceOf).filter((s) => s !== null));
  const removed = currentPackages.map(sourceOf).filter((s) => s !== null && !nextSources.has(s));
  const currentNames = new Set(current.specs.map((s) => s.name));
  const added = snapshot.config.specs.map((s) => s.name).filter((n) => !currentNames.has(n));
  try {
    if (existsSync5(getLazyConfigPath(agentDir))) {
      const b = `${getLazyConfigPath(agentDir)}.bak.snapshot-${stamp}`;
      copyFileSync2(getLazyConfigPath(agentDir), b);
      backups.push(b);
    }
    if (existsSync5(settingsPath)) {
      const b = `${settingsPath}.bak.snapshot-${stamp}`;
      copyFileSync2(settingsPath, b);
      backups.push(b);
    }
    let settings = null;
    if (existsSync5(settingsPath)) {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    }
    if (settings) {
      settings.packages = snapshot.settings.packages;
      atomicWriteJson(settingsPath, settings);
    }
    saveConfig(snapshot.config, agentDir);
    const migration = migrateSettings(agentDir);
    return {
      ok: migration.ok,
      specCount: snapshot.config.specs.length,
      packageCount: snapshot.settings.packages.length,
      added,
      removed,
      migrated: migration.changed.length,
      backups,
      ...migration.ok ? {} : { error: `migrate failed: ${migration.error}` }
    };
  } catch (err) {
    return { ...empty, backups, error: err instanceof Error ? err.message : String(err) };
  }
}
function snapshotDelete(agentDir, name) {
  const path = snapshotPathFor(agentDir, name);
  if (!path || !existsSync5(path)) return { ok: false, error: `no saved snapshot named "${name}"` };
  try {
    unlinkSync2(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function snapshotList(agentDir) {
  const dir = snapshotDir(agentDir);
  if (!existsSync5(dir)) return [];
  try {
    return readdirSync2(dir).filter((f) => f.endsWith(".json") && !f.includes(".bak-")).map((f) => {
      try {
        const parsed = JSON.parse(readFileSync5(join4(dir, f), "utf-8"));
        return {
          name: f.replace(/\.json$/, ""),
          specCount: parsed.config?.specs?.length ?? 0,
          packageCount: parsed.settings?.packages?.length ?? 0,
          savedAt: parsed.savedAt ?? "unknown"
        };
      } catch {
        return { name: f.replace(/\.json$/, ""), specCount: 0, packageCount: 0, savedAt: "unreadable" };
      }
    }).sort((a, b) => a.savedAt < b.savedAt ? 1 : -1);
  } catch {
    return [];
  }
}
function rescueNative(agentDir) {
  const configPath = getLazyConfigPath(agentDir);
  const settingsPath = getSettingsPath(agentDir);
  const config = loadConfig(agentDir);
  const specsCleared = config.specs.length;
  const handedBack = [];
  const keptOverrides = [];
  let settings = null;
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch (err) {
      return { ok: false, handedBack, keptOverrides, specsCleared, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backups = [];
  if (existsSync5(configPath)) {
    const b = `${configPath}.bak.rescue-${stamp}`;
    copyFileSync2(configPath, b);
    backups.push(b);
  }
  if (settings && existsSync5(settingsPath)) {
    const b = `${settingsPath}.bak.rescue-${stamp}`;
    copyFileSync2(settingsPath, b);
    backups.push(b);
  }
  try {
    if (settings && Array.isArray(settings.packages)) {
      settings.packages = settings.packages.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const obj = entry;
        if (!(Array.isArray(obj.extensions) && obj.extensions.length === 0)) {
          const src = typeof obj.source === "string" ? obj.source : null;
          if (src && Array.isArray(obj.extensions)) keptOverrides.push(src);
          return entry;
        }
        const { extensions, ...rest } = obj;
        if (typeof rest.source === "string") {
          handedBack.push(rest.source);
          return rest.source;
        }
        handedBack.push("(unnamed)");
        return rest;
      });
      atomicWriteJson(settingsPath, settings);
    }
    saveConfig({ ...config, specs: [] }, agentDir);
  } catch (err) {
    return { ok: false, handedBack, keptOverrides, specsCleared, backups, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, handedBack, keptOverrides, specsCleared, backups };
}
var ROSTER_PATH = "lazy-roster.json";
function rosterPath(agentDir) {
  return join4(agentDir, ROSTER_PATH);
}
function loadRoster(agentDir) {
  const path = rosterPath(agentDir);
  if (existsSync5(path)) {
    try {
      const parsed = JSON.parse(readFileSync5(path, "utf-8"));
      if (parsed && Array.isArray(parsed.all)) return parsed;
    } catch {
    }
  }
  return buildRoster(agentDir);
}
function buildRoster(agentDir) {
  const config = loadConfig(agentDir);
  const seen = /* @__PURE__ */ new Map();
  for (const spec of config.specs) {
    seen.set(normalizeSourceKey(spec.source), {
      name: spec.name,
      source: spec.source,
      mode: typeof spec.lazy === "boolean" ? spec.lazy ? "lazy" : "eager" : String(spec.lazy)
    });
  }
  const settingsPath = getSettingsPath(agentDir);
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      for (const entry of parsed.packages ?? []) {
        const src = typeof entry === "string" ? entry : entry?.source;
        if (typeof src !== "string" || seen.has(normalizeSourceKey(src))) continue;
        seen.set(normalizeSourceKey(src), {
          name: (npmPackageName(src) ?? src).split("/").pop() ?? src,
          source: src,
          mode: typeof entry === "string" ? "eager" : "custom"
        });
      }
    } catch {
    }
  }
  return { version: 1, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), all: [...seen.values()] };
}
function refreshRoster(agentDir) {
  const roster = buildRoster(agentDir);
  try {
    atomicWriteJson(rosterPath(agentDir), roster);
  } catch (err) {
    console.error(`[pi-lazy] failed to write roster: ${err instanceof Error ? err.message : String(err)}`);
  }
  return roster;
}
function formatRoster(roster, verb) {
  if (roster.all.length === 0) return "no packages recorded \u2014 run /lazy init first";
  return [
    `packages for /lazy ${verb} (${roster.all.length}, from lazy-roster.json):`,
    ...roster.all.map((e) => `  ${e.name}  [${e.mode}]  ${e.source}`),
    "",
    `usage: /lazy ${verb} <name>`
  ].join("\n");
}
function enablePackage(agentDir, name) {
  const configPath = getLazyConfigPath(agentDir);
  const settingsPath = getSettingsPath(agentDir);
  const config = loadConfig(agentDir);
  if (config.specs.some((s) => s.name === name || sourcesMatch(s.source, name))) {
    const existing = config.specs.find((s) => s.name === name || sourcesMatch(s.source, name));
    return {
      ok: true,
      restoredSpec: false,
      restoredEntry: false,
      mode: existing ? typeof existing.lazy === "boolean" ? existing.lazy ? "lazy" : "eager" : String(existing.lazy) : void 0,
      backups: [],
      noop: true
    };
  }
  let recovered = null;
  let specBackup = null;
  if (existsSync5(configPath)) {
    const dir = dirname3(configPath);
    const stamp2 = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    let candidates = [];
    try {
      candidates = readdirSync2(dir).filter((f) => f.startsWith(`${basename(configPath)}.bak.disable-`)).sort().reverse();
    } catch {
      candidates = [];
    }
    for (const file of candidates) {
      try {
        const snap = JSON.parse(readFileSync5(join4(dir, file), "utf-8"));
        const hit = snap.specs?.find((s) => s.name === name || sourcesMatch(s.source, name));
        if (hit) {
          recovered = hit;
          specBackup = join4(dir, file);
          break;
        }
      } catch {
      }
    }
  }
  let settings = null;
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch (err) {
      return { ok: false, restoredSpec: false, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const packages = settings && Array.isArray(settings.packages) ? [...settings.packages] : [];
  let entry = null;
  let settingsBackup = null;
  if (existsSync5(settingsPath)) {
    const dir = dirname3(settingsPath);
    const base = basename(settingsPath);
    let candidates = [];
    try {
      candidates = readdirSync2(dir).filter((f) => f.startsWith(`${base}.bak.disable-`)).sort().reverse();
    } catch {
      candidates = [];
    }
    for (const file of candidates) {
      try {
        const snap = JSON.parse(readFileSync5(join4(dir, file), "utf-8"));
        const hit = (snap.packages ?? []).find((p) => {
          const src = typeof p === "string" ? p : p?.source;
          return typeof src === "string" && (sourcesMatch(src, name) || sourcesMatch(src, recovered?.source ?? name));
        });
        if (hit) {
          entry = hit;
          settingsBackup = join4(dir, file);
          break;
        }
      } catch {
      }
    }
  }
  const source = recovered?.source ?? (typeof entry === "string" ? entry : entry?.source) ?? name;
  if (!recovered && !entry) {
    return {
      ok: false,
      restoredSpec: false,
      backups: [],
      error: `no record of "${name}" in any *.bak.disable-* snapshot \u2014 re-add the spec to lazy.json by hand`
    };
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backups = [];
  if (existsSync5(configPath)) {
    const b = `${configPath}.bak.enable-${stamp}`;
    copyFileSync2(configPath, b);
    backups.push(b);
  }
  if (existsSync5(settingsPath)) {
    const b = `${settingsPath}.bak.enable-${stamp}`;
    copyFileSync2(settingsPath, b);
    backups.push(b);
  }
  try {
    if (recovered) {
      const next = { ...config, specs: [...config.specs, recovered] };
      saveConfig(next, agentDir);
    }
    if (settings && entry && !packages.some((p) => {
      const src = typeof p === "string" ? p : p?.source;
      return typeof src === "string" && sourcesMatch(src, source);
    })) {
      settings.packages = [...packages, entry];
      atomicWriteJson(settingsPath, settings);
    }
  } catch (err) {
    return { ok: false, restoredSpec: false, backups, error: err instanceof Error ? err.message : String(err) };
  }
  const migration = migrateSettings(agentDir);
  return {
    ok: true,
    restoredSpec: recovered !== null,
    restoredEntry: entry !== null,
    mode: recovered ? typeof recovered.lazy === "boolean" ? recovered.lazy ? "lazy" : "eager" : String(recovered.lazy) : void 0,
    specFrom: specBackup ?? void 0,
    entryFrom: settingsBackup ?? void 0,
    migrated: migration.ok ? migration.changed.length : 0,
    migrateSkipped: migration.ok ? migration.skipped.length : 0,
    migrateError: migration.ok ? void 0 : migration.error,
    backups
  };
}
function disablePackage(agentDir, name) {
  const configPath = getLazyConfigPath(agentDir);
  const settingsPath = getSettingsPath(agentDir);
  const config = loadConfig(agentDir);
  const spec = config.specs.find((s) => s.name === name) ?? config.specs.find((s) => sourcesMatch(s.source, name)) ?? config.specs.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
  if (!spec) {
    return { ok: true, noop: true, droppedFromSettings: false, backups: [] };
  }
  let settings = null;
  if (existsSync5(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch (err) {
      return { ok: false, droppedFromSettings: false, backups: [], error: `settings.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const packages = settings && Array.isArray(settings.packages) ? [...settings.packages] : [];
  const keep = packages.filter((entry) => {
    const src = typeof entry === "string" ? entry : entry?.source;
    return typeof src !== "string" || !sourcesMatch(src, spec.source);
  });
  const droppedFromSettings = keep.length !== packages.length;
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backups = [];
  if (existsSync5(configPath)) {
    const backup = `${configPath}.bak.disable-${stamp}`;
    copyFileSync2(configPath, backup);
    backups.push(backup);
  }
  if (droppedFromSettings && settings && existsSync5(settingsPath)) {
    const backup = `${settingsPath}.bak.disable-${stamp}`;
    copyFileSync2(settingsPath, backup);
    backups.push(backup);
  }
  try {
    const next = { ...config, specs: config.specs.filter((s) => s !== spec) };
    saveConfig(next, agentDir);
    if (settings && droppedFromSettings) {
      settings.packages = keep;
      atomicWriteJson(settingsPath, settings);
    }
  } catch (err) {
    return { ok: false, droppedFromSettings, backups, error: err instanceof Error ? err.message : String(err) };
  }
  const migration = migrateSettings(agentDir);
  return {
    ok: true,
    droppedFromSettings,
    migrated: migration.ok ? migration.changed.length : 0,
    migrateSkipped: migration.ok ? migration.skipped.length : 0,
    backups
  };
}
function refreshStatus(pi, rt, ctx) {
  rt.status = formatStatus(rt);
  globalThis.__piLazyStatus = rt.status;
  globalThis.__piLazyManagedSources = new Set(
    [...rt.entries.values()].filter((e) => e.spec.lazy !== false).map((e) => e.spec.source)
  );
}
function notifySafe(ctx, message, type) {
  if (!ctx) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
  }
}
function runDoctor(agentDir, rt) {
  const lines = [];
  const settingsPath = getSettingsPath(agentDir);
  try {
    const rawCfg = JSON.parse(readFileSync5(getLazyConfigPath(agentDir), "utf-8"));
    const rawSpecs = Array.isArray(rawCfg?.specs) ? rawCfg.specs : [];
    for (const s of rawSpecs) {
      const v = s?.lazy;
      if (v !== void 0 && v !== false && v !== true && v !== "after-start") {
        lines.push(`X spec "${s?.name ?? "?"}": lazy \u503C\u975E\u6CD5 ${JSON.stringify(v)}\uFF08\u53EA\u80FD false / true / "after-start"\uFF09\u2192 \u8BE5 spec \u88AB\u9759\u9ED8\u4E22\u5F03`);
      }
    }
  } catch (err) {
    lines.push(`X lazy.json \u89E3\u6790\u5931\u8D25\uFF08\u6B63\u5728\u7528\u5185\u7F6E\u515C\u5E95\u76EE\u5F55\uFF0C\u90E8\u5206\u5305\u4E0D\u4F1A\u52A0\u8F7D\uFF09: ${err instanceof Error ? err.message : String(err)}`);
  }
  let packages;
  try {
    const parsed = JSON.parse(readFileSync5(settingsPath, "utf-8"));
    packages = Array.isArray(parsed.packages) ? parsed.packages : [];
  } catch (err) {
    lines.push(`X settings.json \u8BFB\u53D6\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    return lines;
  }
  const sourceOf = (p) => typeof p === "string" ? p : p && typeof p === "object" && "source" in p && typeof p.source === "string" ? p.source : "";
  const counts = /* @__PURE__ */ new Map();
  for (const p of packages) {
    const src = sourceOf(p);
    if (src) counts.set(src, (counts.get(src) ?? 0) + 1);
  }
  for (const [src, n] of counts) if (n > 1) lines.push(`X settings \u91CD\u590D\u6761\u76EE x${n}: ${src}`);
  const extDir = join4(agentDir, "extensions");
  for (const p of packages) {
    if (p && typeof p === "object" && sourceOf(p).startsWith(extDir)) {
      lines.push(`X \u91CD\u590D\u767B\u8BB0\uFF08settings \u4E0E extensions/ \u76EE\u5F55\u90FD\u4F1A\u52A0\u8F7D\uFF0C\u4F1A\u8DD1\u4E24\u904D\uFF09: ${sourceOf(p)}`);
    }
  }
  for (const spec of rt.config.specs) {
    const managed = spec.lazy !== false;
    const idx = findSettingsPackageIndices(packages, spec.source);
    if (idx.length === 0) {
      lines.push(`- ${spec.name}: \u672A\u6CE8\u518C\u5728 settings\uFF08lazy \u4E0D\u4F1A\u78B0\u5B83\uFF09`);
      continue;
    }
    if (idx.length > 1) {
      lines.push(`X ${spec.name}: settings \u91CC\u6709 ${idx.length} \u6761\u91CD\u590D`);
      continue;
    }
    const entry = packages[idx[0]];
    if (typeof entry === "string") {
      if (managed)
        lines.push(
          `\xB7 ${spec.name}: \u7EAF\u5B57\u7B26\u4E32 = pi \u542F\u52A8\u5373\u52A0\u8F7D\uFF08\u73B0\u5728\u5C31\u662F\u53EF\u7528\u72B6\u6001\uFF09\u3002lazy=${JSON.stringify(spec.lazy)} \u5C1A\u672A\u63A5\u7BA1\uFF1B\u8DD1 /lazy migrate \u4F1A\u6539\u5199\u6210 [] \u4EA4\u7ED9 lazy\uFF0C\u5C4A\u65F6\u8981\u7B49 after-start/\u89E6\u53D1\u624D\u51FA\u73B0`
        );
      continue;
    }
    const filters = Array.isArray(entry.extensions) ? entry.extensions : [];
    const blocking = filters.some((t) => typeof t === "string" && (t.trim().startsWith("-") || t.trim().startsWith("!")));
    if (filters.length === 0) {
      if (!managed) lines.push(`! ${spec.name}: \u5DF2\u88AB lazy \u63A5\u7BA1\u4F46 lazy=false \u2192 /lazy migrate \u4EA4\u56DE extmgr`);
    } else if (blocking) {
      lines.push(`! ${spec.name}: \u5E26\u6392\u9664\u6807\u8BB0 ${JSON.stringify(filters)} \u2192 lazy \u8BA9\u4F4D\uFF08\u5F52 extmgr / pi config\uFF09`);
    } else {
      lines.push(`! ${spec.name}: \u5E26\u653E\u884C\u6807\u8BB0 ${JSON.stringify(filters)} \u2192 \u4E0B\u6B21 /lazy migrate \u4F1A\u6536\u56DE\u4E3A []`);
    }
    const triggers = (spec.cmd ?? []).length + (spec.tools ?? []).length + (spec.keys ?? []).length + (spec.keywords ?? []).length + (spec.event ?? []).length;
    if (spec.lazy === true && triggers === 0) {
      lines.push(`   \u21B3 \u65E0\u89E6\u53D1\u5165\u53E3\uFF08lazy=true\uFF09\uFF1A\u53EA\u80FD /lazy load ${spec.name}\uFF08\u6216\u6A21\u578B\u8C03 lazy_load\uFF09`);
    }
  }
  const specSources = rt.config.specs.map((s) => s.source);
  const outside = packages.filter((p) => {
    const src = sourceOf(p);
    return !!src && !specSources.some((s) => sourcesMatch(src, s));
  });
  const nobodyLoads = [];
  const eagerOutside = [];
  for (const p of outside) {
    const src = sourceOf(p);
    const ext = typeof p === "object" && p !== null ? p.extensions : void 0;
    if (Array.isArray(ext) && ext.length === 0) nobodyLoads.push(src);
    else eagerOutside.push(src);
  }
  if (nobodyLoads.length) {
    lines.push(`X \u6CA1\u4EBA\u52A0\u8F7D\uFF08settings \u662F extensions:[] \u4F46 lazy.json \u91CC\u6CA1\u6709\u5B83 \u2192 pi \u4E0D\u52A0\u8F7D\u3001lazy \u4E5F\u4E0D\u7BA1\uFF09: ${nobodyLoads.join(", ")}`);
    lines.push(`   \u21B3 \u540E\u679C\uFF1A\u8FD9\u4E9B\u5305\u7684\u547D\u4EE4/\u5DE5\u5177\u90FD\u4E0D\u4F1A\u6CE8\u518C\uFF08pi-extmgr \u6574\u4E2A\u5931\u6548\u5C31\u662F\u8FD9\u6761\uFF09`);
    lines.push(`   \u21B3 \u4FEE\u6CD5\u4E8C\u9009\u4E00\uFF1A\u2460 settings \u91CC\u6539\u56DE\u666E\u901A\u5B57\u7B26\u4E32\uFF0C\u8BA9 pi \u542F\u52A8\u5373\u52A0\u8F7D\uFF1B\u2461 \u52A0\u8FDB lazy.json \u5E76\u5199\u5BF9\u89E6\u53D1\u540D`);
  }
  if (eagerOutside.length) lines.push(`- \u672A\u7EB3\u5165 lazy\uFF08\u542F\u52A8\u5373\u52A0\u8F7D\uFF09: ${eagerOutside.join(", ")}`);
  if (rt.entries && typeof rt.entries.values === "function") {
    const all = [...rt.entries.values()];
    for (const e of all) {
      if (e.state === "error" || e.state === "poisoned") {
        lines.push(`X ${e.spec.name}: \u52A0\u8F7D\u5931\u8D25 (${e.state}) ${e.error ?? ""}`.trim());
      }
    }
    const stuck = all.filter((e) => e.state === "pending" && e.spec.lazy === "after-start");
    if (stuck.length && !rt.afterStartQueued) {
      lines.push(`X after-start \u961F\u5217\u5DF2\u7ED3\u675F\u4F46\u4ECD\u6709 ${stuck.length} \u4E2A pending\uFF08= \u61D2\u52A0\u8F7D\u6CA1\u751F\u6548\uFF09: ${stuck.map((e) => e.spec.name).join(", ")}`);
    }
    const loaded = all.filter((e) => e.state === "loaded").length;
    lines.push(`\xB7 \u8FD0\u884C\u6001: ${loaded} loaded / ${all.filter((e) => e.state === "pending").length} pending / ${all.filter((e) => e.state === "eager").length} eager${rt.afterStartQueued ? " (after-start \u961F\u5217\u8FDB\u884C\u4E2D)" : ""}`);
  }
  const extmgrFile = join4(agentDir, "npm", "node_modules", "pi-extmgr", "src", "packages", "extensions.ts");
  if (rt.config.managerCompat !== true) {
    lines.push(`- extmgr \u517C\u5BB9\u8865\u4E01: \u5173\u95ED\uFF08lazy.json \u91CC managerCompat \u4E0D\u662F true\uFF09\u2192 \u9762\u677F\u4F1A\u628A\u61D2\u52A0\u8F7D\u5305\u663E\u793A\u6210 Disabled`);
  } else if (!existsSync5(extmgrFile)) {
    lines.push(`\xB7 extmgr \u517C\u5BB9\u8865\u4E01: \u672A\u5B89\u88C5 pi-extmgr\uFF0C\u8DF3\u8FC7`);
  } else {
    let patched = false;
    try {
      patched = readFileSync5(extmgrFile, "utf-8").includes("__piLazyManagedSources");
    } catch {
    }
    lines.push(
      patched ? `\xB7 extmgr \u517C\u5BB9\u8865\u4E01: \u5DF2\u5C31\u4F4D\uFF08\u91CD\u88C5/\u66F4\u65B0 pi-extmgr \u4F1A\u51B2\u6389\uFF1B\u91CD\u542F pi \u6216\u518D\u8DD1\u4E00\u6B21 /lazy doctor \u4F1A\u81EA\u52A8\u8865\u56DE\uFF09` : `X extmgr \u517C\u5BB9\u8865\u4E01: \u66FE\u7F3A\u5931\uFF0C\u672C\u6B21\u5DF2\u81EA\u52A8\u8865\u56DE \u2192 \u9700\u91CD\u542F pi \u624D\u751F\u6548\uFF08\u9762\u677F\u6A21\u5757\u4E00\u65E6\u52A0\u8F7D\u5C31\u7F13\u5B58\u5230\u8FDB\u7A0B\u7ED3\u675F\uFF09`
    );
  }
  return lines.length ? lines : ["clean: \u672A\u53D1\u73B0\u5F02\u5E38"];
}
function ensureManagerCompat(agentDir, rt) {
  if (rt.config.managerCompat !== true) return;
  const file = join4(agentDir, "npm", "node_modules", "pi-extmgr", "src", "packages", "extensions.ts");
  if (!existsSync5(file)) return;
  let src;
  try {
    src = readFileSync5(file, "utf-8");
  } catch {
    return;
  }
  if (src.includes("__piLazyManagedSources")) return;
  const steps = [
    [
      "    const resolvedResources = resourcesForPackage(canonicalResources, pkg.source, pkg.scope);\n",
      '    const resolvedResources = resourcesForPackage(canonicalResources, pkg.source, pkg.scope);\n    const pkgFiltersLazy =\n      (pkg.scope === "global" ? globalFilterMap : projectFilterMap).get(\n        normalizeConfiguredPackageSource(pkg.source)\n      ) ?? undefined;\n    // pi-lazy \u517C\u5BB9\uFF1Asettings \u91CC extensions:[] + \u8BE5\u5305\u88AB lazy \u63A5\u7BA1 = \u5EF6\u8FDF\u52A0\u8F7D\uFF0C\u4E0D\u662F\u7981\u7528\n    // \u53EA\u8BA4 []\uFF08lazy \u5DF2\u63A5\u7BA1\uFF09\uFF1B\u5E26 -/! \u6807\u8BB0\u7684\u6761\u76EE\u662F extmgr \u81EA\u5DF1\u7981\u7684\uFF0C\u4FDD\u6301 disabled\n    const lazyDeferred =\n      Array.isArray(pkgFiltersLazy) &&\n      pkgFiltersLazy.length === 0 &&\n      !!(globalThis as { __piLazyManagedSources?: Set<string> }).__piLazyManagedSources?.has(\n        pkg.source\n      );\n'
    ],
    [
      '          state: resource.enabled ? "enabled" : "disabled",',
      '          state: resource.enabled || lazyDeferred ? "enabled" : "disabled",'
    ],
    [
      "      const state = getPackageFilterState(packageFilters, normalizedPath);",
      '      let state = getPackageFilterState(packageFilters, normalizedPath);\n      if (state === "disabled" && lazyDeferred) state = "enabled";'
    ]
  ];
  for (const [anchor] of steps) {
    if (!src.includes(anchor)) {
      console.error("[pi-lazy] pi-extmgr \u517C\u5BB9\u8865\u4E01\u8DF3\u8FC7\uFF1A\u951A\u70B9\u672A\u547D\u4E2D " + JSON.stringify(anchor.slice(0, 50)));
      return;
    }
  }
  for (const [anchor, replacement] of steps) src = src.replace(anchor, replacement);
  try {
    writeFileSync2(file, src);
    console.error("[pi-lazy] re-patched pi-extmgr for lazy compat (restart to take effect)");
  } catch {
  }
}
function ensureFooterCompat(agentDir, rt) {
  if (rt.config.footerCompat === false) return;
  const dir = join4(agentDir, "npm", "node_modules", "pi-powerline-footer");
  const indexFile = join4(dir, "index.ts");
  const welcomeFile = join4(dir, "welcome.ts");
  if (!existsSync5(indexFile) || !existsSync5(welcomeFile)) return;
  let indexSrc;
  let welcomeSrc;
  try {
    indexSrc = readFileSync5(indexFile, "utf-8");
    welcomeSrc = readFileSync5(welcomeFile, "utf-8");
  } catch {
    return;
  }
  if (indexSrc.includes("getRecentSessionsFast") && welcomeSrc.includes("setRecentSessions")) return;
  const helper = `  // [\u672C\u5730\u8865\u4E01] \u6B22\u8FCE\u6D6E\u5C42/\u9876\u680F\u4E0D\u518D\u7B49 getRecentSessions
  //
  // \u539F\u56E0\uFF1AgetRecentSessions \u4F1A\u5BF9\u300C\u6700\u8FD1 3 \u4E2A\u4F1A\u8BDD\u65E5\u5FD7\u300D\u505A open()\uFF0C\u5176\u4E2D\u6700\u65B0\u90A3\u4E2A\u5C31\u662F\u5F53\u524D\u6B63\u5728\u5199\u5165\u7684\u4F1A\u8BDD\u6587\u4EF6\u3002
  // \u5B9E\u6D4B\uFF08\u672C\u673A Windows + Defender\uFF09\uFF1A\u5BF9\u8BE5\u6587\u4EF6\u7684\u9996\u6B21 open \u8981 ~8s\uFF08\u540C\u8FDB\u7A0B\u7B2C\u4E8C\u6B21 0ms\uFF0C\u5DF2\u5173\u95ED\u7684\u65E7\u6587\u4EF6 0ms\uFF0C
  // \u5305\u62EC 12.9MB \u7684\u4E5F\u662F 0ms\uFF09\u2192 \u5361\u7684\u662F\u300C\u521A\u88AB\u5199\u8FC7\u7684\u6D3B\u8DC3\u6587\u4EF6\u300D\uFF0C\u4E0D\u662F\u4F53\u79EF\u3002
  // \u8FD9\u4E00\u884C await \u539F\u672C\u5C31\u5728\u6B22\u8FCE\u6D6E\u5C42/\u9876\u680F\u7684\u6E32\u67D3\u8DEF\u5F84\u4E0A\uFF0C\u4E8E\u662F\uFF1A
  //   t\u2248100ms  \u6D6E\u5C42\u5F00\u59CB\u51C6\u5907
  //   t\u2248750ms  pi-lazy \u7684 after-start \u961F\u5217\u8D77\u8DD1\uFF08\u6BCF\u5305 ~0.5-0.9s\uFF0C\u95F4\u9694\u8BA9\u51FA \u2264250ms\uFF0C\u6700\u540E\u4E00\u5305 ~6s\uFF09
  //   t\u22488s     \u4E0A\u9762\u90A3\u4E2A open \u624D\u8FD4\u56DE \u2192 \u961F\u5217\u65E9\u8DD1\u5B8C\u4E86 \u2192 \u6D6E\u5C42\u624D\u753B\u51FA\u6765
  // \u89C2\u611F\u5C31\u662F\u300C\u61D2\u52A0\u8F7D\u5168\u90E8\u8DD1\u5B8C\uFF0C\u7F8E\u5316\u5F39\u7A97\u624D\u8E66\u51FA\u6765\u300D\u3002
  //
  // \u4FEE\u6CD5\uFF1A\u7ED9\u6700\u8FD1\u4F1A\u8BDD\u5217\u8868\u4E00\u4E2A\u5F88\u77ED\u7684\u8D85\u65F6\uFF0C\u8D85\u65F6\u5C31\u7528\u7A7A\u5217\u8868\u5148\u628A UI \u753B\u51FA\u6765\uFF0C\u4E0D\u963B\u585E\u9996\u5E27\uFF1B
  // \u771F\u6B63\u7684\u5217\u8868\u8FDF\u5230\u65F6\u518D\u8865\u753B\uFF08\u9876\u680F\u91CD\u65B0 setHeader\uFF0C\u6D6E\u5C42 setRecentSessions + requestRender\uFF09\u3002
  async function getRecentSessionsFast(request: AbortController): Promise<RecentSession[]> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        getRecentSessions(3, request.signal),
        new Promise<RecentSession[]>((resolve) => {
          timer = setTimeout(() => resolve([]), WELCOME_RECENT_SESSIONS_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

`;
  const headerLate = `        // [\u672C\u5730\u8865\u4E01] \u4E0A\u9762\u8D85\u65F6\u4E86\u5C31\u5148\u7528\u7A7A\u5217\u8868\u628A\u9876\u680F\u753B\u51FA\u6765\uFF0C\u7B49\u771F\u6B63\u7684\u6700\u8FD1\u4F1A\u8BDD\u5230\u4E86\u518D\u8865\u753B\u4E00\u6B21\u3002
        if (recentSessions.length === 0) {
          void getRecentSessions(3, request.signal).then((lateSessions) => {
            if (lateSessions.length === 0 || !welcomeHeaderActive) return;
            if (!canShowWelcome(ctx, request, generation)) return;
            ctx.ui.setHeader(() => new WelcomeHeader(
              modelName,
              providerName,
              lateSessions,
              discoverLoadedCounts(pi.getCommands()),
              estimateInitialContextTokens(ctx),
            ));
          }).catch(() => {});
        }
`;
  const overlayLate = `            // [\u672C\u5730\u8865\u4E01] \u4E0A\u9762\u8D85\u65F6\u4E86\u5C31\u5148\u5F39\u7A7A\u5217\u8868\u7684\u6D6E\u5C42\uFF0C\u7B49\u771F\u6B63\u7684\u6700\u8FD1\u4F1A\u8BDD\u5230\u4E86\u518D\u56DE\u586B\u91CD\u753B\u3002
            if (recentSessions.length === 0) {
              void getRecentSessions(3, request.signal).then((lateSessions) => {
                if (dismissed || lateSessions.length === 0) return;
                welcome.setRecentSessions(lateSessions);
                tui.requestRender();
              }).catch(() => {});
            }
`;
  const plan = [
    {
      file: indexFile,
      src: indexSrc,
      steps: [
        [
          'import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.ts";\n',
          'import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions, type RecentSession } from "./welcome.ts";\n'
        ],
        [
          "const STASH_PREVIEW_WIDTH = 72;\n",
          "const STASH_PREVIEW_WIDTH = 72;\n// [\u672C\u5730\u8865\u4E01] \u6B22\u8FCE\u6D6E\u5C42/\u9876\u680F\u7B49\u6700\u8FD1\u4F1A\u8BDD\u5217\u8868\u7684\u4E0A\u9650\uFF1B\u8D85\u65F6\u5148\u753B\u7A7A\u5217\u8868\uFF08\u8BE6\u89C1 getRecentSessionsFast\uFF09\u3002\nconst WELCOME_RECENT_SESSIONS_TIMEOUT_MS = 400;\n"
        ],
        ["  function setupWelcomeHeader(ctx: any) {", helper + "  function setupWelcomeHeader(ctx: any) {"],
        [
          "        const recentSessions = await getRecentSessions(3, request.signal);\n        if (!canShowWelcome(ctx, request, generation)) return;\n",
          "        const recentSessions = await getRecentSessionsFast(request);\n        if (!canShowWelcome(ctx, request, generation)) return;\n"
        ],
        [
          "        welcomeHeaderActive = true;\n        ctx.ui.setHeader(() => header);\n",
          "        welcomeHeaderActive = true;\n        ctx.ui.setHeader(() => header);\n\n" + headerLate
        ],
        [
          "        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;\n        const recentSessions = await getRecentSessions(3, request.signal);\n",
          "        if (!canShowWelcome(ctx, request, overlaySessionGeneration)) return;\n        const recentSessions = await getRecentSessionsFast(request);\n"
        ],
        [
          "            const welcome = new WelcomeComponent(\n              modelName,\n              providerName,\n              recentSessions,\n              loadedCounts,\n              initialContextTokens,\n            );\n",
          "            const welcome = new WelcomeComponent(\n              modelName,\n              providerName,\n              recentSessions,\n              loadedCounts,\n              initialContextTokens,\n            );\n\n" + overlayLate
        ]
      ]
    },
    {
      file: welcomeFile,
      src: welcomeSrc,
      steps: [
        [
          "  setCountdown(seconds: number): void {\n    this.countdown = seconds;\n  }\n",
          "  setCountdown(seconds: number): void {\n    this.countdown = seconds;\n  }\n\n  // [\u672C\u5730\u8865\u4E01] \u9996\u5E27\u4E0D\u518D\u7B49 getRecentSessions\uFF08\u89C1 index.ts \u7684 getRecentSessionsFast \u6CE8\u91CA\uFF09\u3002\n  // \u6700\u8FD1\u4F1A\u8BDD\u5217\u8868\u8FDF\u5230\u65F6\uFF0C\u7531 index.ts \u56DE\u586B\u5E76 requestRender\u3002\n  setRecentSessions(sessions: RecentSession[]): void {\n    this.data = { ...this.data, recentSessions: sessions };\n  }\n"
        ]
      ]
    }
  ];
  const outs = [];
  for (const p of plan) {
    let out = p.src;
    for (const [anchor, repl] of p.steps) {
      const hits = out.split(anchor).length - 1;
      if (hits !== 1) {
        console.error(`[pi-lazy] pi-powerline-footer \u517C\u5BB9\u8865\u4E01\u8DF3\u8FC7\uFF1A\u951A\u70B9\u672A\u547D\u4E2D\u6216\u91CD\u590D\uFF08${hits} \u6B21\uFF09${JSON.stringify(anchor.slice(0, 60))}`);
        return;
      }
      out = out.replace(anchor, () => repl);
    }
    outs.push([p.file, out]);
  }
  try {
    for (const [file, out] of outs) writeFileSync2(file, out);
  } catch (err) {
    console.error(`[pi-lazy] pi-powerline-footer \u517C\u5BB9\u8865\u4E01\u5199\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.error("[pi-lazy] re-patched pi-powerline-footer for fast welcome (restart to take effect)");
}
function recordTiming(rt, label, started) {
  rt.profile.push({ label, ms: performance.now() - started });
  if (rt.profile.length > 100) rt.profile.shift();
}
function ensureResolved(rt, entry, ctx) {
  if (entry.resolveAttempted) return true;
  const started = performance.now();
  try {
    const resolved = resolveSpecPaths(entry.spec, getAgentDir4(), (ctx ?? rt.sessionCtx)?.cwd ?? process.cwd());
    entry.packageRoot = resolved.packageRoot ?? "";
    entry.extensionPaths = resolved.extensionPaths;
    entry.resolveMs = performance.now() - started;
    entry.resolveAttempted = true;
    recordTiming(rt, `resolve:${entry.spec.name}`, started);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry.resolveAttempted = true;
    entry.state = "error";
    entry.error = `failed to resolve ${entry.spec.source}: ${message}`;
    return false;
  }
}
async function prefetchQuietly(rt, entry, ctx) {
  try {
    if (entry.state !== "pending" || !entry.moduleLazyReady) return;
    if (!ensureResolved(rt, entry, ctx)) return;
    const started = performance.now();
    await prefetchEntry(entry);
    if (entry.prefetchedFactories) recordTiming(rt, `prefetch:${entry.spec.name}`, started);
  } catch {
  }
}
async function loadByName(pi, rt, name, ctx, ancestry = []) {
  const key = name.trim();
  if (!key) return { ok: false, name: key, error: "spec name must not be empty" };
  const entry = rt.entries.get(key) ?? [...rt.entries.values()].find(
    (e) => e.spec.source === key || e.spec.name.toLowerCase() === key.toLowerCase()
  );
  if (!entry) {
    return { ok: false, name: key, error: `unknown spec '${key}' \u2014 see /lazy list` };
  }
  if (entry.state === "eager") {
    return {
      ok: true,
      name: entry.spec.name,
      alreadyLoaded: true,
      error: void 0
    };
  }
  if (!ensureResolved(rt, entry, ctx)) {
    return { ok: false, name: entry.spec.name, error: entry.error };
  }
  const started = performance.now();
  const result = await loadResolvedEntry(entry, pi, ctx ?? rt.sessionCtx, {
    ancestry,
    loadDependency: (dep, nextAncestry) => loadByName(pi, rt, dep, ctx, nextAncestry)
  });
  recordTiming(rt, `load:${entry.spec.name}`, started);
  refreshStatus(pi, rt, ctx ?? rt.sessionCtx);
  return result;
}
function registerStubs(pi, rt) {
  const cmdOwners = /* @__PURE__ */ new Map();
  const toolOwners = /* @__PURE__ */ new Map();
  for (const entry of rt.entries.values()) {
    if (entry.state !== "pending") continue;
    const { spec } = entry;
    for (const cmd of spec.cmd ?? []) {
      if (cmdOwners.has(cmd)) {
        console.error(`[pi-lazy] command stub '${cmd}' is claimed by both '${cmdOwners.get(cmd)}' and '${spec.name}'`);
        continue;
      }
      cmdOwners.set(cmd, spec.name);
    }
    for (const tool of spec.tools ?? []) {
      if (toolOwners.has(tool)) {
        console.error(`[pi-lazy] tool stub '${tool}' is claimed by both '${toolOwners.get(tool)}' and '${spec.name}'`);
        continue;
      }
      toolOwners.set(tool, spec.name);
    }
    for (const key of spec.keys ?? []) {
      try {
        pi.registerShortcut(key, {
          description: `Load lazy package ${spec.name}`,
          handler: async (ctx) => {
            const res = await loadByName(pi, rt, spec.name, ctx);
            ctx.ui.notify(
              res.ok ? res.alreadyLoaded ? `${spec.name} already loaded` : `loaded ${spec.name}${res.loadMs != null ? ` (${res.loadMs}ms)` : ""}` : `failed ${spec.name}: ${res.error}`,
              res.ok ? "info" : "error"
            );
          }
        });
      } catch {
      }
    }
  }
  for (const [cmd, owner] of cmdOwners) {
    pi.registerCommand(cmd, {
      description: `[lazy] load ${owner} then run /${cmd}`,
      handler: async (args, ctx) => {
        const res = await loadByName(pi, rt, owner, ctx);
        if (!res.ok) {
          ctx.ui.notify(`lazy: failed to load ${owner}: ${res.error}`, "error");
          return;
        }
        if (!res.alreadyLoaded) {
          ctx.ui.notify(`lazy: loaded ${owner}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}`, "info");
        }
        const real = rt.entries.get(owner)?.loadedCommandHandlers?.get(cmd);
        if (real) {
          await real(args, ctx);
          return;
        }
        ctx.ui.notify(
          `lazy: '${owner}' loaded but did not register /${cmd}; update lazy.json to the package's actual command name`,
          "error"
        );
      }
    });
  }
  for (const [toolName, owner] of toolOwners) {
    pi.registerTool({
      name: toolName,
      label: `Lazy: ${toolName}`,
      description: `Lazy stub for ${toolName}. Loads package '${owner}' on first use, then activates the real tool. Call again after activation if needed.`,
      parameters: Type.Object({
        _lazy: Type.Optional(Type.String({ description: "Ignored. Present so the tool is valid before load." }))
      }, { additionalProperties: true }),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const res = await loadByName(pi, rt, owner, ctx);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Failed to load '${owner}': ${res.error}` }],
            details: { ok: false, error: res.error }
          };
        }
        const tools = res.tools?.length ? res.tools.join(", ") : "(see package)";
        return {
          content: [
            {
              type: "text",
              text: res.alreadyLoaded ? `Package '${owner}' already available. Use the real tools now.` : `Loaded '${owner}'${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}. Registered tools: ${tools}. Call the real tool again on the next turn.`
            }
          ],
          details: { ok: true, loaded: owner, tools: res.tools ?? [], alreadyLoaded: !!res.alreadyLoaded }
        };
      }
    });
  }
}
function registerEventTriggers(pi, rt) {
  const eventMap = /* @__PURE__ */ new Map();
  for (const entry of rt.entries.values()) {
    if (entry.state !== "pending") continue;
    for (const ev of entry.spec.event ?? []) {
      const list = eventMap.get(ev) ?? [];
      list.push(entry.spec.name);
      eventMap.set(ev, list);
    }
  }
  const loadTriggered = async (names, ctx) => {
    const limit = rt.config.autoLoadLimit ?? 1;
    let loaded = 0;
    for (const name of new Set(names)) {
      if (loaded >= limit) break;
      const current = rt.sessionCtx ?? ctx;
      const res = await loadByName(pi, rt, name, current);
      if (res.ok && !res.alreadyLoaded) {
        loaded++;
        notifySafe(rt.sessionCtx ?? current, `lazy: auto-loaded ${name}`, "info");
      }
    }
  };
  pi.on("before_agent_start", async (event, ctx) => {
    rt.turnActive = true;
    if (!rt.auto) return;
    const prompt = (event.prompt ?? "").toLowerCase();
    const toLoad = /* @__PURE__ */ new Set();
    for (const name of eventMap.get("before_agent_start") ?? []) {
      toLoad.add(name);
    }
    for (const entry of rt.entries.values()) {
      if (entry.state !== "pending") continue;
      for (const keyword of entry.normalizedKeywords ?? []) {
        if (prompt.includes(keyword)) {
          toLoad.add(entry.spec.name);
          break;
        }
      }
    }
    await loadTriggered(toLoad, ctx);
  });
  for (const [eventName, owners] of eventMap) {
    if (eventName === "before_agent_start") continue;
    try {
      pi.on(eventName, async (_event, ctx) => {
        if (rt.auto) await loadTriggered(owners, ctx);
      });
    } catch (err) {
      console.error(`[pi-lazy] unsupported event trigger '${eventName}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
async function runAfterStart(pi, rt, ctx, generation) {
  const queue = [...rt.entries.values()].filter((e) => e.state === "pending" && e.spec.lazy === "after-start").sort((a, b) => (a.spec.priority ?? 100) - (b.spec.priority ?? 100));
  const batchSize = rt.config.afterStartBatchSize ?? 1;
  const delayMs = rt.config.afterStartDelayMs ?? 0;
  const adaptive = rt.config.afterStartAdaptiveYield !== false;
  const prefetch = rt.config.afterStartPrefetch !== false;
  const stale = () => rt.queueCancelled || generation !== rt.sessionGeneration;
  for (let i = 0; i < queue.length && !stale(); i += batchSize) {
    await waitWhilePaused(rt, generation);
    if (stale()) return;
    const batch = queue.slice(i, i + batchSize);
    const next = queue.slice(i + batchSize, i + batchSize * 2);
    if (prefetch) {
      for (const entry of next) void prefetchQuietly(rt, entry, rt.sessionCtx ?? ctx);
    }
    let blockedMs = 0;
    for (const entry of batch) {
      if (stale()) return;
      const current = rt.sessionCtx ?? ctx;
      const started = performance.now();
      const res = await loadByName(pi, rt, entry.spec.name, current);
      blockedMs += performance.now() - started;
      if (stale()) return;
      if (!res.ok) {
        notifySafe(rt.sessionCtx ?? current, `lazy: after-start failed ${entry.spec.name}: ${res.error}`, "warning");
      }
    }
    if (i + batchSize < queue.length && !stale()) {
      const yieldMs = adaptive ? Math.max(delayMs, Math.min(Math.round(blockedMs), MAX_ADAPTIVE_YIELD_MS)) : delayMs;
      await sleep(yieldMs);
    }
  }
  refreshStatus(pi, rt, rt.sessionCtx ?? ctx);
}
function listLines(rt) {
  const lines = [];
  const order = ["pending", "loading", "loaded", "error", "poisoned", "eager"];
  const sorted = [...rt.entries.values()].sort((a, b) => {
    const ai = order.indexOf(a.state);
    const bi = order.indexOf(b.state);
    if (ai !== bi) return ai - bi;
    return a.spec.name.localeCompare(b.spec.name);
  });
  for (const e of sorted) {
    const mode = e.spec.lazy === false ? "eager" : e.spec.lazy === "after-start" ? "after-start" : "on-demand";
    const ms = e.loadMs != null ? ` ${e.loadMs}ms` : "";
    const err = e.error ? ` \u2014 ${e.error}` : "";
    const ready = e.moduleLazyReady ? "" : e.state === "eager" && isManagedLazy(e.spec) ? " (migrate+restart needed)" : "";
    lines.push(`${e.state.padEnd(8)} ${e.spec.name.padEnd(16)} ${mode.padEnd(12)} ${e.spec.source}${ms}${ready}${err}`);
  }
  return lines;
}
function createPiLazy(pi, agentDir = getAgentDir4()) {
  const config = loadConfig(agentDir);
  const catalogStarted = performance.now();
  const rt = {
    config,
    entries: buildCatalog(config, agentDir),
    auto: config.auto !== false,
    afterStartQueued: false,
    status: "lazy \u2026",
    profile: [],
    queueCancelled: false,
    sessionGeneration: 0,
    restartRequired: false,
    turnActive: false,
    resumeWaiters: []
  };
  recordTiming(rt, "catalog", catalogStarted);
  registerStubs(pi, rt);
  registerEventTriggers(pi, rt);
  const endTurn = () => {
    rt.turnActive = false;
    drainResumeWaiters(rt);
  };
  try {
    pi.on("agent_end", () => {
      endTurn();
    });
    pi.on("agent_settled", () => {
      endTurn();
    });
  } catch (err) {
    console.error(`[pi-lazy] turn-end events unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  pi.on("session_start", async (event, ctx) => {
    rt.sessionGeneration++;
    const generation = rt.sessionGeneration;
    rt.sessionCtx = ctx;
    rt.queueCancelled = false;
    rt.turnActive = false;
    drainResumeWaiters(rt);
    refreshStatus(pi, rt, ctx);
    ensureManagerCompat(agentDir, rt);
    ensureFooterCompat(agentDir, rt);
    const needsMigrate = [...rt.entries.values()].some(
      (e) => isManagedLazy(e.spec) && !e.moduleLazyReady
    );
    if (needsMigrate && event.reason === "startup") {
      ctx.ui.notify("pi-lazy: run /lazy migrate then restart for true module-lazy", "info");
    }
    rt.afterStartQueued = true;
    const initialDelayMs = rt.config.afterStartInitialDelayMs ?? DEFAULT_AFTER_START_INITIAL_DELAY_MS;
    setTimeout(() => {
      void runAfterStart(pi, rt, ctx, generation).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pi-lazy] after-start queue failed: ${message}`);
        notifySafe(rt.sessionCtx, `lazy: after-start queue failed: ${message}`, "warning");
      }).finally(() => {
        if (generation === rt.sessionGeneration) rt.afterStartQueued = false;
      });
    }, initialDelayMs);
  });
  pi.on("session_shutdown", () => {
    rt.sessionGeneration++;
    rt.sessionCtx = void 0;
    rt.afterStartQueued = false;
    rt.queueCancelled = true;
    rt.turnActive = false;
    drainResumeWaiters(rt);
  });
  pi.registerCommand("lazy", {
    description: "LazyVim-style extension manager (list|load|disable|enable|rescue|snapshot|restore|migrate|auto|init|scan|status|doctor)",
    getArgumentCompletions: (prefix) => {
      const sub = ["status", "list", "load", "migrate", "auto", "init", "scan", "disable", "enable", "rescue", "restore", "snapshot", "config", "profile", "doctor"];
      const items = [...sub, "auto on", "auto off"];
      for (const n of rt.entries.keys()) items.push(`load ${n}`);
      const roster = loadRoster(agentDir);
      for (const e of roster.all) {
        items.push(`enable ${e.name}`, `disable ${e.name}`);
      }
      for (const s of snapshotList(agentDir)) {
        items.push(`restore ${s.name}`, `snapshot delete ${s.name}`);
      }
      const mapped = items.map((v) => ({ value: v, label: v }));
      const filtered = mapped.filter((i) => i.value.startsWith(prefix) || i.value.includes(prefix));
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const [head, ...rest] = raw.split(/\s+/);
      const sub = (head || "status").toLowerCase();
      if (sub === "status" || sub === "") {
        const lines = [
          formatStatus(rt),
          `auto: ${rt.auto ? "on" : "off"}`,
          `config: ${getLazyConfigPath(agentDir)}`,
          "",
          ...listLines(rt)
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "list") {
        ctx.ui.notify(listLines(rt).join("\n") || "no specs", "info");
        return;
      }
      if (sub === "config") {
        ctx.ui.notify(getLazyConfigPath(agentDir), "info");
        return;
      }
      if (sub === "profile") {
        const lines = rt.profile.length ? rt.profile.map((item) => `${item.label.padEnd(24)} ${item.ms.toFixed(1)}ms`) : ["no timings recorded"];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "scan" || sub === "s") {
        try {
          scanIntoConfig(pi, rt, ctx, agentDir);
        } catch (err) {
          ctx.ui.notify(`scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }
      if (sub === "init") {
        try {
          const scanLines = scanIntoConfig(pi, rt, ctx, agentDir);
          const result = migrateSettings(agentDir);
          const roster = refreshRoster(agentDir);
          rt.restartRequired = true;
          const lines = [...scanLines, "", "\u2500\u2500 migrate \u2500\u2500"];
          if (!result.ok) {
            lines.push(`migrate failed: ${result.error}`);
          } else {
            lines.push(`settings \u2192 ${result.settingsPath}`);
            if (result.changed.length > 0) {
              lines.push(`made lazy (${result.changed.length}): ${result.changed.join(", ")}`);
            } else {
              lines.push("nothing to change in settings.json \u2014 already in sync.");
            }
            if (result.skipped.length > 0) {
              lines.push(`skipped (${result.skipped.length}): ${result.skipped.join(", ")}`);
            }
            lines.push("Reload or restart Pi to apply it.");
          }
          lines.push("", `\u2500\u2500 roster \u2500\u2500`, `${roster.all.length} packages recorded for /lazy disable and /lazy enable \u2192 ${rosterPath(agentDir)}`);
          ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "warning");
        } catch (err) {
          ctx.ui.notify(`failed to initialize config: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }
      if (sub === "auto") {
        const mode = (rest[0] ?? "").toLowerCase();
        if (mode === "on" || mode === "off") {
          const previous = rt.auto;
          try {
            rt.auto = mode === "on";
            rt.config.auto = rt.auto;
            saveConfig(rt.config, agentDir);
            ctx.ui.notify(`lazy auto ${mode}`, "info");
          } catch (err) {
            rt.auto = previous;
            rt.config.auto = previous;
            ctx.ui.notify(`failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        ctx.ui.notify(`lazy auto is ${rt.auto ? "on" : "off"} (usage: /lazy auto on|off)`, "info");
        return;
      }
      if (sub === "migrate") {
        const result = migrateSettings(agentDir);
        if (!result.ok) {
          ctx.ui.notify(`migrate failed: ${result.error}`, "error");
          return;
        }
        const lines = [
          result.changed.length ? `updated: ${result.changed.join(", ")}` : "no package changes needed",
          result.skipped.length ? `already lazy: ${result.skipped.join(", ")}` : "",
          result.added.length ? `added: ${result.added.join(", ")}` : "",
          result.backupPath ? `backup: ${result.backupPath}` : "",
          "Restart pi to apply module-lazy (extensions filtered to [])."
        ].filter(Boolean);
        ctx.ui.notify(lines.join("\n"), "info");
        if (result.changed.length > 0) rt.restartRequired = true;
        refreshStatus(pi, rt, ctx);
        return;
      }
      if (sub === "snapshot" || sub === "snap") {
        const snapshotName = rest.join(" ").trim();
        if (snapshotName.toLowerCase() === "delete") {
          const target = rest.slice(1).join(" ").trim();
          if (!target) {
            ctx.ui.notify("usage: /lazy snapshot delete <name>", "warning");
            return;
          }
          const deleted = snapshotDelete(agentDir, target);
          if (!deleted.ok) {
            ctx.ui.notify(`snapshot delete failed: ${deleted.error}`, "error");
            return;
          }
          ctx.ui.notify(`deleted snapshot "${target}"`, "info");
          return;
        }
        if (!snapshotName) {
          const listed = snapshotList(agentDir);
          ctx.ui.notify(
            listed.length === 0 ? `no snapshots saved \u2014 create one with /lazy snapshot <name>
(storage: ${snapshotDir(agentDir)})` : ["saved snapshots:", ...listed.map((s) => `  ${s.name}  (${s.specCount} specs, ${s.packageCount} packages, ${s.savedAt})`), "", `storage: ${snapshotDir(agentDir)}`].join("\n"),
            "info"
          );
          return;
        }
        const result = snapshotSave(agentDir, snapshotName);
        if (!result.ok) {
          ctx.ui.notify(`snapshot failed: ${result.error}`, "error");
          return;
        }
        ctx.ui.notify(
          [
            `saved snapshot "${snapshotName}" \u2014 ${result.specCount} specs + ${result.packageCount} settings packages`,
            `  \u2192 ${result.path}`,
            result.overwrote ? `  overwrote previous (kept as ${result.previous})` : ""
          ].filter(Boolean).join("\n"),
          "info"
        );
        return;
      }
      if (sub === "restore") {
        const snapshotName = rest.join(" ").trim();
        if (!snapshotName) {
          ctx.ui.notify("usage: /lazy restore <name>   \xB7   /lazy snapshot   to list saved snapshots", "warning");
          return;
        }
        const result = snapshotRestore(agentDir, snapshotName);
        if (!result.ok) {
          ctx.ui.notify(`restore failed: ${result.error}`, "error");
          return;
        }
        rt.config = loadConfig(agentDir);
        refreshStatus(pi, rt, ctx);
        ctx.ui.notify(
          [
            `restored snapshot "${snapshotName}" \u2014 scheme replaced (not merged)`,
            `  lazy.json:     ${result.specCount} specs`,
            `  settings.json: ${result.packageCount} packages registered`,
            `  migrate:       ${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated`,
            result.added.length ? `  new specs:      ${result.added.join(", ")}` : "",
            result.removed.length ? `  no longer registered: ${result.removed.join(", ")}` : "",
            "  node_modules untouched \u2014 `pi install npm:<name>` brings any of them back",
            ...result.backups.map((b) => `  backup: ${b}`),
            "Not in effect yet \u2014 run /reload for the change to take effect."
          ].filter(Boolean).join("\n"),
          "info"
        );
        return;
      }
      if (sub === "rescue" || sub === "panic") {
        const result = rescueNative(agentDir);
        if (!result.ok) {
          ctx.ui.notify(`rescue failed: ${result.error}`, "error");
          return;
        }
        refreshStatus(pi, rt, ctx);
        const lines = ["rescued \u2014 every package handed back to native Pi"];
        lines.push(`  lazy.json: ${result.specsCleared} spec${result.specsCleared === 1 ? "" : "s"} cleared (file kept: deleting it would let lazy rebuild its catalog)`);
        if (result.handedBack.length > 0) {
          lines.push(`  settings.json: ${result.handedBack.length} package${result.handedBack.length === 1 ? "" : "s"} restored to eager:`);
          for (const s of result.handedBack) lines.push(`    ${s}`);
        } else {
          lines.push("  settings.json: no lazy-written filters found \u2014 nothing to restore");
        }
        if (result.keptOverrides.length > 0) {
          lines.push("  kept explicit entry filters (not written by lazy):");
          for (const s of result.keptOverrides) lines.push(`    ${s}`);
        }
        for (const p of result.backups) lines.push(`  backup: ${p}`);
        lines.push("Not in effect yet \u2014 run /reload for the change to take effect.");
        lines.push("To come back: /lazy init (rebuild the catalog) or restore a *.bak.rescue-* file.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "enable" || sub === "en") {
        const name = rest.join(" ").trim();
        if (!name) {
          ctx.ui.notify(formatRoster(loadRoster(agentDir), "enable"), "info");
          return;
        }
        const result = enablePackage(agentDir, name);
        if (!result.ok) {
          ctx.ui.notify(`enable failed: ${result.error}`, "error");
          return;
        }
        refreshStatus(pi, rt, ctx);
        if (result.noop) {
          ctx.ui.notify(`enabled ${name} \u2014 already in the loading scheme [${result.mode}], nothing to do`, "info");
          return;
        }
        const lines = [`enabled ${name} \u2014 back in the loading scheme`];
        if (result.restoredSpec) lines.push(`  lazy.json: spec restored [${result.mode}]${result.specFrom ? ` from ${basename(result.specFrom)}` : ""}`);
        if (result.restoredEntry) lines.push(`  settings.json: package entry restored${result.entryFrom ? ` from ${basename(result.entryFrom)}` : ""}`);
        lines.push(`  migrate: ${(result.migrated ?? 0) > 0 ? `${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated` : "nothing to change"}`);
        if (result.migrateError) lines.push(`  migrate error: ${result.migrateError}`);
        lines.push("  node_modules: untouched \u2014 `pi install npm:<name>` if the package itself is gone");
        for (const p of result.backups) lines.push(`  backup: ${p}`);
        lines.push("Not in effect yet \u2014 run /reload for the change to take effect.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "disable" || sub === "d") {
        const name = rest.join(" ").trim();
        if (!name) {
          ctx.ui.notify(formatRoster(loadRoster(agentDir), "disable"), "info");
          return;
        }
        const result = disablePackage(agentDir, name);
        if (!result.ok) {
          ctx.ui.notify(`disable failed: ${result.error}`, "error");
          return;
        }
        refreshStatus(pi, rt, ctx);
        if (result.noop) {
          ctx.ui.notify(`disabled ${name} \u2014 already out of the loading scheme, nothing to do`, "info");
          return;
        }
        const lines = [`disabled ${name} \u2014 removed from the loading scheme`];
        if (result.droppedFromSettings) lines.push("  settings.json: package entry removed");
        else lines.push("  settings.json: no matching package entry (spec only)");
        lines.push("  lazy.json: spec removed");
        lines.push(`  migrate: ${(result.migrated ?? 0) > 0 ? `${result.migrated} entr${result.migrated === 1 ? "y" : "ies"} updated` : "nothing to change (this package is out of settings; migrate only confirms the rest of the catalog)"}`);
        lines.push("  node_modules: untouched \u2014 `pi install npm:<name>` brings it back");
        for (const p of result.backups) lines.push(`  backup: ${p}`);
        lines.push("Not in effect yet \u2014 run /reload for the change to take effect.");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "doctor") {
        ensureManagerCompat(agentDir, rt);
        ctx.ui.notify(runDoctor(agentDir, rt).join("\n"), "info");
        return;
      }
      if (sub === "load" || sub === "l") {
        const name = rest.join(" ").trim();
        if (!name) {
          ctx.ui.notify("usage: /lazy load <name>", "warning");
          return;
        }
        const res = await loadByName(pi, rt, name, ctx);
        if (!res.ok) {
          ctx.ui.notify(`load failed: ${res.error}`, "error");
          return;
        }
        if (res.alreadyLoaded) {
          ctx.ui.notify(`${res.name} already loaded/eager`, "info");
          return;
        }
        ctx.ui.notify(
          `loaded ${res.name}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}${res.tools?.length ? ` \u2014 tools: ${res.tools.join(", ")}` : ""}`,
          "info"
        );
        return;
      }
      ctx.ui.notify("usage: /lazy [status|list|profile|load <name>|disable <name>|enable <name>|rescue|snapshot <name>|restore <name>|init|scan|migrate|auto on|off|config]", "warning");
    }
  });
  pi.registerTool({
    name: "lazy_load",
    label: "Lazy Load",
    description: "Load a deferred Pi extension package managed by pi-lazy (LazyVim-style). Use when a capability is pending/on-demand (web, mcp, lens, plannotator, context-mode, etc.). Prefer /lazy list names.",
    promptSnippet: "Load a deferred pi-lazy extension package on demand",
    parameters: Type.Object({
      name: Type.String({ description: "Spec name from /lazy list (e.g. web, mcp, lens, plannotator)" })
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const res = await loadByName(pi, rt, params.name, ctx);
      const details = {
        ok: res.ok,
        name: res.name,
        alreadyLoaded: !!res.alreadyLoaded,
        loadMs: res.loadMs ?? null,
        tools: res.tools ?? [],
        commands: res.commands ?? [],
        error: res.error ?? void 0
      };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed: ${res.error}` }],
          details
        };
      }
      return {
        content: [
          {
            type: "text",
            text: res.alreadyLoaded ? `'${res.name}' already loaded or eager.` : `Loaded '${res.name}' in ${res.loadMs ?? "?"}ms. tools=[${(res.tools ?? []).join(", ")}] commands=[${(res.commands ?? []).join(", ")}]`
          }
        ],
        details
      };
    }
  });
}
function piLazy(pi) {
  return createPiLazy(pi, getAgentDir4());
}
export {
  createPiLazy,
  piLazy as default
};

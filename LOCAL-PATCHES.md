# 本地补丁清单（LOCAL-PATCHES）

> **本目录不是原版 pi-lazy。** 这是本地维护的分支，含 **14 处 dist 补丁（P1–P14）+ 2 个外部包补丁（`pi-extmgr` 就地补丁 / `pi-powerline-footer` 自愈补丁）+ 2 处用户配置改动（`lazy.json`、`mcp-adapter.json`）**。
>
> - 上游基线：`@rahularya01/pi-lazy` **0.3.1**（repo `Rahularya01/pi-lazy`，分支 `main`，最后 push `2026-08-27`）
> - 本文件用途：**作者更新后逐条核对** —— 上游已修的 → 跟随上游；未修的 → 把补丁抄回来。
> - 位置：`E:\pi-agent\agent\extensions\pi-lazy\`
> - **最后更新：2026-10-15**
>
> **环境事实（改文件前先记住这几条）**
> - pi **1.2.0** / node **v24.20.0** / Windows · Git Bash
> - `C:\Users\32203\.pi\agent` 是指向 `E:\pi-agent\agent` 的 **junction**（inode 相同）→ **两边是同一份文件**，不存在"改错副本"，但也别当两份去改
> - `dist/index.js` 是 **esbuild bundle**；`src/*.ts` 是上游源码。我们**只改 bundle**（`package.json` 的 `scripts.build` 就是 esbuild）
> - `README.md` / `CHANGELOG.md` 是**上游原版、未改动** —— 故意不动，保持 `pi update` 的 diff 干净

---

## 一、更新后怎么核对（四组命令）

```bash
# ① 拉上游源码（raw.githubusercontent 被墙，走 api）
TOKEN=ghp_xxx
for f in package.json src/config.ts src/migrate.ts src/index.ts src/types.ts; do
  curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/Rahularya01/pi-lazy/contents/$f" \
    -o "E:/pi-agent/agent/_upstream/$(echo $f | tr '/' '_')"
done

# ② 看上游修了没（对应下面每条的「检测 needle」）
grep -n 'typebox'          E:/pi-agent/agent/_upstream/package.json          # P1
grep -n 'pi-paster\|context-mode\|pi-lens\|plannotator' E:/pi-agent/agent/_upstream/src_config.ts   # P2
grep -n 'auto: true'       E:/pi-agent/agent/_upstream/src_config.ts          # P3
grep -n 'packages.push\|obj.extensions = \[\]' E:/pi-agent/agent/_upstream/src_migrate.ts            # P5
grep -c '__piLazyStatus\|managerCompat\|runDoctor' E:/pi-agent/agent/_upstream/src_index.ts          # P6-P9
grep -c 'ui.setStatus'     E:/pi-agent/agent/_upstream/src_index.ts          # P10（有命中 = 上游还在自己发状态行）

# ③ 本地自检（补丁是否完整）—— 箭头后是期望值
D=E:/pi-agent/agent/extensions/pi-lazy/dist/index.js
node --check "$D"                                  # 语法 OK
grep -c 'managerCompat: true'          "$D"        # P4  → 1
grep -c 'function ensureManagerCompat' "$D"        # P9  → 1
grep -c 'function runDoctor'           "$D"        # P8  → 1
grep -c '__piLazyManagedSources'       "$D"        # P7  → ≥1
grep -c 'setStatus("pi-lazy"'          "$D"        # P10 → 0（删干净才算修好）
grep -c 'function ensureFooterCompat'  "$D"        # P11 → 1
grep -c 'getRecentSessionsFast'        "$D"        # P11 → 6（嵌在补丁文本里）
grep -c 'footerCompat'                "$D"        # P11 → 1

# ④ pi-extmgr 就地补丁（不在 dist 里，单独查）
E=E:/pi-agent/agent/npm/node_modules/pi-extmgr/src/packages/extensions.ts
grep -c 'pkgFiltersLazy'  "$E"                     # → 3
grep -c 'lazyDeferred'    "$E"                     # → 3
grep -c 'resource.enabled || lazyDeferred' "$E"    # → 1（第一分支 = 真正生效的那条）
grep -c 'lazyDeferred) state = "enabled"'  "$E"    # → 1（第二分支 = 防御性）

# ⑤ pi-powerline-footer 自愈补丁（同样不在 dist 里）
F=E:/pi-agent/agent/npm/node_modules/pi-powerline-footer
grep -c 'getRecentSessionsFast' "$F/index.ts"                      # → 4（1 定义 + 2 调用 + 1 注释）
grep -c 'await getRecentSessions(3, request.signal)' "$F/index.ts" # → 0（换干净了才算修好）
grep -c 'setRecentSessions'     "$F/welcome.ts"                    # → 1

# ⑥ 用户配置（不是补丁，但重装/迁移后也要在）
G=E:/pi-agent/agent/mcp.json
grep -c 'deferWithMissingMetadata' "$G"          # → 1
grep -c 'github-mcp-ca.pem'        "$G"          # → 1
test -f E:/pi-agent/agent/certs/github-mcp-ca.pem && echo 'CA bundle ✓'   # 文件在
```

**结论口径**：
- 上游**已修**（检测命令无命中 / 已含该符号）→ **删掉我们的补丁，跟随上游**
- 上游**未修** → 按下面「改法」把补丁抄回本地 `dist/index.js`
- 上游**改了附近代码**（锚点找不到）→ 别硬套，先看上游新逻辑，再决定补丁是否还需要

---

## 二、补丁总表

| # | 文件 | 一句话 | 上游 0.3.1 状态 |
|---|---|---|---|
| P1 | `package.json` | `typebox` 从 `dependencies` 挪到 `peerDependencies` | ❌ **未修**（仍是 `dependencies`） |
| P2 | `dist` ← `src/config.ts` | 内置默认目录 13 条 → 5 条（删 8 个幽灵包） | ❌ **未修** |
| P3 | `dist` ← `src/config.ts` | `defaultConfig().auto`：`true` → `false` | ❌ **未修**（仍是 `true`） |
| P4 | `dist` ← `src/config.ts` | 新增 `managerCompat`（defaultConfig + loadConfig 回传） | ❌ 上游无此概念 |
| P5 | `dist` ← `src/migrate.ts` | migrate 加三道让位 guard | ❌ **未修**（三处强写都在） |
| P6 | `dist` ← `src/index.ts` | 发布 `globalThis.__piLazyStatus` | ❌ 上游无 |
| P7 | `dist` ← `src/index.ts` | 发布 `globalThis.__piLazyManagedSources` | ❌ 上游无 |
| P8 | `dist` ← `src/index.ts` | 新增 `/lazy doctor` 诊断命令 | ❌ 上游无 |
| P9 | `dist` ← `src/index.ts` | 新增 `ensureManagerCompat()`（自动重打 extmgr 补丁） | ❌ 上游无 |
| P10 | `dist` ← `src/index.ts` | `refreshStatus` 不再调 `ui.setStatus`（去掉底部重复状态行） | ❌ 上游无 |
| P11 | `dist` ← `src/index.ts` | 新增 `ensureFooterCompat()`（自动重打 pi-powerline-footer 补丁） | ❌ 上游无 |
| P12 | `dist` ← `src/index.ts` | 新增 `learnCommandsToSpec()`（加载成功后自动把包注册的命令学回 `lazy.json` 的 `spec.cmd`） | ❌ 上游无 |
| P13 | `dist` ← `src/config.ts` | `defaultConfig()` 出厂模板清空 `specs: []`，不再预置 npm:pi-subagents 等死条目 | ❌ 上游无 |
| P14 | `dist` ← `src/resolve.ts` | `normalizeSourceKey()` 本地路径走 `realpathSync` 折叠 junction/符号链接 + 剥尾斜杠 + 小写归一 | ❌ 上游无 |

> 上游源码是 `src/*.ts`（构建产物 `dist/index.js`）；我们改的是 **bundle 后的 `dist/index.js`**。
> 抄补丁时可以直接改 dist；若想改源码重建，`package.json` 里的 `scripts.build` 是 esbuild 打包。

---

## 三、逐条详情

### P1 · typebox 依赖声明违规

- **上游位置**：`package.json`
  ```json
  "dependencies": { "typebox": "^1.0.17" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.81.1" }
  ```
- **症状**：每次启动 Pi 都报
  ```
  Host-provided extension packages must be declared in peerDependencies with a "*" range,
  not dependencies: typebox. Installed copies can bypass the extension loader and create
  duplicate runtime modules.
  ```
- **本地改法**：
  ```json
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.81.1",
    "typebox": "^1.0.17"
  }
  ```
- **为什么**：Pi 的 `HOST_PROVIDED_EXTENSION_PACKAGES` 白名单里含 `typebox`，host 包必须走 peer，否则自己带一份副本。作者 `scripts.build` 里本来就有 `--external:typebox`，说明运行时 typebox 就该由宿主提供 —— manifest 漏了这一步。
- **检测**：`grep -n 'typebox' _upstream/package.json` → 若出现在 `peerDependencies` 且 `dependencies` 里没有 → 上游已修。
- **已在 GitHub 报过**：[issue #6](https://github.com/Rahularya01/pi-lazy/issues/6)

---

### P2 · 内置默认目录含 8 个幽灵包

- **上游位置**：`src/config.ts` → `defaultConfig().specs`
  含：`pi-grok-cli`、`pi-antigravity`、`@rahularya01/pi-cursor`、`@hypabolic/pi-hypa`、`pi-paster`、`context-mode`、`pi-lens`、`@plannotator/pi-extension`
- **症状**：`/lazy init` 把整份默认目录写回 `lazy.json`，`/lazy migrate` 再把它塞进 `settings.packages` → **用户没装的包被 Pi 装进来**（"我 15 个包怎么变成 20 个"）。
- **本地改法**：`defaultConfig().specs` **只保留 5 条真实包**：
  `subagents`、`todo`、`ask-user`（after-start）+ `web`、`mcp`（lazy: true）
- **检测**：`grep -n 'pi-paster\|context-mode\|pi-lens\|plannotator' _upstream/src_config.ts` → 无命中 = 上游已修
- **已在 GitHub 报过**：[issue #7](https://github.com/Rahularya01/pi-lazy/issues/7)

---

### P3 · `defaultConfig().auto` 默认 true

- **症状**：`/lazy init` 会把 `auto` 重置回 `true` → 关键词自动加载被悄悄打开（用户明确设过 `false`）。
- **本地改法**：`defaultConfig()` 里 `auto: true` → `auto: false`
- **检测**：`grep -n 'auto: true' _upstream/src_config.ts` → 无命中 = 上游已修

---

### P4 · 新增 `managerCompat` 参数

- **本地改法**（两处）：
  ```js
  // defaultConfig()
  managerCompat: true,

  // loadConfig() 的 return
  managerCompat: raw.managerCompat === true,
  ```
- **注意**：`loadConfig` 只回传**白名单字段**，新参数必须在 return 里显式带上，否则 `rt.config.managerCompat` 永远是 `undefined`，P9 就永远不触发。
- **配置文件**：`E:\pi-agent\agent\lazy.json` 里也有 `"managerCompat": true`
- **检测**：`grep -c managerCompat _upstream/src_config.ts` → 0 = 上游没有（本补丁仍属本地独有）

---

### P5 · migrate 的三道让位 guard（最重要）

- **上游位置**：`src/migrate.ts`
  ```js
  // :80  不在 settings 里也硬塞 → 幽灵包来源
  packages.push({ source, extensions: [] });

  // :99  已有条目无论带什么都强写成 [] → 覆盖 pi-extmgr 的禁用标记
  obj.extensions = [];
  ```
- **本地改法**（managed 循环）：
  ```js
  if (idx === -1) {                       // ① 不在册 → 不添加
    skipped.push(`${spec.name} (not registered; left alone)`);
    continue;
  }
  if (typeof current === "string") {       // ② 纯字符串 → 接管
    packages[idx] = { source: current, extensions: [] };
    changed.push(spec.name);
    continue;
  }
  if (current && typeof current === "object") {
    const filters = Array.isArray(current.extensions) ? current.extensions : [];
    if (filters.length === 0) { skipped.push(spec.name); continue; }      // 已是 lazy 形态
    const blocking = filters.some((t) => t.trim().startsWith("-") || t.trim().startsWith("!"));
    if (blocking) {                        // ③ 带排除标记 → 让位（归 extmgr / pi config）
      skipped.push(`${spec.name} (yielded: entry has exclusions)`);
      continue;
    }
    const obj = { ...current, extensions: [] };   // 只有 + 放行标记 → 收回为 []
    packages[idx] = obj;
    changed.push(spec.name);
    continue;
  }
  ```
- **规则一句话**：**只有纯字符串才接管；带 `-`/`!` 的一律不碰；不在册的一律不加。**
- **为什么**：`extensions` 字段被 pi-lazy 和 pi-extmgr 共用，语义冲突：
  | 值 | pi-lazy 意思 | pi-extmgr 意思 |
  |---|---|---|
  | `[]` | 延迟加载（我接管） | 全部禁用 |
  | `["+x"]` | 放行（可接管） | 启用 |
  | `["-x"]` / `["!g"]` | 让位 | 禁用 |
- **踩坑记录**：第一版 guard 写成"任何非空 filters 都让位" → **把 `+` 也当禁用 → 懒加载全灭**。必须只对 `-`/`!` 让位。
- **检测**：`grep -n 'packages.push\|obj.extensions = \[\]' _upstream/src_migrate.ts` → 无命中 = 上游已修
- **已在 GitHub 报过**：[issue #7](https://github.com/Rahularya01/pi-lazy/issues/7)

---

### P6 · 发布 `globalThis.__piLazyStatus`

- **位置**：`refreshStatus()`
  ```js
  globalThis.__piLazyStatus = rt.status;
  ```
- **用途**：把状态串暴露给别的扩展渲染。本机由 `persona-loader` 的挂件读取，把 `lazy 2↑ 3· 4⚡` 显示在"越狱"徽标**上方**。
- **为什么不直接用 `ui.setStatus`**：pi 的 `extensionWidgetsAbove` 是 Map 按插入顺序渲染，且 `setWidget` 是"先删再插"→ 刷新越勤越靠后，**抢不到固定位置**。所以改由 persona-loader 单挂件渲染两行。
- **检测**：`grep -c __piLazyStatus _upstream/src_index.ts` → 0 = 上游无

---

### P7 · 发布 `globalThis.__piLazyManagedSources`

- **位置**：`refreshStatus()`
  ```js
  globalThis.__piLazyManagedSources = new Set(
    [...rt.entries.values()].filter((e) => e.spec.lazy !== false).map((e) => e.spec.source)
  );
  ```
- **用途**：给 **pi-extmgr 补丁**（见第五节）读，用来把"被 lazy 接管的包"显示成 `enabled` 而不是 `disabled`。
- **检测**：`grep -c __piLazyManagedSources _upstream/src_index.ts` → 0 = 上游无

---

### P8 · 新增 `/lazy doctor`

- **位置**：`dist/index.js` 三处
  1. `function runDoctor(agentDir, rt)`
  2. 命令分支 `if (sub === "doctor") { ctx.ui.notify(runDoctor(agentDir, rt).join("\n"), "info"); return; }`
  3. 补全列表加 `"doctor"`
- **检查 7 类**（每一类都是真踩过的坑）：
  | 检查 | 抓什么 |
  |---|---|
  | `lazy.json` 能否解析 | 坏 JSON 会**静默降级到内置兜底** |
  | `lazy` 值是否合法 | 字符串 `"true"` 之类 → **spec 被静默丢弃 → 包彻底不加载** |
  | settings 重复条目 | 同一 source 多次 |
  | **重复登记**（settings ∩ `extensions/`） | 扩展被加载两遍 |
  | 每个 spec 的条目形态 | 未 migrate / 已接管 / 让位 / 待收回 |
  | **无触发入口** | `lazy: true` 但没 `cmd`/`tools`/`keywords` → 只能手动 load |
  | 运行态 | 加载失败、after-start 队列结束仍有 pending（= 懒加载没生效） |
- **检测**：`grep -c runDoctor _upstream/src_index.ts` → 0 = 上游无

---

### P9 · 新增 `ensureManagerCompat()`（自动重打 extmgr 补丁）

- **位置**：`dist/index.js`
  1. `function ensureManagerCompat(agentDir, rt)`
  2. `session_start` 里 `refreshStatus(...)` 之后调用
- **逻辑**：`managerCompat !== true` → 直接返回；否则检查
  `agentDir/npm/node_modules/pi-extmgr/src/packages/extensions.ts`
  - 已含标记 `__piLazyManagedSources` → 跳过（幂等）
  - **三处替换全部命中才写入**（全有或全无）；任一锚点找不到 → 打印 `兼容补丁跳过：锚点未命中 …` 并放弃（上游改了代码，不硬套）
  - 三处 = 5.1 节的 ① 插入 `pkgFiltersLazy`/`lazyDeferred` ② 第一分支 `state:` ③ 第二分支 `const state =` → `let state =` + 覆盖
  - 写入后 `console.error("[pi-lazy] re-patched pi-extmgr for lazy compat")`
- **用途**：`pi update` 覆盖 pi-extmgr 后，**下次启动自动把兼容补丁打回去** —— 这就是那个"一个参数强行让 extmgr 认识懒加载"的开关。
- **检测**：`grep -c ensureManagerCompat _upstream/src_index.ts` → 0 = 上游无
- **实测（2026-10-15）**：抽出 dist 里这个函数，对 **pristine 上游文件**跑一遍 → 产出与线上文件**逐字节一致**（17949 bytes），且**幂等**（连跑两次结果相同）。
- **5 个场景全绿**（回归套件，配方见 8.5）：

  | 场景 | 期望 | 实测 |
  |---|---|---|
  | pristine（= `pi update` 之后） | 自动打回，与线上文件逐字节一致 | ✓ |
  | 连跑两次 | 第二次跳过（已含标记），文件不变 | ✓ |
  | `managerCompat: false` | 完全不动 | ✓ |
  | 上游改了锚点附近代码 | 打印 `锚点未命中` 并**拒绝写入** | ✓ |
  | pi-extmgr 未安装 | 静默返回，不抛错 | ✓ |

### P10 · 去掉底部重复的懒加载状态行

- **位置**：`dist/index.js` 的 `function refreshStatus(pi, rt, ctx)`
- **改动**：删掉整段
  ```js
  const target = rt.sessionCtx ?? ctx;
  if (!target) return;
  try {
    const ui = target.ui;
    if (ui && typeof ui.setStatus === "function") {
      ui.setStatus("pi-lazy", rt.status);
    }
  } catch {
  }
  ```
  只保留 `globalThis.__piLazyStatus = rt.status;`（和 `__piLazyManagedSources`）。
- **为什么**：状态行已由 persona-loader 渲染在**顶部**（`placement: "aboveEditor"`，读 `globalThis.__piLazyStatus`）；`ui.setStatus` 是 pi 的**底部**状态栏 —— 两者同时存在 → 图标上下各一份（2026-10-15 用户报障）。
- **检测**：`grep -c "ui.setStatus" dist/index.js` → 应为 0
- **备份**：`dist/index.js.bak.statusdup.*`

---

### P11 · 新增 `ensureFooterCompat()`（自动重打 pi-powerline-footer 补丁）

**为什么**：见 5.4 —— 欢迎浮层/顶栏被一行 `await getRecentSessions(3, signal)` 卡住 ~9.5s。那个补丁打在 pi-powerline-footer 里，`pi update` 会冲掉，所以照 P9 的模板做自愈。

**位置**：`dist/index.js:1174`（函数定义）；`dist/index.js:1674` 在 `session_start` 里紧接 `ensureManagerCompat(agentDir, rt);` 调用。

**逻辑**：`rt.config.footerCompat === false` → return；两个文件任一不存在 → return；两个文件都已带标记（`getRecentSessionsFast` + `setRecentSessions`）→ return（幂等）；**7+1 个锚点全部命中且唯一**才写入，否则打印 `[pi-lazy] pi-powerline-footer 兼容补丁跳过：锚点未命中或重复（N 次）"..."` 并**放弃写入**（全有或全无，两个文件都不动）；写入后打印 `[pi-lazy] re-patched pi-powerline-footer for fast welcome (restart to take effect)`。

**实测**（抽出 dist 里真实的 `ensureFooterCompat`，拿两个 pristine 备份当输入）：**7/7 全绿**

| 场景 | 期望 | 实测 |
|---|---|---|
| pristine（= `pi update` 之后） | 自动打回，与线上**逐字节一致** | ✓ index 137214B / welcome 17829B |
| 连跑两次 | 第二次跳过，文件不变 | ✓ |
| `footerCompat: false` | 完全不动 | ✓ |
| 上游改了锚点 | 打印锚点未命中并**拒绝写入** | ✓ |
| pi-powerline-footer 未安装 | 静默返回，不抛错 | ✓ |

**⚠️ 改 5.4 的补丁时，必须同步本函数里的嵌入副本**（同 8.5 的坑）。

### P12 · 新增 `learnCommandsToSpec()`（加载后自动学回 cmd）

**为什么**：`/mcp` 在 TUI 按不出来 —— pi-lazy 只给 `spec.cmd` 里声明的命令注册 stub，而现行 `lazy.json` 里 mcp spec 的 `cmd` 字段在历次改动中丢了（快照 susu.json 里还有 `"cmd":["mcp"]`）。每次手补是一次性止血；学回机制让任何包在**任何加载路径**（after-start / cmd 触发 / tool 触发 / keyword 触发）加载成功后，把 tracking Proxy 记到的命令（`entry.loadedCommands`）自动写回对应 spec 的 `cmd`，下次启动 stub 就在。

**位置**：`src/index.ts:1426`（函数定义）；`src/index.ts:1416` 在 `loadByName` 成功路径 `refreshStatus` 之后调用。`dist/index.js:2109`（定义）/ `dist/index.js:2106`（调用）—— src 与 dist 已同步，`tsc --noEmit` 零报错。

**逻辑**：`result.ok` 为假或 `commands` 为空 → return；`spec.cmd` 已含全部命令 → return；`rt.config.specs` 里找不到同名 spec → return；否则合并新命令后 `saveConfig(rt.config)`（走 `getAgentDir()` 默认值）。**best-effort**：save 抛错只打 `console.error`，绝不打断加载本身。

**实测**（逻辑复刻四用例）：缺 cmd 学回 3 条 ✓；已有部分只补缺 ✓；load 失败不写 ✓；spec 不在 config 不写 ✓。

**⚠️ 上游同步注意**：上游没有此功能；若上游日后加了类似机制，优先用上游的，删本条。

### P13 · 出厂模板清空（`defaultConfig().specs = []`）

**为什么**：上游模板第一条是 `npm:pi-subagents`，本机从未安装该包，但它作为死 spec 每次空白 init 都会复活——after-start 队列每次启动白烧一次 load 失败，P12 也救不了（load 失败不写回，设计如此）。操作员定调：**不需要任何出厂模板，init 见到什么装的就管什么**。

**位置**：`src/config.ts` `defaultConfig()` 末尾 `specs: []`；`dist/index.js` 同步。

**行为**：lazy.json 不存在时落盘空目录而不是预置目录；settings.json 里有什么包，scan 就发现什么（`discoverSpecsFromSettings` / `discoverLocalExtensions`），一个不多。

**实测**：`grep -n "pi-subagents" src/*.ts dist/index.js`（排除 .bak）零命中；模板清空后重跑空白 init 场景 = 下次重启验证。

### P14 · `normalizeSourceKey()` 解析 junction 真实路径

**为什么**：`~/.pi/agent` 是指向 `E:\pi-agent\agent` 的 junction。settings.json 里同一扩展有 E 盘 / C 盘两种拼写（persona-loader / pi-lazy / pi-status-mask 各一对），旧去重键只做 trim + npm 名提取，双拼写不折叠 → 空白 init 给 pi-lazy 建了**两个 spec**（一个 E 一个 C）。两个都 `lazy:false` 时无害，但只要有一个被改成 lazy，同一包会被加载两遍。

**位置**：`src/resolve.ts:181`（函数）；`dist/index.js:868` 同步。

**逻辑**：npm: 前缀路径行为不变；本地路径 `realpathSync` 解析（junction 两拼写折叠为同一真实路径），再剥尾部 `[/\]+`、小写归一；路径不存在时回退为「原样剥尾斜杠+小写」——**不抛错、不稳定漂移**。受益面：scan 去重（discoverSpecsFromSettings / discoverLocalExtensions 的 covered 集合）、buildRoster 去重、sourcesMatch 兜底。

**实测**（抽出 dist 真实函数 eval，五用例全绿）：E/C 双拼写折叠 ✓；不存在路径回退稳定（含尾斜杠变体）✓；npm 路径不受影响 ✓；真实路径尾斜杠/尾反斜杠剥离 ✓。

**已知边界**：`sourcesMatch` 对不存在的 Windows 路径仍大小写敏感（回退键小写、但比较走 normalizeSourceKey 的小写化，两侧都小写，故相等）；若上游引入大小写敏感的 selector 区分，需复查 `.toLowerCase()`。


## 四、其它本地改动（不在 dist 里）

### 4.1 `package.json` 本地化
```json
"name": "pi-lazy",          // 原 @rahularya01/pi-lazy
"private": true,
// 删除 publishConfig
// description 追加 " (local copy in extensions/pi-lazy)"
```
**原因**：本地扩展，不发布。

### 4.2 注册方式（重要，别再犯）
- pi-lazy **只**通过 `extensions/` 目录自动发现加载（`resolveExtensionEntries` 读 `package.json` 的 `pi.extensions`）
- **绝不要**再把它写进 `settings.packages` → 否则**加载两遍**（双管理器、双 after-start 队列，启动巨慢）

### 4.3 lazy_load 工具描述
去掉已不存在的包名示例（`lens`、`plannotator`、`context-mode`）。

### 4.4 用户数据清洗（2026-10-17，配合 P13/P14）

- `lazy.json`：删除 `subagents`（指向从未安装的 npm:pi-subagents）与盘符为 C 的重复 `pi-lazy` spec（junction 双拼写产物）→ 16 specs
- `lazy-snapshots/*.json` 四份（mini / rainbow / robot / susu）：各删 `subagents` + `pi-workspace-history`（包已卸载）→ 19→17 specs；**cmd 配置一律未动**
- 备份：`lazy.json.bak.fixAB-*`、`lazy-snapshots/*.bak.clean-*`
- 以后 restore 存档前无需再手动剔死条目；新空白 init 由 P13 保证不再预置死模板

---

## 五、pi-lazy 之外的配套改动

### 5.1 `pi-extmgr`（**就地补丁，未本地化**）

- **文件**：`E:\pi-agent\agent\npm\node_modules\pi-extmgr\src\packages\extensions.ts`
- **函数**：`discoverPackageExtensions()`（第 485 行起）
- **⚠️ 第一版补丁打错分支，白白踩了一轮**：该函数有**两条**产出 `state` 的路径，`if (resolvedResources.length > 0)` 那条**末尾有 `continue`**。lazy 包在 settings 里是 `extensions: []` → Pi 的解析器**会**返回资源但 `enabled: false` → 走第一分支 → 第二分支（fallback 扫描器）**永远到不了**。
- **改动（三处，全有或全无）**：

  **① 循环开头插入**（`const resolvedResources = resourcesForPackage(...)` 那行之后）：
  ```ts
  const pkgFiltersLazy =
    (pkg.scope === "global" ? globalFilterMap : projectFilterMap).get(
      normalizeConfiguredPackageSource(pkg.source)
    ) ?? undefined;
  // pi-lazy 兼容：extensions:[] 且该包被 lazy 接管 = 延迟加载，不是禁用
  const lazyDeferred =
    Array.isArray(pkgFiltersLazy) &&
    pkgFiltersLazy.length === 0 &&
    !!(globalThis as { __piLazyManagedSources?: Set<string> }).__piLazyManagedSources?.has(pkg.source);
  ```

  **② 第一分支（真正生效的那条）**：
  ```ts
  state: resource.enabled || lazyDeferred ? "enabled" : "disabled",
  ```

  **③ 第二分支（fallback 扫描器，防御性保留）**：
  ```ts
  let state = getPackageFilterState(packageFilters, normalizedPath);
  if (state === "disabled" && lazyDeferred) state = "enabled";
  ```
- **为什么**：extmgr 的 `getPackageFilterState` 里 `filters.length === 0` → 返回 `"disabled"`，而 `[]` 正是 lazy 的形态；`resource.enabled` 对 `[]` 同样是 `false` → 面板把 lazy 包全标成禁用，用户会去点 enable（写回 `+path`）→ 掐死懒加载。
- **两个条件缺一不可**：
  - `pkgFiltersLazy.length === 0` —— 只认 lazy 真接管的 `[]`；带 `-`/`!` 的是 extmgr 自己禁的（如 `goal-x`），保持 disabled
  - `__piLazyManagedSources.has(pkg.source)` —— 该包确实在 lazy 的 managed 集合里
- **实测证据**（2026-10-15，用 jiti 直调真实 `discoverPackageExtensions`，A/B 对照）：
  - 不设全局（补丁前行为）：10 个 lazy 包 **全 disabled**（精确复现用户截图）
  - 设全局（面板真实情形）：**9 个 enabled**，`goal-x` 保持 disabled ✓
- **⚠️ 生效需要完整重启**：`src/packages/extensions.ts` 是**打开面板时才动态加载**的（启动时不加载，已用启动期探针证明零输出）。若在打补丁前已开过面板，该模块已缓存在当前进程里 → 必须**退出 pi 重开**，`/reload` 未必能踢掉它。
- **为什么不本地化**：用户明确不要（保持可跟随上游更新）。
- **更新后怎么办**：**不用手动** —— P9 的 `ensureManagerCompat()` 会在下次启动自动重打（幂等）。
- **备份**：`extensions.ts.bak.lazycompat*`

### 5.2 `persona-loader`（本机另一个扩展，**懒加载状态行的唯一渲染者**）

- **文件**：`E:\pi-agent\agent\extensions\persona-loader\index.ts`
- **位置**：`index.ts:673` 附近，挂件 `render()`（`placement: "aboveEditor"`）
- **改动**：挂件 `render()` 改成渲染两行 —— 第 1 行读 `globalThis.__piLazyStatus`，第 2 行原来的"越狱"徽标
- **原因**：见 P6（widget 顺序抢不到位置）
- **⚠️ 与 P10 是一对**：**顶部**由这里渲染，**底部**由 pi-lazy 自己的 `ui.setStatus` 渲染 → 两边同时在 = 图标上下各一份。P10 把 pi-lazy 那份删了，**所以这里现在是唯一渲染点**；动这里 = 状态行直接消失，别乱动。

### 5.3 `lazy.json`（用户配置，非补丁）

- 15 条 spec 全部登记；档位 `after-start ×7 / true ×3 / false ×5`
- 各包补齐 `cmd`/`tools` 存根（命令名从各包源码核实）：`btw`→`/btw`、`plan-mode`→`/plan`、`extmgr`→`/extensions`、`workspace-history`→`/history-status /checkpoint /undo /redo /diff`、`goal-x`→`/goal /goal-list /goal-status`、`subagents`→`/subagents`、`web`→`/websearch /search /web`、`mcp`→`/mcp-auth`、`todo`→tool `todo`、`ask-user`→tool `ask_user_question`
- `"managerCompat": true`
- 备份：`lazy.json.bak.*`

---

### 5.4 `pi-powerline-footer`（**就地补丁 + P11 自愈**）

**症状**：启动后「美化弹窗」和顶栏的「PI 配置信息」要过好几秒才出现，观感像"懒加载全跑完了它才蹦出来"。

**真根因（不是次序问题）**：欢迎浮层/顶栏渲染前有 `const recentSessions = await getRecentSessions(3, request.signal);`，而 `getRecentSessions` 要 `open()` 最近 3 个会话日志 —— **其中最新那个正是当前正在写入的会话文件**。本机（Windows + Defender）首次 open 该文件要 **~9.5s**（同进程第二次 0ms、已关闭的旧文件 0ms、12.9MB 的也是 0ms → 卡的是"刚被写过的活跃文件"，不是体积）。时序上 `t≈750ms` lazy 的 after-start 队列起跑、`t≈6s` 跑完，而那个 await 到 `t≈9.5s` 才返回 → 看起来就像弹窗被排到了最后。

**改法**：加 400ms 上限，超时先画空列表，迟到再回填。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `index.ts` | `./welcome.ts` 的 import 末尾加 `, type RecentSession` |
| 2 | `index.ts` | `const STASH_PREVIEW_WIDTH = 72;` 后加 `WELCOME_RECENT_SESSIONS_TIMEOUT_MS = 400` |
| 3 | `index.ts` | `function setupWelcomeHeader(` 前加 `getRecentSessionsFast()` |
| 4 | `index.ts` | 顶栏：`await getRecentSessions(3, ...)` → `await getRecentSessionsFast(request)` |
| 5 | `index.ts` | 顶栏：`ctx.ui.setHeader(() => header);` 后加"迟到重新 setHeader" |
| 6 | `index.ts` | 浮层：`await getRecentSessions(3, ...)` → `await getRecentSessionsFast(request)` |
| 7 | `index.ts` | 浮层：`new WelcomeComponent(...)` 后加"迟到 setRecentSessions + requestRender" |
| 8 | `welcome.ts` | `WelcomeComponent` 加 `setRecentSessions()` 方法 |

**自检**：
```bash
F=E:/pi-agent/agent/npm/node_modules/pi-powerline-footer
grep -c 'getRecentSessionsFast' "$F/index.ts"                      # → 4（1 定义 + 2 调用 + 1 注释）
grep -c 'await getRecentSessions(3, request.signal)' "$F/index.ts" # → 0（换干净了才算修好）
grep -c 'setRecentSessions'     "$F/welcome.ts"                    # → 1
```

**备份**（pristine 上游，8.6 的验证台用它们当输入）：
- `index.ts.bak.welcomefast.20261015_011321`
- `welcome.ts.bak.welcomefast.20261015_011403`

---

### 5.5 `mcp-adapter.json`（用户配置，**非补丁**）

> **为什么不是 `mcp.json`？** `pi-mcp-adapter` 对两种文件读法不同：
> - `E:/pi-agent/agent/mcp.json` = **Pi 自己的文件**（`kind: import`，`config.ts:1161 readPiMcpConfig`）→ **只认 Pi 的字段白名单**（`config.ts:1198` 解构：type/command/args/env/cwd/url/headers/oauth/exposure/toolExposure/enabled/timeout/auth/description），`caFile` 之类适配器字段会落进 `...unknown` → **被忽略**并告警；顶层 `settings`/`imports`/`claudePlugins` 也**不读**（这些是 `config.ts:1178 adapterKeys`，只有 `mcp-adapter.json` 认）。
> - `E:/pi-agent/agent/mcp-adapter.json` = **适配器自己的文件**（`kind: user`，`getPiGlobalConfigPath()` = `getAgentPath("mcp-adapter.json")`，`config.ts:213-214`）→ `readValidatedConfig` → `validateConfig` **全量读**：`mcpServers` 完整 ServerEntry（含 `caFile`）✓、`settings` ✓、`imports` ✓、`claudePlugins` ✓。
> - 合并语义（`config.ts:895 mergeConfigs` / `:914 mergeServerMaps`）：**按字段浅合并**，`mcp-adapter.json` 优先级高于 `mcp.json`；**url 相同**时 auth 材料（headers/bearer/oauth）继承保留，url 变了才剥离（凭据防外泄）；`settings` 是 `{...base, ...next}`。
> - 因此 **`caFile` 和 `settings` 必须放 `mcp-adapter.json`**；`mcp.json` 只放 Pi 认识的字段。

两处改动，都是为了让 MCP 快路径别被坏 server 拖住。

**① `E:/pi-agent/agent/mcp-adapter.json` 加 `"settings": { "deferWithMissingMetadata": true }`**

- 作用：任一 enabled server 的元数据缓存无效（`discoveryFailed` / hash 不匹配 / 无缓存）时，**不再退回慢路径**，直接用缓存快照起会话，后台再补。
- 依据：`pi-mcp-adapter/index.ts:753 getDeferredSessionSnapshot()` 的判据是
  `config.settings?.deferWithMissingMetadata !== true && (cache === null || hasEnabledServerWithoutValidMetadata(config, cache))`
  → 置 `true` 后这段恒为 `false`，快路径恒可用。
- 副作用（**有意为之**）：`index.ts:1385` 的 `if (config.settings?.deferWithMissingMetadata !== true) registerPromptCommands(resolveCachedPrompts(config));`
  → 启动时**不再注册 MCP prompt 命令**，等首次连接成功后再来。
- 备份：`mcp-adapter.json.bak.20261015_120847`；`mcp.json` 里的 settings 键已删（inert 字段不留）。

**② adapter 配置里 `github` 条目覆盖 `"caFile": "E:/pi-agent/agent/certs/github-mcp-ca.pem"`**（放 `mcp-adapter.json` 的 `mcpServers.github`，只写 url + caFile 两字段；url 与 `mcp.json` 相同 → headers 继承，无凭据剥离）

**症状**：`github` MCP 连不上，`mcp-cache.json` 里那条 `discoveryFailed: true`；`github` 一坏，`hasEnabledServerWithoutValidMetadata()` 就为真 → **整个 MCP 快路径被关掉**，每次启动都要全量重连。

**真根因（两层）**

1. **本机有两个 HTTPS 中间人**：卡巴斯基（`Kaspersky Anti-Virus Personal Root Certificate`）和 `billion-context`（bili，LLM API 代理）。谁抢到 github 的连接是**随机的** → 失败是**间歇性**的，不是必然。
2. **卡巴的根不在 Node 内置信任库里** → 被它抢到时握手报 `SELF_SIGNED_CERT_IN_CHAIN`。
   - 实测：不加 CA 连打 10 次 initialize → **成功 8 / 失败 2**（失败全是 `SELF_SIGNED_CERT_IN_CHAIN`）
   - 卡巴根**在 Windows 证书库里**（浏览器因此正常）：`LocalMachine\Root`，Thumbprint `92E8E196120231FB3CBAFCFED648716AF558E949`，NotAfter `2036-09-06`
   - bili 的根**已经被信任**了 —— 启动器注入 `NODE_EXTRA_CA_CERTS = C:\Users\32203\.local\share\billion-context\ca\root-ca.pem`（`CN=billion-context MITM Root CA`）

**为什么用 `caFile` 而不是改环境变量**

`pi-mcp-adapter` 原生支持**按 server 指定 CA**（`types.ts:452 caFile?: string`，实现在 `http-ca.ts` 的 `validateCaFile` / `createCaFetch`，`config.ts:912` 把它列为 URL 绑定的认证字段 → 不会被规范化丢掉）。它给该 origin 建一个独立的 undici Agent，注释明确写 **"never process-wide"**。

- ✅ 就在**我们自己维护的文件**里 → 任何 `pi update` 都覆盖不到
- ✅ 不动环境变量（`NODE_EXTRA_CA_CERTS` 会被 bili 启动器**覆盖**，写用户级也没用）
- ✅ 不改任何第三方包的文件
- ⚠️ 代价：`caFile` 是**替换**该 origin 的信任库（不是追加）→ **bundle 必须一次覆盖全部三种情形**

**bundle 内容**（`E:/pi-agent/agent/certs/github-mcp-ca.pem`，120 块 / 179,300 B）

| 来源 | 张数 | 覆盖的情形 |
|---|---|---|
| Node `tls.rootCertificates` | 118 | 直连（`Sectigo Public Server Authentication Root R46` → `USERTrust RSA CA`） |
| 卡巴斯基根 | 1 | 被卡巴拦 |
| bili 根 | 1 | 被 bili 拦 |

按 fp256 去重；120/120 可解析、无重复、PEM 外无残留（已按**指纹**核验两个中间人根确实在包里）。

**重生成配方**（卡巴换根 / Node 大版本升级后才需要；bundle 落在 `certs/` 里，不会被任何更新覆盖）

1. 从 Windows 库导出卡巴根（⚠️ `powershell` 工具宿主里**没有 `Cert:` PSDrive**，必须走 .NET）：

```powershell
$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine')
$s.Open('ReadOnly')
$c = $s.Certificates | Where-Object { $_.Subject -like '*Kaspersky Anti-Virus Personal Root*' }
$b64 = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
[IO.File]::WriteAllText('E:\pi-agent\agent\certs\kaspersky-mitm-root.pem', "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n")
```

   ⚠️ 导完**必须回读**：若当时恰好是直连，导出脚本可能抓到的是 `USERTrust` 那条链（踩过一次）。

2. bundle = `tls.rootCertificates` + 上面那个卡巴 pem + bili 的 `C:\Users\32203\.local\share\billion-context\ca\root-ca.pem`，按 `X509Certificate.fingerprint256` 去重拼接。

**备份**：`mcp.json.bak.githubca.20261015_115224`（改前）→ 后因告警移入 `mcp-adapter.json`；`mcp.json.bak.defermeta.20261015_113702`（settings 键加在 mcp.json 的版本，已废弃）；现 `mcp.json` **不再含** settings / caFile（已清），真正生效的是 `mcp-adapter.json`（备份 `mcp-adapter.json.bak.20261015_120847`）

**自检**：见 8.7。

## 六、历史踩坑速查（出问题时先看这里）

| 症状 | 真因 | 处置 |
|---|---|---|
| 启动慢（15 包 ~10s） | 每包 ~0.7s 串行同步加载 | 转 after-start + `/lazy migrate` → 3.4–4.1s |
| 莫名多出包 | P5 的 `packages.push` | 已修；跑 `/lazy migrate` 前先 `/lazy doctor` |
| 管理器里包全显示 disabled | `[]` 被 extmgr 读成禁用 | 已修（5.1 + P7） |
| 懒加载全灭 | 让位 guard 把 `+` 也当禁用 | 已修（只对 `-`/`!` 让位） |
| 命令打不出来 | 没 `cmd` 存根 + after-start 有延迟 | 已修（补存根） |
| **某包彻底不加载** | `lazy` 值写成字符串 `"true"` → spec 被静默丢弃 | `/lazy doctor` 会点名；改回布尔 |
| lazy.json 坏掉"反而更快" | 兜底到内置目录 → 部分包永不加载 | `/lazy doctor` 第一条就报 |
| 启动弹 "run /lazy migrate" | 归 extmgr 管的包（带 `-`）却挂在 lazy managed 集合 | 该 spec 设 `lazy: false` |
| 状态栏位置乱跳 | widget 插入顺序 + 先删再插 | 已修（P6 + 5.2） |
| 图标**上下各一份** | persona-loader 渲染顶部 + pi-lazy `ui.setStatus` 渲染底部 | 已修（P10 删掉底部那份） |
| **面板补丁打了还是 disabled** | 补丁打在**死代码分支**：`if (resolvedResources.length > 0)` 那条**末尾有 `continue`**，fallback 分支永远到不了 | 已修（补丁改到第一分支，见 5.1） |
| 补丁改了却**毫无变化** | `src/packages/extensions.ts` **按需加载**（开面板时才载入）且已缓存在当前进程 | **完整退出 pi 重开**；`/reload` 未必踢得掉 |
| 不知道改 `C:\...\.pi\agent` 还是 `E:\pi-agent\agent` | 前者是指向后者的 **junction** | 随便改哪个都一样（同一 inode），别当两份改 |
| **更新了 pi-extmgr，怕兼容补丁丢** | `pi update` 会把 `extensions.ts` 整个换成上游版 | **不用管** —— 下次启动 P9 自动重打（逐字节一致 + 幂等）；若上游改了锚点会打印"锚点未命中"并跳过（见 8.5） |
| **github MCP 连不上**（`discoveryFailed: true`） | 卡巴斯基做 HTTPS 中间人，根不在 Node 内置信任库 → `SELF_SIGNED_CERT_IN_CHAIN`；**间歇性**（本机两个中间人抢连接，谁抢到是随机的） | 已修（5.5：`github` 条目加 `caFile`） |
| **一个 MCP server 坏 → 整个 MCP 变慢** | `hasEnabledServerWithoutValidMetadata()` 为真 → 快路径被关，每次启动全量重连 | 已修（5.5：`settings.deferWithMissingMetadata: true`） |
| **冷启动 1 分钟**（刚重启电脑后第一次启动） | OS 文件缓存全空 + 杀软首次扫 + 恢复 10MB 会话日志 + MCP 后台全量连接，四件事叠加 | 加杀软排除目录（`E:/pi-agent/agent`、`E:/AI_Config`、`D:/Node`）；其余见 5.5 |

---

## 七、重打补丁的标准流程

```
1. 拉上游源码（第一节 ①）
2. 逐条核对第二节总表：上游已修的划掉，未修的留下
3. 覆盖 dist：pi update npm:@rahularya01/pi-lazy  （或手动换 dist/index.js）
4. 按第三节把未修的补丁抄回 dist/index.js（P1–P10）
5. 校验（第一节 ③④ 全套）：node --check + 各 grep 期望值
6. pi-extmgr 补丁：**不用手动** —— P9 的 ensureManagerCompat() 下次启动自动重打（幂等）
7. 跑 /lazy doctor 确认无异常
8. **完整退出 pi 再重开**（不是 /reload）—— 按需加载的模块缓存在进程里
9. 开一次扩展管理器面板：lazy 包应显示 enabled，goal-x 应显示 disabled
```

**改任何文件前先备份**（本目录已累积 `*.bak.*` 多份，可随时回滚）。
**改完必须验证**：见第八节 —— "改完就算完"是错的，面板和状态行都得亲眼看一遍。

---

## 八、怎么证明补丁**真的生效**（别靠猜）

补丁改完 ≠ 生效。下面这套手法是 2026-10-15 定位"面板还是 disabled"时摸索出来的，下次直接用。

### 8.1 先分清「没生效」还是「打错了」

症状一样（面板还是 disabled），原因可能完全不同：

| 可能 | 怎么排除 |
|---|---|
| 改错了文件 | 确认 junction：`C:\Users\32203\.pi\agent` 与 `E:\pi-agent\agent` 同一 inode |
| 补丁打错分支 | **直接读源码看控制流**：两条产 `state` 的路径，第一条末尾有没有 `continue` |
| 模块已缓存 | 完整重启再看 |
| 逻辑本身不对 | 用 8.2 的手法跑真代码 |

### 8.2 jiti A/B：直接调真实函数，绕开面板

extmgr 是 TS 源码（`src/packages/extensions.ts`，**没有 dist**），用 **jiti** 直接加载并调用真实函数，不用起 pi：

```js
// _tmp_probe.mjs —— 用完删掉（走 file_ops 正门：node "[@service_file_ops]" delete <路径> --ai pi）
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import("E:/pi-agent/agent/npm/node_modules/pi-extmgr/src/packages/extensions.ts");

// A/B：同一个函数，只改全局变量
delete globalThis.__piLazyManagedSources;
const before = await mod.discoverPackageExtensions(<agentDir>);   // 补丁前行为
globalThis.__piLazyManagedSources = new Set([...lazy 接管的包 source...]);
const after  = await mod.discoverPackageExtensions(<agentDir>);   // 面板真实情形
```

**要点**：
- `moduleCache: false` —— 否则两次调用拿到同一份缓存，A/B 无意义
- 断言的是**真实函数输出**，不是补丁文本 → 补丁打错分支时这里会**当场露馅**（本次就是这么抓到的）
- 对照基线：不设全局 → lazy 包全 `disabled`（复现报障）；设全局 → 9 个 `enabled`、`goal-x` 保持 `disabled`

### 8.3 状态行重复：查两个渲染点

```
顶部：persona-loader/index.ts:673  → 读 globalThis.__piLazyStatus
底部：pi-lazy/dist/index.js        → 曾调 ui.setStatus("pi-lazy", ...)
```

`grep -c 'setStatus("pi-lazy"' dist/index.js` → **0** 才算修好。

### 8.4 按需加载的模块：验证前必须完整重启

`src/packages/extensions.ts` 在**启动期零加载**（启动探针实测无输出），只在**开面板时**载入并缓存。所以：
- 在已开过面板的进程里打补丁 → **当前进程永远看不到新结果**
- 必须**退出 pi 重开**；`/reload` 不保证能踢掉已缓存的模块

### 8.5 `pi update` 之后：验证兼容补丁能自愈

用户常问："更新了插件管理，包又全变 disabled，那个参数管用吗？" —— **管用，但必须验证过才敢这么说**。

**做法**：从 dist 里按花括号配对抽出真实的 `ensureManagerCompat`，拿 **pristine 备份**当输入，看它能不能原样打回来。

```js
// 1) 抽函数（花括号配对，不是字符串截断）
const d = readFileSync(DIST, "utf-8");
const s = d.indexOf("function ensureManagerCompat(");
let i = d.indexOf("{", s), dep = 0, e = -1;
for (let j = i; j < d.length; j++) {
  if (d[j] === "{") dep++;
  else if (d[j] === "}") { dep--; if (dep === 0) { e = j + 1; break; } }
}
const mk = (log) => new Function("join","existsSync","readFileSync","writeFileSync","console",
  `${d.slice(s, e)}; return ensureManagerCompat;`)(join, existsSync, readFileSync, writeFileSync, log);

// 2) 搭假 agentDir：npm/node_modules/pi-extmgr/src/packages/extensions.ts = pristine
// 3) 跑：mk(log)(TMP, { config: { managerCompat: true } })
// 4) 断言：readFileSync(TARGET) === readFileSync(线上文件)   ← 逐字节
```

**⚠️ 坑（本次踩到）**：补丁文本是**以字符串字面量嵌在 dist 里**的，所以改线上文件时**必须同步改 dist 里的那几行字符串**，否则自动重打出来的文件会跟线上不一样（本次差 72 字节：注释少一行）。**每次改 5.1 的补丁，记得同步 P9 的嵌入副本，然后重跑本节套件。**

**5 个场景**（pristine / 幂等 / 开关关 / 锚点漂移 / 未安装）全绿才算这个参数"是最新的"。当前状态：**9/9 通过**。

### 8.6 `pi update` 之后：验证 pi-powerline-footer 补丁能自愈

同 8.5，只是目标换成 P11。**抽函数时不要用花括号配对** —— P11 的补丁文本里有大量 `{`/`}`（模板字面量、`${}`），配对会数错。**改用"下一个顶层 `function ` 之前"切片**：

```js
const d = readFileSync(DIST, "utf-8");
const s = d.indexOf("function ensureFooterCompat(agentDir, rt) {");
const e = d.indexOf("\nfunction ensureManagerCompat(agentDir, rt) {", s);
const fn = new Function("join","existsSync","readFileSync","writeFileSync","console",
  d.slice(s, e) + "\nreturn ensureFooterCompat;")(join, existsSync, readFileSync, writeFileSync, log);
```

然后搭假 agentDir（`npm/node_modules/pi-powerline-footer/{index.ts,welcome.ts}` = 两个 pristine 备份），跑 `fn(TMP, { config: { footerCompat: true } })`，断言两个文件与线上**逐字节一致**。

**5 个场景**（pristine / 幂等 / 开关关 / 锚点漂移 / 未安装）全绿才算 OK。当前状态：**7/7 通过**。

### 8.7 github MCP 的 CA 修法：怎么证明真的好了（别靠"看着好像能连"）

分三层，**由外到内**。三层全绿才算修好。

**第 1 层 · bundle 体检**（卡巴根/bili 根在不在，**按指纹**，别按字符串搜 —— PEM 正文是 base64，搜 subject 名字永远是 false）

```js
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
const blocks = readFileSync("E:/pi-agent/agent/certs/github-mcp-ca.pem", "utf8")
  .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
const fps = new Set(blocks.map(b => new X509Certificate(b).fingerprint256.replace(/:/g, "")));
for (const p of ["E:/pi-agent/agent/certs/kaspersky-mitm-root.pem",
                 "C:/Users/32203/.local/share/billion-context/ca/root-ca.pem"]) {
  const ref = new X509Certificate(readFileSync(p, "utf8"));
  console.log(p.split("/").pop(), fps.has(ref.fingerprint256.replace(/:/g, "")) ? "✓ 在包里" : "✗ 不在");
}
// 期望：卡巴 ✓ / bili ✓；块数 120，全部可解析，无重复，PEM 外无残留
```

**第 2 层 · 传输层 A/B**（不加 CA vs 加 CA，各 10 次）

裸 `https.Agent({ ca: readFileSync(BUNDLE) })` 打 MCP initialize POST：
- 不加 CA → **8/10 左右**（间歇失败，全是 `SELF_SIGNED_CERT_IN_CHAIN`）
- 加 CA → **10/10 HTTP 200**

**第 3 层 · 走适配器真实代码路径**（最重要 —— 前两层只证明"TLS 通了"，这层证明**适配器真的会用这个 caFile**）

```js
const require = createRequire("E:/pi-agent/agent/npm/node_modules/");
const { createJiti } = require("jiti");        // ⚠️ 临时目录里 import "jiti" 会 ERR_MODULE_NOT_FOUND
const jiti = createJiti(import.meta.url, { moduleCache: false });
const A = "E:/pi-agent/agent/npm/node_modules/pi-mcp-adapter";

const { loadMcpConfigWithSources, setPiMcpConfigEnabled } = await jiti.import(A + "/config.ts");
const { validateCaFile, createCaFetch } = await jiti.import(A + "/http-ca.ts");
const { interpolateEnvRecord } = await jiti.import(A + "/utils.ts");

setPiMcpConfigEnabled(true);   // ⚠️ 必须！模拟 pi 扩展启动时调用；否则适配器把 mcp.json 当老配置，报另一条告警
const cfg = loadMcpConfigWithSources().config;   // ⚠️ 必须不带 overridePath！传路径 = 把该路径当 mcp-adapter.json 直读（假阳性，最坑）
const gh = cfg.mcpServers.github;
console.assert(gh.caFile === "E:/pi-agent/agent/certs/github-mcp-ca.pem", "caFile 被加载器丢了");
console.assert(gh.headers?.Authorization === "Bearer ${GITHUB_PAT}", "headers 应从 mcp.json 继承（url 相同不剥离）");
validateCaFile(gh);                              // 不抛错 = 通过
const made = createCaFetch(gh);                  // 返回 { fetch, close }
// ⚠️ 加载出来的 headers 是未插值的 "Bearer ${GITHUB_PAT}" —— 适配器在 mcp-auth-fetch.ts:27
//    用 interpolateEnvRecord 插值。测试里必须自己插，否则 GitHub 回 400（不是 TLS 问题！）
const headers = interpolateEnvRecord(gh.headers);
// 用 made.fetch(gh.url, { method:"POST", headers, body: initialize }) 打 5 次
// 期望：5/5 HTTP 200，且响应带 mcp-session-id、正文含 "result"
```

**踩过的两个坑（别重犯）**
- 加载器读出来的 `headers` 是**未插值**的 `${GITHUB_PAT}` → 直接拿去请求会 **HTTP 400**。这不是 CA 没生效（TLS 已经不报错了），是测试少了一步插值。
- `NODE_EXTRA_CA_CERTS` 已指向 bili 的 `root-ca.pem` 且是**启动器注入**的 → 写用户级环境变量没用；而且它是**追加**语义，跟 `caFile` 的**替换**语义不同，两者不能互相替代。

**缓存自愈**：`mcp-cache.json` 里 github 那条 `discoveryFailed: true` 会在**首次成功发现**后被自动改写，不需要手工清。

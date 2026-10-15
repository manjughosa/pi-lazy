# pi-lazy (maintained continuation)

[![npm version](https://img.shields.io/npm/v/pi-lazy?logo=npm)](https://www.npmjs.com/package/pi-lazy)
[![fork status](https://img.shields.io/badge/maintained-continuation-brightgreen)](https://github.com/manjughosa/pi-lazy)
[![upstream last commit](https://img.shields.io/github/last-commit/Rahularya01/pi-lazy?label=upstream%20last%20commit)](https://github.com/Rahularya01/pi-lazy)
[![license](https://img.shields.io/npm/l/pi-lazy)](LICENSE)

**A LazyVim-style extension manager for [Pi Coding Agent](https://github.com/badlogic/pi-mono).**

> **This is not the original project.** pi-lazy was written by **Rahul Arya** and published as
> `@rahularya01/pi-lazy`. The maintainer of this repository is **not the original author** — this is
> a continuation, picking up a project whose upstream stopped at v0.3.1 (commit `fd4910a`,
> 2026-08-27) with a growing issue queue. Credit for the design and the original implementation
> belongs to Rahul Arya. See [Why a fork?](#why-a-fork) and [CHANGELOG.md](CHANGELOG.md) for what
> this continuation adds and how patches flow.

If you've used [LazyVim](https://www.lazyvim.org/), the idea will feel familiar: keep every
package installed, but only pay the startup cost for the ones you actually use right away.
Everything else loads the moment you reach for it — a slash command, a tool call, a keyword in
your prompt, a shortcut, or a manual `/lazy load`.

**The result:** a faster Pi startup, a shorter tool list for the model to reason about, and every
package still just one command or keyword away.

## Why a fork?

| | Upstream | This fork (`manjughosa/pi-lazy`) |
|---|---|---|
| Last commit | 2026-08-27 (over 2 months stale) | tracked, every release gets a CHANGELOG entry |
| Open issues answered | unmaintained | 11 patches, 2 issues filed, all addressed |
| Compatibility with `pi-extmgr` | breaks lazy semantics | `ensureManagerCompat` auto-patches on session_start |
| Compatibility with `pi-powerline-footer` | clobbers the status line twice | `ensureFooterCompat` auto-patches the fast-welcome path |
| Doctor / diagnostic | absent | `/lazy doctor` checks settings, lazy state, extmgr conflicts |
| `auto: true` default | yes (loaded eagerly on session start) | no (`auto: false`; opt-in per spec) |
| Typebox collision warning | yes (duplicate Host-provided instance) | peer-dependency only, no collision |
| Built-in default config | ships 5 ghost package entries | trimmed to the 5 that actually exist |

### Maintenance policy

- **Patches flow in from local use** — this fork exists because the maintainer (you) uses it
  daily. Every behavior change is made in `src/` and rebuilt with `npm run build`; the resulting
  `dist/index.js` is committed, and shows up in `CHANGELOG.md` under the next minor version.
- **One working tree** — the live extension *is* this repository
  (`E:/pi-agent/agent/extensions/pi-lazy`). `src/`, `dist/`, and the git history live side by side,
  so a change and its commit are never two steps apart. This repo previously had to be kept in sync
  with a separate `pi-lazy-fork/` copy; that duplicate is gone.
- **Backports from upstream** — if the original `@rahularya01/pi-lazy` repo gets a new commit,
  it's cherry-picked into the next `0.5.x` patch release.
- **Releases are tagged** — every release is a signed `vX.Y.Z` git tag on `main`; install via
  `git:github.com/manjughosa/pi-lazy` if you want pin-to-version behavior, or stay on the local
  `dist/index.js` for zero-network startup (recommended for performance — see [Install](#install)).
- **No silent breaking changes** — see the [CHANGELOG](CHANGELOG.md). Every release notes which
  upstream version it forked from and what was added/changed/fixed.

### Install paths and their trade-offs

| `source` in `settings.json` | Network on every Pi start? | Recommended? |
|---|---|---|
| `E:/pi-agent/agent/extensions/pi-lazy` (local dist) | **No** | **Yes — fastest** |
| `git:github.com/manjughosa/pi-lazy` | Yes (`git fetch` + checkout) | only when you need pin-to-version |
| `npm:@rahularya01/pi-lazy` | Yes (npm registry) | No — that is the stale upstream |
| `npm:@manjughosa/pi-lazy` | Yes (npm registry) | only after the fork is republished under a new name |

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [First-time setup](#first-time-setup-required-for-true-lazy-loading)
- [Quick start](#quick-start)
- [Mental model (LazyVim → Pi)](#mental-model-lazyvim--pi)
- [Load strategies](#load-strategies)
- [Configuration](#configuration)
- [Commands](#commands)
- [LLM tool: `lazy_load`](#llm-tool-lazy_load)
- [How load works](#how-load-works)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)
- [Limits (v1)](#limits-v1)
- [Development](#development)
- [Publish](#publish)

## Requirements

- [Pi Coding Agent](https://pi.dev) **0.80+** (peer: `@earendil-works/pi-coding-agent`)
- Node.js **20+**
- Packages you want to defer must already be installed via `pi install` / `settings.packages`

## Install

Pick the path that matches your performance budget (see [Install paths and their trade-offs](#install-paths-and-their-trade-offs)):

```bash
# local checkout — zero network, fastest startup (recommended)
pi install /absolute/path/to/pi-lazy

# pin-to-version via this fork's git tag
pi install git:github.com/manjughosa/pi-lazy

# upstream npm (stale — use the fork instead)
pi install npm:@rahularya01/pi-lazy
```

Or add it directly to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@rahularya01/pi-lazy"]
}
```

Then restart Pi (or run `/reload`).

> **Note:** pi-lazy itself is always-on — it has to load at startup so it can manage everything
> else.

Update it later with:

```bash
pi update npm:@rahularya01/pi-lazy
```

## First-time setup (required for true lazy loading)

Installing pi-lazy alone isn't enough — Pi still eager-loads every package listed as a plain
string in `settings.packages`. You need to **migrate once, then restart**. It's a three-step
process:

### 1. Install pi-lazy and restart

```bash
pi install npm:@rahularya01/pi-lazy
```

Restart Pi or run `/reload`.

### 2. Seed and review your config

On first run, pi-lazy writes a default catalog to `~/.pi/agent/lazy.json`.

Edit that file to match **your** installed packages — see [Configuration](#configuration) below.

To have the catalog pick up packages automatically, run:

```text
/lazy init
```

`init` **merges**: every spec already in `lazy.json` is kept exactly as written, and only packages
listed in `settings.json` that the catalog does not yet cover gain a new entry. It never replaces
your file with the built-in defaults. `init` then runs `/lazy migrate` for you, so the merged
catalog is actually applied in the same step.

To only merge, without touching `settings.json`, use `/lazy scan`.

Newly discovered packages are added as `lazy: false` (**eager**) with a `keywords` entry derived from
the package name, and local extensions under `extensions/` are registered the same way. Discovery
records what is installed; it does not decide when anything loads. Set `lazy: true` or `after-start`
by hand to defer a package.

Only list packages you actually have installed — specs for missing packages will show up as
errors when you try to load them.

### 3. Migrate your settings

If you ran `/lazy init` in step 2, this is already done — `init` performs the merge **and** this
step. Run `/lazy migrate` on its own only when you changed `lazy.json` by hand.

```text
/lazy migrate
```

This command:

1. Backs up `~/.pi/agent/settings.json` to `settings.json.bak.lazy-<timestamp>`
2. Rewrites managed (`lazy !== false`) packages from a plain string:

   ```json
   "npm:pi-web-access"
   ```

   into an object with an empty extension filter:

   ```json
   { "source": "npm:pi-web-access", "extensions": [] }
   ```

The package stays installed — its skills and prompts can still load — but Pi will **not** execute
its extension factory at startup. pi-lazy takes over and loads that factory later, on your terms.

Eager specs (`"lazy": false`) that were previously filtered empty are restored to plain string
form automatically when it's safe to do so.

### 4. Restart Pi again

Module-lazy filters only apply on the *next* process start, so restart one more time. After that,
running:

```text
/lazy
```

should show your managed on-demand packages as `pending`, not `eager`. The statusline will show
something like `lazy 0↑ 4· 3⚡`.

> If you skip the migrate step, packages stay eager — Pi loads them normally, and `/lazy load`
> will just tell you to migrate and restart.

## Quick start

```text
/lazy                  # status + table
/lazy list             # compact states
/lazy load web         # force-load a pending package
/web                   # stub command: loads "web", then re-runs /web
```

A typical setup after migrating looks like this:

1. **Providers** (`cursor`, `antigravity`, …) stay `"lazy": false` → available immediately.
2. **Common helpers** (`subagents`, `todo`, …) use `"lazy": "after-start"` → load right after the
   UI is up.
3. **Heavy packs** (`web`, `mcp`, `lens`, …) use `"lazy": true` → load on first `/cmd`, tool stub,
   keyword match, or `/lazy load`.

## Mental model (LazyVim → Pi)

Already know LazyVim? Here's the direct translation:

| LazyVim | pi-lazy |
| -------- | --------- |
| `lazy = false` | `"lazy": false` |
| `event = "VeryLazy"` | `"lazy": "after-start"` |
| `cmd = "Telescope"` | `"cmd": ["plannotator"]` |
| keys | `"keys": ["ctrl+…"]` |
| first tool use | `"tools": ["web_search"]` |
| prompt / autocmd triggers | `"keywords"` / `"event"` |
| `:Lazy load foo` | `/lazy load foo` |
| `:Lazy` | `/lazy` / `/lazy list` |

## Load strategies

Every package spec picks one of three strategies via its `lazy` field:

| `lazy` value | When it loads | Good for |
| ------------ | ------------- | -------- |
| `false` | With Pi at startup (not managed by pi-lazy) | Providers, auth, anything you need before the first prompt |
| `"after-start"` | Shortly after `session_start` (priority order, lower first) | Common tools you almost always use, but not boot-critical |
| `true` | On demand only | Heavy / situational packs (web, MCP, lens, plan mode) |

### On-demand triggers (`lazy: true`)

Any of the following can wake up a pending package:

| Trigger | How |
| ------- | --- |
| Manual | `/lazy load <name>` or LLM tool `lazy_load` |
| Slash command stub | Spec `"cmd": ["web"]` → `/web` loads then re-dispatches `/web …` |
| Tool stub | Spec `"tools": ["web_search"]` → first call loads the package; call the real tool on the next turn |
| Keywords | Spec `"keywords": ["web search"]` → matched (case-insensitive) in the user prompt on `before_agent_start` |
| Events | Spec `"event": ["before_agent_start"]` → load whenever that Pi event fires (when auto is on) |
| Shortcuts | Spec `"keys": ["…"]` → registered shortcut loads the package |

Keyword and event auto-load can be toggled on or off:

```text
/lazy auto off
/lazy auto on
```

It's **on** by default (`"auto": true` in `lazy.json`).

### Dependencies

Packages can depend on each other:

```json
{
  "name": "my-pack",
  "source": "npm:my-pack",
  "lazy": true,
  "dependencies": ["context-mode"]
}
```

`/lazy load my-pack` loads `context-mode` first. If a dependency fails, the parent load fails with
a clear error. Dependency cycles are rejected with the complete cycle path, and concurrent
requests for the same package share a single load.

## Configuration

Everything lives in one file: **`~/.pi/agent/lazy.json`**

- Auto-created on first run from built-in defaults
- Merge new packages from `settings.json` with `/lazy init` (or `/lazy scan` for the catalog only) — existing specs are never overwritten
- Show its path anytime with `/lazy config`

Here's a full example (also in [`examples/lazy.json`](./examples/lazy.json)):

```json
{
  "version": 1,
  "defaults": { "lazy": true },
  "auto": true,
  "autoLoadLimit": 1,
  "afterStartBatchSize": 1,
  "afterStartDelayMs": 0,
  "afterStartInitialDelayMs": 750,
  "afterStartPauseDuringTurn": true,
  "afterStartAdaptiveYield": true,
  "afterStartPrefetch": true,
  "specs": [
    {
      "name": "cursor",
      "source": "npm:@rahularya01/pi-cursor",
      "lazy": false,
      "description": "Cursor provider — must be eager"
    },
    {
      "name": "subagents",
      "source": "npm:pi-subagents",
      "lazy": "after-start",
      "priority": 10,
      "description": "Load after UI is ready"
    },
    {
      "name": "web",
      "source": "npm:pi-web-access",
      "lazy": true,
      "cmd": ["web"],
      "tools": ["web_search", "fetch_content", "get_search_content"],
      "keywords": ["web search", "search the web", "fetch url", "youtube"],
      "description": "On-demand web / fetch / video"
    },
    {
      "name": "lens",
      "source": "npm:pi-lens",
      "lazy": true,
      "cmd": ["lens"],
      "tools": ["lens_diagnostics", "symbol_search", "module_report", "lsp_diagnostics"],
      "keywords": ["diagnostics", "symbol search", "ast-grep", "lsp"]
    }
  ]
}
```

### Top-level fields

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `version` | `1` | Config schema version |
| `defaults.lazy` | `false` \| `true` \| `"after-start"` | Default when a spec omits `lazy` (default: `true`) |
| `auto` | boolean | Enable keyword/event auto-load (default: `true`) |
| `autoLoadLimit` | integer | Maximum packages loaded before one agent turn (default: `1`) |
| `afterStartBatchSize` | integer | Packages loaded in one after-start event-loop slice (default: `1`) |
| `afterStartDelayMs` | integer | Minimum delay between after-start slices in milliseconds (default: `0`) |
| `afterStartInitialDelayMs` | integer | Delay before the after-start queue starts, in milliseconds (default: `750`) |
| `afterStartPauseDuringTurn` | boolean | Hold the after-start queue while the agent is working (default: `true`) |
| `afterStartAdaptiveYield` | boolean | Yield at least as long as the previous slice blocked the event loop, capped at 250 ms (default: `true`) |
| `afterStartPrefetch` | boolean | Import the next slice's modules while the current one activates (default: `true`) |
| `specs` | array | Package load catalog |

### Keeping startup smooth

Loading an extension is mostly synchronous work — transforming TypeScript and
evaluating a module graph — so it blocks the event loop for as long as it takes,
no matter how the queue is sliced. pi-lazy therefore concentrates on *when* that
work happens rather than trying to make it cheaper:

- **It doesn't start immediately.** `afterStartInitialDelayMs` keeps the queue
  clear of Pi's first paint and of your first keystrokes.
- **It stops while you're working.** With `afterStartPauseDuringTurn`, the queue
  parks at `before_agent_start` and resumes at `agent_end` / `agent_settled`, so
  it never competes with streaming output.
- **It gives time back.** `afterStartAdaptiveYield` sleeps for as long as the
  previous slice ran (up to 250 ms), so heavy packages yield more than light ones.
- **It overlaps what it can.** `afterStartPrefetch` imports the next slice's
  modules while the current one activates. Factory execution stays strictly
  serial and in `priority` order.

If startup still feels slow, the fix is usually the catalog rather than these
knobs: run `/lazy profile` to see per-package load times, then move the expensive
packages from `"after-start"` to `true` and give them `cmd` / `tools` / `keywords`
triggers so they load on first real use instead.

### Spec fields

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `name` | yes | Stable id for `/lazy load` and status tables |
| `source` | yes | Same form as `settings.packages`: `npm:…`, local path, `git:…`, etc. |
| `lazy` | no | Load mode (see [Load strategies](#load-strategies)); falls back to `defaults.lazy` |
| `priority` | no | `after-start` order — **lower runs first** (default `100`) |
| `cmd` | no | Slash-command names to stub (load-then-re-run) |
| `tools` | no | Tool names to register as load-on-call stubs |
| `keys` | no | Keyboard shortcuts that load this package |
| `event` | no | Pi event names that trigger load (e.g. `"before_agent_start"`) |
| `keywords` | no | Case-insensitive prompt substrings checked on `before_agent_start` |
| `dependencies` | no | Other **spec names** to load first |
| `description` | no | Human-readable note (shown in your own docs; not required at runtime) |

### Local extensions under `extensions/`

Extensions living in `<agent-dir>/extensions/<name>/` are not packages. Pi finds them by walking that
directory and loads whatever each folder's manifest declares, so there is no `settings.packages`
entry and no `extensions` filter — which means this extension cannot defer them at all. A spec alone
would be inert.

`/lazy init` and `/lazy scan` therefore register each discovered directory **as a package** (a spec
plus a `settings.packages` entry), which is the only form that carries a filter and can be deferred.
The package is added **eager**, matching how Pi was already loading it: discovery must not silently
change load timing. Set `lazy: true` or `after-start` on the spec afterwards to actually defer it.

Folders without a usable manifest are skipped rather than guessed at.

> Keep pi-lazy itself eager (`lazy: false`). It is the thing that defers everything else, so
deferring it makes it absent from the session, its filters never get applied, and every package it
manages stops loading.

### Choosing what stays eager

Keep **`lazy: false`** for:

- Model providers / auth bridges (`pi-cursor`, `pi-antigravity`, `pi-grok-cli`, …)
- Anything you need before the first agent turn
- Packages whose absence would break your default workflow

Prefer **`after-start`** for packs you use most sessions but that aren't boot-critical.

Prefer **`true` (on-demand)** for large MCP bridges, web fetch, lens/LSP, plan mode, and other
situational tools.

### Matching `source` to installed packages

`source` must match how the package appears in Pi:

| Install | Spec `source` |
| ------- | ------------- |
| `pi install npm:pi-web-access` | `"npm:pi-web-access"` |
| `pi install npm:@rahularya01/pi-cursor` | `"npm:@rahularya01/pi-cursor"` |
| Local path | Absolute or cwd-relative path to the package root |

pi-lazy resolves npm packages from, in order:

1. `~/.pi/agent/npm/node_modules/<name>`
2. `<cwd>/.pi/npm/node_modules/<name>`

If the package isn't installed in either location, the load fails with "package not installed".

### Stub names must be declared

Command and tool stubs **only** exist for names listed in the spec. If `pi-web-access` registers
`web_search` but your spec omits it from `"tools"`, the model won't see a lazy stub for that tool
until the package is loaded some other way (keyword, `/lazy load`, etc.).

So declare the commands and tools you actually want to trigger a load:

```json
{
  "name": "web",
  "source": "npm:pi-web-access",
  "lazy": true,
  "cmd": ["web"],
  "tools": ["web_search", "fetch_content", "get_search_content"]
}
```

## Commands

| Command | Action |
| ------- | ------ |
| `/lazy` or `/lazy status` | Status summary + full table (state, mode, source, timings) |
| `/lazy list` | Compact one-line-per-spec table |
| `/lazy load <name>` | Force-load a pending package (name, or unique source suffix) |
| `/lazy migrate` | Apply `extensions: []` filters + backup `settings.json` |
| `/lazy auto` | Show whether keyword/event auto-load is on |
| `/lazy auto on\|off` | Toggle auto-load and persist to `lazy.json` |
| `/lazy init` | Scan `settings.json` for packages the catalog misses, add them, then run `/lazy migrate` |
| `/lazy scan` (alias `s`) | Same catalog merge as `init`, **without** the migrate step |
| `/lazy disable <name>` | Remove a package from the loading scheme (catalog spec + settings entry), then migrate. Leaves `node_modules` alone |
| `/lazy enable <name>` | Restore a package disabled earlier (spec + settings entry from the newest `*.bak.disable-*` snapshot), then migrate |
| `/lazy disable` / `/lazy enable` | List the full package roster recorded by the last `/lazy init` |
| `/lazy rescue` | Hand every package back to native Pi: clear `extensions` filters and empty the catalog |
| `/lazy snapshot <name>` | Save the whole loading scheme under a name |
| `/lazy snapshot` | List saved snapshots (name, spec/package counts, saved-at) |
| `/lazy snapshot delete <name>` | Delete one saved snapshot |
| `/lazy restore <name>` | **Replace** the current scheme with a saved snapshot, then migrate |
| `/lazy doctor` | Diagnose catalog vs settings vs runtime inconsistencies (invalid lazy values, duplicates, un-migrated entries, poisoned loads) |
| `/lazy config` | Print the absolute path to `lazy.json` |
| `/lazy profile` | Show in-session catalog, resolution, and load timings |

Tab completion is available for subcommands and `load <name>`.

### Statusline

pi-lazy sets a UI status string like:

```text
lazy 2↑ 3· 4⚡
```

| Glyph | Meaning |
| ----- | ------- |
| `↑` | Loaded this session (via lazy) |
| `·` | Pending (module-lazy ready, not yet loaded) |
| `⚡` | Eager (Pi loaded, or not migrated yet) |
| `✗` | Error on last load attempt |

### List columns

```text
pending  web              on-demand    npm:pi-web-access
loaded   subagents        after-start  npm:pi-subagents 42ms
eager    cursor           eager        npm:@rahularya01/pi-cursor
eager    lens             on-demand    npm:pi-lens (migrate+restart needed)
error    mcp              on-demand    npm:pi-mcp-adapter — package not installed …
```

| State | Meaning |
| ----- | ------- |
| `eager` | Not managed, or still fully eager in settings (migrate + restart if you expected pending) |
| `pending` | Filtered with `extensions: []`; waiting for a trigger |
| `loading` | Load in progress |
| `loaded` | Factory ran successfully this session |
| `error` | Last load failed before activation (message in the row; retry is allowed) |
| `poisoned` | A factory failed after activation began; restart before retrying |

## LLM tool: `lazy_load`

The model itself can load a deferred package by spec name:

```text
lazy_load({ name: "web" })
```

Use it when a capability is still pending (`web`, `mcp`, `lens`, `plannotator`, `context-mode`,
…). Prefer names from `/lazy list`.

After a successful load, newly registered tools are merged into the active tool set when the
runtime supports `getActiveTools` / `setActiveTools`. Stub tools still tell the model to **call
the real tool again on the next turn** after the first activation.

## How load works

When a trigger fires, pi-lazy runs through these steps:

1. Resolve the package under Pi's npm (or local) install tree
2. Read `package.json` → `pi.extensions` (same rules as Pi's own loader)
3. Import the factory (`import()` for JS; **jiti** for TypeScript — from the Pi install)
4. Call `factory(hostPi)` so tools, commands, and handlers attach to the **live** runtime
5. Replay `session_start` (and best-effort `resources_discover`) handlers registered during that
   late load
6. Additively `setActiveTools` for any tools registered during the load

Dependencies are loaded depth-first before the requested package.

## Recipes

### Faster startup with a heavy stack

1. Put providers on `"lazy": false`
2. Put always-useful orchestration on `"lazy": "after-start"` with priorities `10`, `20`, …
3. Put web / MCP / lens / plan on `"lazy": true` with `cmd` + `tools` + a few `keywords`
4. `/lazy migrate` → restart → confirm with `/lazy list`

### Force-load before a big task

```text
/lazy load lens
/lazy load context-mode
```

Or ask the agent to call `lazy_load` for those names.

### Temporarily disable keyword auto-load

```text
/lazy auto off
```

Manual `/lazy load` and stub `/cmd` / tools still work. Turn it back on with `/lazy auto on`.

### Add a new package later

1. `pi install npm:some-package`
2. `/lazy init` — adds the spec for you, then migrates
   (or add the spec to `~/.pi/agent/lazy.json` by hand and run `/lazy migrate`)
3. Restart Pi
4. `/lazy load some-name` or use its stubs

Changes to package specs, stubs, shortcuts, or event triggers take effect after `/reload` or a
process restart. `/lazy auto on|off` is the only configuration change applied immediately.

### Switch between whole plugin setups

A **snapshot** is the entire loading scheme — the catalog, its global switches, and the
`settings.json` package list with each entry's `extensions` filter form intact. Storing only
`lazy.json` cannot reproduce a scheme: the `packages` array is what Pi registers, and the filter
form there (`[]` = module-lazy, `["+index.ts"]` = force one entrypoint, absent = eager) decides
eager-vs-lazy behaviour no amount of spec editing can reproduce.

```
/lazy snapshot work      # save the current scheme
/lazy snapshot           # list what is saved
/lazy restore work       # switch to it
```

Snapshots live in `~/.pi/agent/lazy-snapshots/<name>.json`.

`restore` is a **replacement, not a merge**. Restoring a scheme that uses `5,6,7,8` over one using
`1,2,3,4` ends with exactly `5,6,7,8` — `1,2,3,4` are dropped from both `lazy.json` and
`settings.packages`. This happens in three steps, and the first is the one that matters:

1. `settings.packages` ← the snapshot's captured list (this is what unregisters `1,2,3,4`)
2. `lazy.json` ← the snapshot's catalog
3. `/lazy migrate` ← turns the snapshot's `lazy` modes into `extensions: []`

Skip step 1 and the old packages stay registered and keep loading, which is why a
catalog-only implementation produced `1,2,3,4,5,6,7,8` instead of `5,6,7,8`.

Packages a snapshot does not mention are **reported, never deleted from disk**. Bring any of them
back with `pi install npm:<name>`. Both files are backed up (`*.bak.restore-<stamp>`) before the
first write.

### Drop a package from the scheme

```
/lazy disable <name>     # alias: d
```

Removes the spec from `lazy.json` and the entry from `settings.packages`, then runs `/lazy migrate`.
Named `disable` rather than remove/uninstall because `extensions: []` does not uninstall anything:
Pi's package manager defaults every entry to enabled and applies `+`/`-` overrides on top, so an
empty filter list just yields no enabled files while the package stays in `node_modules`.

This is not a fourth `lazy` mode. The three modes decide *when* a catalog member loads; disabling
decides whether it is a member at all. Both halves must go — a spec whose source is no longer
registered is inert, and deleting only the spec would leave it listed as a permanently failing
entry.

The trailing migrate reports `nothing to change` for the disabled package itself — it is out of
both files, so there is nothing left to translate — and confirms the rest of the catalog did not
drift.

Nothing is reloaded automatically. A loaded extension factory has no inverse operation (its tools,
commands and handlers are already registered), so run Pi's own `/reload` when you want the change
to take effect.

### Put a package back

```
/lazy enable <name>      # alias: en
```

The mirror image of `disable`: the spec and the settings entry are restored from the most recent
`*.bak.disable-*` snapshot that still contains them, so the original `lazy` / `after-start` / `eager`
mode comes back with it. A migrate runs afterwards to translate that mode back into `extensions: []`
— without it the restored entry would be registered but eager, which is exactly the drift the
two-file design invites.

`node_modules` is untouched in either direction: `pi install npm:<name>` remains the way to add or
remove the package itself.

Both verbs accept any package and report the state they find rather than failing:

| Request | Reply |
|---|---|
| `disable` on an already-disabled package | `already out of the loading scheme, nothing to do` |
| `enable` on an already-enabled package | `already in the loading scheme [mode], nothing to do` |

Running either bare (`/lazy enable`, `/lazy disable`) lists the full roster recorded by the last
`/lazy init`, so the packages offered while typing are the same set the commands accept.

### Undo migrate for one package

Edit `settings.json`: change that entry back to a plain string source (or remove
`"extensions": []`), keep `"lazy": false` in `lazy.json`, then restart. Or restore from the
`settings.json.bak.lazy-*` backup.

## Troubleshooting

| Symptom | What to do |
| ------- | ---------- |
| Everything still `eager` after install | Run `/lazy migrate`, then **fully restart** Pi (not only `/reload` if filters were just written) |
| `/lazy load X` → "not module-lazy ready" | Migrate + restart; the package is still a plain string in `settings.packages` |
| `/lazy load X` → "package not installed" | `pi install` that source; confirm it exists under `~/.pi/agent/npm/node_modules/…` |
| `/lazy load X` → "unknown spec" | Add it to `lazy.json` (`name` + `source`); `/lazy list` shows known names |
| Stub `/web` does nothing useful | Ensure `"cmd": ["web"]` on the spec, package is `pending`, and migrate was applied |
| Model never sees stub tools | List them under `"tools"`; after first stub call, have it invoke the real tool next turn |
| Keywords never fire | `/lazy auto on`; keywords are case-insensitive **substrings** of the user prompt |
| TS extension fails to import | Pi (or its deps) must provide **jiti**; JS/`dist` packages load via native `import` |
| Broken settings after migrate | Restore `~/.pi/agent/settings.json.bak.lazy-<timestamp>` |
| Want a clean slate mid-session | No unload in v1 — use `/reload` or restart Pi |

Startup tip: if managed packages aren't module-lazy yet, pi-lazy notifies you once:

```text
pi-lazy: run /lazy migrate then restart for true module-lazy
```

## Limits (v1)

- **No mid-session unload** — loaded factories stay until `/reload` / process restart
- A factory that fails after registering runtime state is marked **poisoned** and cannot be
  retried until restart
- **Boot-critical packages** should stay `"lazy": false`
- **Stub `cmd` / `tools` names must be declared** in the spec
- **Skills / prompts** stay eager by default — only **extensions** are deferred via
  `extensions: []`
- **Git-sourced packages** are not fully resolved in v1 unless you point `source` at a local path
- Without migrate, managed specs remain eager and on-demand load asks you to migrate

## Development

> **Node 22+ required for the test suite** — the `@earendil-works/pi-coding-agent` dev dependency
> bundles an `undici` version that needs Node ≥22.19. The published package itself still supports
> Node 20+ at runtime; only running `npm test` locally needs the newer Node.

```bash
git clone https://github.com/Rahularya01/pi-lazy
cd pi-lazy
npm install
npm test
npm run test:smoke

# run an isolated startup benchmark; never modifies ~/.pi/agent
BENCH_RUNS=3 node scripts/bench-startup.mjs

# load from local path
pi install "$PWD"
```

Layout:

| Path | Role |
| ---- | ---- |
| `src/index.ts` | Extension entry — commands, stubs, events, `lazy_load`, profiling |
| `src/config.ts` | `lazy.json` load/save + default catalog |
| `src/migrate.ts` | `settings.packages` → `extensions: []` |
| `src/resolve.ts` | Package root + extension entry resolution |
| `src/loader.ts` | Dynamic import / cached jiti setup + factory invoke |
| `dist/index.js` | Compiled production extension entry |
| `src/types.ts` | Spec / config types |
| `test/unit.test.ts` | Hermetic loader, lifecycle, migration, and validation regression tests |
| `examples/lazy.json` | Example catalog |

## Publish

### This fork (manjughosa/pi-lazy)

Release flow used for 0.4.0 and onwards:

1. Bump `version` in `package.json` to `X.Y.Z`, mirror that in a new `## [X.Y.Z] — YYYY-MM-DD`
   section in `CHANGELOG.md` (with a "Diff vs upstream" table when it is a fork release).
2. Commit on `main` with a message like `release X.Y.Z (fork)`.
3. Tag must match `package.json` exactly: `git tag -a vX.Y.Z -m "..."`.
4. Push: `git push origin main --tags`.

GitHub Actions will:
- Run `npm run typecheck` + `npm test` + `npm run build`.
- Build a tarball and verify its content.
- Publish to **npm under `@manjughosa/pi-lazy`** (the new name) — this requires
  `NPM_TOKEN_FOR_MANJUGHOSA` in repo secrets, separate from the upstream token.

> The upstream `@rahularya01/pi-lazy` npm package is **not** touched. If you want to keep using
> the upstream name, fork the publish workflow and point it at your own npm scope.

### Backporting from upstream

When `@rahularya01/pi-lazy` gets a new commit:
1. `git remote add upstream git@github.com:Rahularya01/pi-lazy.git` (one-time).
2. `git fetch upstream`.
3. Identify the upstream commit range since `fd4910a` (the fork base).
4. Cherry-pick onto `main`, run `npm test`, then patch-release as `0.5.x`.

### Manual publish (fallback for any of the above)

```bash
npm login
npm publish --access public
```

Then reinstall in Pi:

```bash
pi install /absolute/path/to/pi-lazy   # or npm:@manjughosa/pi-lazy once published
```

### Required CI secret
- `NPM_TOKEN_FOR_MANJUGHOSA` — npm automation/granular access token with publish rights
  for `@manjughosa` (the original `NPM_TOKEN` for `@rahularya01` is irrelevant to this fork).

## License

[MIT](LICENSE)

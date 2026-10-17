# AGENTS.md

## Project Overview

ecij (Extract CSS-in-JS) is a zero-runtime CSS-in-JS plugin for Rolldown and Vite. It statically extracts `css` tagged template literals into separate CSS files at build time.

## Setup

```sh
npm ci
```

Node 24+ is required.

## Commands

| Task         | Command                   |
| ------------ | ------------------------- |
| Build        | `node --run build`        |
| Type check   | `node --run typecheck`    |
| Format check | `node --run format:check` |
| Format (fix) | `node --run format`       |
| Lint         | `node --run lint`         |
| Lint (fix)   | `node --run lint:fix`     |
| Test         | `node --run test`         |

**Before pushing**, merge the target branch into your branch to ensure you're working with up-to-date code, conflicts are caught early, and reviewers see accurate diffs.

**Before committing**, you must format the code, then run all checks and fix any failures:

```sh
node --run format
node --run lint
node --run typecheck
node --run build
node --run test
```

CI runs on both Ubuntu and Windows, so ensure changes are cross-platform compatible, especially path handling.

## Architecture

### Entry Points

- `index.js` / `index.d.ts` — Runtime export (`ecij` package). Exports a `css` tagged template function that provides types for editor support but throws at runtime — if the plugin is misconfigured or cannot statically extract a `css` call, the throw ensures broken styles fail loudly rather than silently shipping broken code. Both files must be listed in the `package.json` `files` field: the plugin leaves the `ecij` import in place, so bundlers still resolve `index.js`. After the build, a CI step checks with jq that `npm pack` includes every file referenced by `exports`.
- `src/index.ts` → `dist/index.js` / `dist/index.d.ts` — Plugin export (`ecij/plugin`). The Rolldown/Vite plugin that performs static CSS extraction. This single file contains the entire plugin implementation.

### Plugin Pipeline

The plugin implements three Rolldown lifecycle hooks:

1. **`transform`** — Parses source files with `parseSync` (oxc-parser), identifies `css` tagged template literals whose tag is a named import from `ecij` (respecting lexical shadowing), resolves their interpolations from literals, lexically scoped `const` bindings (`let`/`var` bindings and parameters only shadow), and named imports, extracts their CSS content, replaces them with generated class names, and injects a side-effect import for the virtual CSS module. The hook's `code` filter skips files that do not reference `ecij` before the handler runs. Edits are applied through `RolldownMagicString`: when Rolldown provides an instance via the hook's `meta` argument, it is mutated and returned directly so Rolldown generates the sourcemap natively; otherwise the hook returns the transformed code with a generated sourcemap. Only plain Rolldown builds provide one — Vite rebuilds `meta` to add its `ssr` flag, which drops Rolldown's lazily created `magicString` — so every Vite build and dev server goes through the fallback. Class names are emitted as **IIFEs** (`(() => "css-…")()`), not literals — `optimization.inlineConst` inlines string and template literal constants into their importers, which leaves the declaring module without a used export and gets it dropped along with its stylesheet under `sideEffects: false`. Rolldown's constant evaluation does not see through function calls, so the binding survives tree-shaking; Rolldown still treats the IIFE as side-effect-free, and minifiers (Oxc, esbuild, and terser) fold it back to a plain string. Do not annotate it with `@__PURE__` (terser does not inline annotated IIFEs), and do not simplify it without re-running the `inlineConst` tests. The comment above the replacement in `src/index.ts` links the upstream issues to revisit.
2. **`resolveId`** — Claims the virtual CSS module IDs, like `Button.tsx.<hash>.css`, which look like file paths but do not exist on disk.
3. **`load`** — Returns the extracted CSS content for virtual CSS module IDs.

`resolveId` and `load` filter on the generated ID pattern (`STYLESHEET_ID_REGEX`), so their handlers never run for other modules.

When the CSS interpolates values imported from another module, `transform` reads them from that module's parse, which `parseFile` caches. `const` initializers are resolved on demand, following the imports of their module, and cached for one transform only: the dev server keeps the parse of a module across edits to the modules it imports, so a longer-lived cache would go stale. It also waits for `this.load()` of that module, whose own transform registers its stylesheet, and imports that stylesheet first to keep the cascade order. Modules that interpolate each other's class names would wait for each other forever, so it skips loading a module whose transform is already waiting for the current one (`isWaitingFor`), whose stylesheet is not registered yet. Vite's dev server does not transform modules loaded through `this.load()`, so there a stylesheet is only imported once its module has been transformed. Do not work around this: the order only decides specificity ties, the README does not promise it, and Vite does not keep CSS in the same order between dev and builds either.

The caches are cleared in `buildEnd`, which the dev server only calls when it closes. There, `watchChange` forgets the parse of an edited module and the stylesheets that change with it, and the Vite-only `hotUpdate` hook adds the modules whose CSS depends on it to the update, as Vite would otherwise reuse their transforms and only update their imports. `transform` records these dependencies in `dependentsPerFile` as it resolves imported values.

## Package Metadata

`package.json` doubles as the plugin's entry in the [Vite Plugin Registry](https://registry.vite.dev/), which harvests it from npm. Keep these fields accurate:

- **`keywords`** — `vite-plugin` and `rolldown-plugin` are how the registry discovers the package; removing either delists it. The registry's search box substring-matches `name`, `description`, and `keywords`, so `description` and `keywords` both double as discoverability surface.
- **`peerDependencies`** — the declared `vite` and `rolldown` ranges become the compatibility matrix shown on the plugin card, and back the registry badges in `README.md`. Bumping a peer range changes what users see there.
- **`compatiblePackages`** — declares what peer dependencies cannot. There is no `rollup` peer dependency, so the registry would infer "unknown" and warn on the card; the explicit `incompatible` entry states the real reason instead (`src/index.ts` imports `RolldownMagicString`, `rolldown/filter`, and `rolldown/utils`). Tools listed here override the peer-dependency inference, so do not restate `vite`/`rolldown` — that would just create a second place to bump.

## Code Style and Practices

- **Formatter**: oxfmt. Configuration is in `.oxfmtrc.json`.
- **Linter**: oxlint. Configuration is in `.oxlintrc.json`. Type-aware rules are enabled with `oxlint-tsgolint`.
- **TypeScript**: Strict mode is enabled. Use `import type` for type-only imports. See `tsconfig.base.json` for the shared compiler configuration.
- **Naming**: camelCase for variables/functions, PascalCase for interfaces, SCREAMING_SNAKE_CASE for module-level constants.
- **Module format**: ESM only.
- **Documentation**: Keep `README.md` and `AGENTS.md` in sync with the codebase.

## Testing

Tests use **Vitest** with inline snapshots. Test files are in `test/` and fixtures in `test/fixtures/`.

The test suite (`test/plugin.test.ts`) runs integration tests by invoking a Vite build with the ecij plugin and asserting on the JS and CSS output using `toMatchInlineSnapshot()`. One test runs a plain Rolldown build instead, as it is the only way to cover the native `meta.magicString` path; Rolldown no longer bundles CSS, so that test stands in for a CSS plugin. Another sends requests to a Vite dev server, which loads modules differently from builds, and edits copies of its fixtures for the server's file watcher to pick up.

If your changes alter the build output, tests will fail with snapshot mismatches. Review the diff to confirm it matches your intent, then update snapshots with:

```sh
node --run test -- -u
```

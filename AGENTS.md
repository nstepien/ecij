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

CI runs on both Ubuntu and Windows, so ensure changes are cross-platform compatible (e.g., path handling).

## Architecture

### Entry Points

- `index.js` / `index.d.ts` — Runtime export (`ecij` package). Exports a `css` tagged template function that provides types for editor support but throws at runtime — if the plugin is misconfigured or cannot statically extract a `css` call, the throw ensures broken styles fail loudly rather than silently shipping broken code.
- `src/index.ts` → `dist/index.js` / `dist/index.d.ts` — Plugin export (`ecij/plugin`). The Rolldown/Vite plugin that performs static CSS extraction. This single file contains the entire plugin implementation.

### Plugin Pipeline

The plugin implements three Rolldown lifecycle hooks:

1. **`transform`** — Parses source files with `parseSync` (oxc-parser), identifies `css` tagged template literals imported from `ecij`, extracts their CSS content, replaces them with generated class names, and injects a side-effect import for the virtual CSS module. The hook's `code` filter skips files that do not reference `ecij` before the handler runs. Edits are applied through `RolldownMagicString`: when Rolldown provides an instance via the hook's `meta` argument, it is mutated and returned directly so Rolldown generates the sourcemap natively; otherwise the hook returns the transformed code with a generated sourcemap. Only plain Rolldown builds provide one — Vite rebuilds `meta` to add its `ssr` flag, which drops Rolldown's lazily created `magicString` — so every Vite build and dev server goes through the fallback. Class names are emitted as **IIFEs** (`(() => "css-…")()`), not literals — `optimization.inlineConst` inlines string and template literal constants into their importers, which leaves the declaring module without a used export and gets it dropped along with its stylesheet under `sideEffects: false`. Rolldown's constant evaluation does not see through function calls, so the binding survives tree-shaking; Rolldown still treats the IIFE as side-effect-free, and minifiers (Oxc, esbuild, terser) fold it back to a plain string. Do not annotate it with `@__PURE__` (terser does not inline annotated IIFEs), and do not simplify it without re-running the `inlineConst` tests. The comment above the replacement in `src/index.ts` links the upstream issues to revisit.
2. **`resolveId`** — Claims the virtual CSS module IDs (e.g., `Button.tsx.<hash>.css`), which look like file paths but do not exist on disk.
3. **`load`** — Returns the extracted CSS content for virtual CSS module IDs.

## Package Metadata

`package.json` doubles as the plugin's entry in the [Vite Plugin Registry](https://registry.vite.dev/), which harvests it from npm. Keep these fields accurate:

- **`keywords`** — `vite-plugin` and `rolldown-plugin` are how the registry discovers the package; removing either delists it. The registry's search box substring-matches `name`, `description`, and `keywords`, so both fields double as discoverability surface.
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

The test suite (`test/plugin.test.ts`) runs integration tests by invoking a Vite build with the ecij plugin and asserting on the JS and CSS output using `toMatchInlineSnapshot()`. One test runs a plain Rolldown build instead, as it is the only way to cover the native `meta.magicString` path; Rolldown no longer bundles CSS, so that test stands in for a CSS plugin.

If your changes alter the build output, tests will fail with snapshot mismatches. Review the diff to confirm it matches your intent, then update snapshots with:

```sh
node --run test -- -u
```

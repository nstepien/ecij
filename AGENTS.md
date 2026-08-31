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
| Test         | `node --run test`         |

**Before pushing**, merge the target branch into your branch to ensure you're working with up-to-date code, conflicts are caught early, and reviewers see accurate diffs.

**Before committing**, you must format the code, then run all checks and fix any failures:

```sh
node --run format
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

The plugin implements five Rolldown lifecycle hooks:

1. **`transform`** — Parses source files with `parseSync` (oxc-parser), identifies `css` tagged template literals whose tag is a named import from `ecij` (respecting lexical shadowing), extracts their CSS content, replaces them with generated class name strings, and injects a side-effect import for the virtual CSS module after any hashbang and directive prologue. Interpolations are resolved statically: literals and lexically scoped local bindings directly; imported bindings by loading the imported module (`this.load`, or the environment's `transformRequest` in Vite's dev server, where `this.load` does not run transforms) and reading its parsed exports, following re-export chains (`export { x } from`, `export * from`, `export * as ns from`) with ESM precedence. Parse results are cached per module (`parsedFileInfoCache`) and in-flight loads are tracked (`pendingLoads`) so import cycles fall back to cached parse info instead of deadlocking. Modules whose values were inlined also get a side-effect import of their stylesheet, so their CSS survives tree-shaking once the original import becomes unused. Edits are applied through `RolldownMagicString`: when Rolldown provides an instance via the hook's `meta` argument, it is mutated and returned directly so Rolldown generates the sourcemap natively; otherwise (e.g. Vite's dev-mode plugin container) the hook returns the transformed code with a generated sourcemap.
2. **`resolveId`** — Resolves virtual CSS module IDs (e.g., `Button.tsx.<hash>.css`). Also re-resolves source files that have CSS extractions to prevent them from being tree-shaken when all their exports are statically evaluated away.
3. **`load`** — Returns the extracted CSS content for virtual CSS module IDs.
4. **`watchChange`** — Evicts the changed module's cached parse info, extracted classes and CSS module, so the next transform re-reads it instead of serving stale values.
5. **`buildEnd`** — Clears all caches between builds.

## Code Style and Practices

- **Formatter**: oxfmt. Configuration is in `.oxfmtrc.json`.
- **TypeScript**: Strict mode is enabled. Use `import type` for type-only imports. See `tsconfig.base.json` for the shared compiler configuration.
- **Naming**: camelCase for variables/functions, PascalCase for interfaces, SCREAMING_SNAKE_CASE for module-level constants.
- **Module format**: ESM only.
- **Documentation**: Keep `README.md` and `AGENTS.md` in sync with the codebase.

## Testing

Tests use **Vitest** with inline snapshots. Test files are in `test/` and fixtures in `test/fixtures/`.
Fixtures stand in for user code and are exempt from the naming conventions above: their exported constants stay camelCase, as in real application code.

The test suite (`test/plugin.test.ts`) runs integration tests by invoking a Vite build with the ecij plugin and asserting on the JS and CSS output using `toMatchInlineSnapshot()`.

If your changes alter the build output, tests will fail with snapshot mismatches. Review the diff to confirm it matches your intent, then update snapshots with:

```sh
node --run test -- -u
```

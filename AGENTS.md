# AGENTS.md

## Project Overview

ecij (Extract CSS-in-JS) is a zero-runtime CSS-in-JS plugin for Rolldown and Vite. It statically extracts `css` tagged template literals into separate CSS files at build time.

## Setup

```sh
npm ci
```

Node 24+ is required.

## Commands

| Task             | Command                  |
| ---------------- | ------------------------ |
| Build            | `node --run build`          |
| Type check       | `node --run typecheck`      |
| Format check     | `node --run format:check`   |
| Format (fix)     | `node --run format`         |
| Test             | `node --run test`           |
| Test + coverage  | `node --run test:coverage`  |

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

The plugin implements three Rolldown lifecycle hooks:

1. **`transform`** — Parses source files with `parseSync` (oxc-parser), identifies `css` tagged template literals imported from `ecij`, extracts their CSS content, replaces them with generated class name strings, and injects a side-effect import for the virtual CSS module.
2. **`resolveId`** — Resolves virtual CSS module IDs (e.g., `Button.tsx.<hash>.css`). Also re-resolves source files that have CSS extractions to prevent them from being tree-shaken when all their exports are statically evaluated away.
3. **`load`** — Returns the extracted CSS content for virtual CSS module IDs.

## Code Style and Practices

- **Formatter**: oxfmt. Configuration is in `.oxfmtrc.json`.
- **TypeScript**: Strict mode is enabled. Use `import type` for type-only imports. See `tsconfig.base.json` for the full compiler configuration.
- **Naming**: camelCase for variables/functions, PascalCase for interfaces, SCREAMING_SNAKE_CASE for module-level constants.
- **Module format**: ESM only.
- **Documentation**: Keep `README.md` and `AGENTS.md` updated when making significant structural changes (new entry points, changed commands, new conventions).

## Testing

Tests use **Vitest** with inline snapshots. Test files are in `test/` and fixtures in `test/fixtures/`.

The test suite (`test/plugin.test.ts`) runs integration tests by invoking a Vite build with the ecij plugin and asserting on the JS and CSS output using `toMatchInlineSnapshot()`.

If your changes alter the build output, tests will fail with snapshot mismatches. Review the diff to confirm it matches your intent, then update snapshots with:

```sh
node --run test -- -u
```
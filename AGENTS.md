# AGENTS.md

## Project Overview

ecij (Extract CSS-in-JS) is a zero-runtime CSS-in-JS plugin for Rolldown and Vite. It statically extracts `css` tagged template literals into separate CSS files at build time using AST-based analysis via oxc-parser. The runtime export (`index.js`) is a stub that throws if called — all `css` calls must be transformed away by the plugin at build time.

## Setup

```sh
npm ci
```

Node 24+ is required.

## Commands

| Task             | Command                  |
| ---------------- | ------------------------ |
| Build            | `npm run build`          |
| Type check       | `npm run typecheck`      |
| Format check     | `npm run format:check`   |
| Format (fix)     | `npm run format`         |
| Test             | `npm test`               |
| Test + coverage  | `npm run test:coverage`  |

Run all checks before submitting changes:

```sh
npm run format:check && npm run typecheck && npm run build && npm test
```

## Architecture

### Entry Points

- `index.js` / `index.d.ts` — Runtime export (`ecij` package). Exports a `css` tagged template function that throws at runtime; it exists only for type-checking and to be transformed away by the plugin.
- `src/index.ts` → `dist/index.js` / `dist/index.d.ts` — Plugin export (`ecij/plugin`). The Rolldown/Vite plugin that performs static CSS extraction.

### Plugin Pipeline

The plugin implements three Rolldown lifecycle hooks:

1. **`transform`** — Parses source files with `parseSync` (oxc-parser), identifies `css` tagged template literals imported from `ecij`, extracts their CSS content, replaces them with generated class name strings, and injects a side-effect import for the virtual CSS module.
2. **`resolveId`** — Recognizes virtual CSS module IDs (e.g., `Button.tsx.<hash>.css`) and marks source files with CSS extractions as having side effects.
3. **`load`** — Returns the extracted CSS content for virtual CSS module IDs.

### Key Internal Functions

- `parseFile()` — Single-pass AST visitor that collects `css` tag declarations, local identifier values, import/export mappings. Results are cached per file path.
- `extractCssFromCode()` — Two-pass extraction: first processes declarations without interpolations, then resolves interpolations from local/imported identifiers. Skips blocks with unresolvable or complex expressions.
- `hashText()` — MD5-based hash (8-char hex) used for generating deterministic class names from `<relative-path>:<index>:<variable-name>`.

### Caching

Three `Map` caches exist within the plugin closure, all cleared in `buildEnd`:

- `parsedFileInfoCache` — Parsed AST info per file
- `extractedCssPerFile` — Virtual CSS module content (keyed by virtual module ID)
- `stylesheetImportPerFile` — Maps source file IDs to their generated CSS module IDs

## Code Style

- **Formatter**: oxfmt with single quotes (`singleQuote: true` in `.oxfmtrc.json`). Run `npm run format` to auto-fix.
- **TypeScript**: Strict mode with `exactOptionalPropertyTypes`, `isolatedDeclarations`, `verbatimModuleSyntax`, `noUnusedLocals`, and `noImplicitReturns` enabled. See `tsconfig.base.json`.
- **Naming**: camelCase for variables/functions, PascalCase for interfaces, SCREAMING_SNAKE_CASE for module-level constants.
- **Imports**: Use `import type` for type-only imports (`verbatimModuleSyntax` enforces this).
- **Module format**: ESM only (`"type": "module"` in package.json).

## Testing

Tests use **Vitest** with inline snapshots. Test files are in `test/` and fixtures in `test/fixtures/`.

The test suite (`test/plugin.test.ts`) runs integration tests by invoking a Vite build with the ecij plugin and asserting on the JS and CSS output using `toMatchInlineSnapshot()`.

When updating behavior that changes output, update snapshots with:

```sh
npm test -- -u
```

## CI

GitHub Actions CI (`.github/workflows/ci.yml`) runs on push to `main` and on pull requests. Matrix: Ubuntu + Windows, Node 24 + 25. Steps: format check → type check → build → test.

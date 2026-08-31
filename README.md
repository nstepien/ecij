# ecij

[![npm version](https://img.shields.io/npm/v/ecij)](https://www.npmjs.com/package/ecij)
[![CI](https://github.com/nstepien/ecij/actions/workflows/ci.yml/badge.svg)](https://github.com/nstepien/ecij/actions/workflows/ci.yml)

ecij (**E**xtract **C**SS-**i**n-**J**S) is a zero-runtime css-in-js plugin for [Rolldown](https://rolldown.rs/) and [Vite](https://vite.dev/).

It achieves this via static analysis by using [oxc-parser](https://www.npmjs.com/package/oxc-parser), as such it is limited to static expressions. The plugin will ignore dynamic or complex expressions.

The plugin does not process the CSS in any way whatsoever, it is merely output in virtual CSS files for Rolldown and Vite to handle. Separate plugins may be used to process these virtual CSS files.

## Installation

```bash
npm install -D ecij
```

## Usage

Source input:

```ts
/* main.ts */
import { css } from 'ecij';
import { redClassname } from './styles';

const myButtonClassname = css`
  border: 1px solid blue;

  &.${redClassname} {
    border-color: red;
  }
`;
```

```ts
/* styles.ts */
import { css } from 'ecij';

const color = 'red';

export const redClassname = css`
  color: ${color};
`;
```

Build output:

```js
/* js */
const color = 'red';

const redClassname = 'css-a1b2c3d4';

const myButtonClassname = 'css-1d2c3b4a';
```

```css
/* css */
.css-a1b2c3d4 {
  color: red;
}

.css-1d2c3b4a {
  border: 1px solid blue;

  &.css-a1b2c3d4 {
    border-color: red;
  }
}
```

## Set up

In `rolldown.config.ts`:

```ts
import { defineConfig } from 'rolldown';
import { ecij } from 'ecij/plugin';

export default defineConfig({
  // ...
  plugins: [ecij()],
});
```

In `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { ecij } from 'ecij/plugin';

export default defineConfig({
  // ...
  plugins: [ecij()],
});
```

## Configuration

The `ecij()` plugin accepts an optional configuration object:

```ts
export interface Configuration {
  /**
   * Include patterns for files to process.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default /\.[cm]?[jt]sx?$/
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Exclude patterns for files to skip.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default [/\/node_modules\//, /\.d\.ts$/]
   */
  exclude?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Prefix for generated CSS class names.
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS class names.
   * @default 'css-'
   */
  classPrefix?: string | undefined | null;
}
```

**Example:**

```ts
ecij({
  classPrefix: 'lib-',
});
```

## Static resolution

Interpolations are resolved at build time when they are:

- string or number literals, including signed numbers (`${'red'}`, `${16}`, `${-5}`);
- `const` bindings of such literals or of other `css` class names, following
  lexical scoping — any other binding (`let`, `var`, parameters, destructuring,
  …) shadows outer ones and is never resolved. Resolution is static, so a
  template may reference a `const` or a class declared later in the file;
- imports of such values from other modules — named, default and namespace
  imports (`${tokens.color}`) — through any depth of re-exports (`export { x } from`,
  `export * from`, `export * as ns from`) and barrel files, with ESM semantics:
  explicit exports win over `export *`, a name provided by several `export *`
  sources is ambiguous and not resolved, `export *` never forwards `default`, and
  type-only imports/exports are ignored. A query suffix denotes a separate
  module resolved on its own: `?raw` yields the file's text, `?url` its asset URL.

Any other interpolation — calls, ternaries, template literals, identifiers whose
value is not statically known (`let`/`var` bindings, parameters, ...) — causes
the whole css`` block to be skipped with a warning (`COMPLEX_INTERPOLATION` or
`UNRESOLVED_INTERPOLATION`; `UNREADABLE_MODULE` reports an imported module whose
source could not be read, `UNPARSEABLE_MODULE` a module the plugin could not parse). The runtime `css` call is left in place, so the
mistake fails loudly instead of silently shipping broken styles.

## Limitations

- The `css` tag must be a named import from `'ecij'` (aliasing it is fine,
  e.g. `import { css as styled } from 'ecij'`). Accessing it through a namespace
  import or re-exporting it through another module is not supported and leaves
  the templates untransformed.
- Interpolations must statically resolve to strings or numbers, see
  [Static resolution](#static-resolution).
- Only `const` bindings are resolved: a `let` or `var` — even one that is never
  reassigned — and an `export let` are not.
- Circular imports are supported, but inside a cycle a module can only inline
  the other module's class names whose declarations were already extracted when
  the cycle was entered — declare such classes before the templates that
  reference the other module.
- Resolving an import waits for the imported module's transform. A wait cycle
  closed through another plugin's `this.load` cannot be detected and would hang
  the build.

## Development

### Building

```bash
npm run build
```

### Formatting

```bash
npm run format
```

### Type Checking

```bash
npm run typecheck
```

### Running Tests

The project uses **integration tests** with **inline snapshot testing** to validate transformations.

```bash
# Run tests once
npm test

# Update inline snapshots after intentional changes
npm test -- -u
```

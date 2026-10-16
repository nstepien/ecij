# ecij

[![npm version](https://img.shields.io/npm/v/ecij)](https://www.npmjs.com/package/ecij)
[![Vite compatibility](https://registry.vite.dev/api/badges?package=ecij&tool=vite)](https://registry.vite.dev/plugins?q=ecij)
[![Rolldown compatibility](https://registry.vite.dev/api/badges?package=ecij&tool=rolldown)](https://registry.vite.dev/plugins?q=ecij)
[![CI](https://github.com/nstepien/ecij/actions/workflows/ci.yml/badge.svg)](https://github.com/nstepien/ecij/actions/workflows/ci.yml)

ecij (**E**xtract **C**SS-**i**n-**J**S) is a zero-runtime CSS-in-JS plugin for [Vite](https://vite.dev/), [tsdown](https://tsdown.dev/), and [Rolldown](https://rolldown.rs/).

It achieves this via static analysis by using [oxc-parser](https://www.npmjs.com/package/oxc-parser), so it is limited to static expressions. The plugin will ignore dynamic or complex expressions.

The plugin does not process the CSS in any way whatsoever. It is merely output in virtual CSS files for the bundler to handle. Separate plugins may be used to process these virtual CSS files.

## Installation

```bash
npm install -D ecij
```

The plugin is built on Rolldown's APIs, so `rolldown` is a required peer dependency. In Vite and tsdown projects it is already part of the dependency tree — npm and pnpm resolve the peer to that same copy — but package managers that do not install peer dependencies automatically, such as Yarn, require it to be installed explicitly.

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

## Setup

Add the plugin to `vite.config.ts`, `tsdown.config.ts`, or `rolldown.config.ts`:

```ts
import { ecij } from 'ecij/plugin';
import { defineConfig } from 'vite'; // or 'tsdown' or 'rolldown'

export default defineConfig({
  // ...
  plugins: [ecij()],
});
```

tsdown also needs [`@tsdown/css`](https://tsdown.dev/options/css) to be installed to bundle the extracted CSS.

## Configuration

The `ecij()` plugin accepts an optional configuration object:

```ts
export interface Configuration {
  /**
   * Include patterns for files to process, matched against the module id.
   *
   * @default `/\.[cm]?[jt]sx?$/`
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Exclude patterns for files to skip, matched against the module id.
   *
   * @default `[/\/node_modules\//, /\.d\.ts$/]`
   */
  exclude?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Prefix for generated CSS class names.
   *
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS
   * class names.
   *
   * @default `'css-'`
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
- named imports of such `const` bindings from other modules.

Any other interpolation — calls, ternaries, template literals, identifiers whose
value is not statically known (`let`/`var` bindings, parameters, ...) — causes
the whole css`` block to be skipped with a warning (`COMPLEX_INTERPOLATION` or
`UNRESOLVED_INTERPOLATION`). The runtime `css` call is left in place, so the
mistake fails loudly instead of silently shipping broken styles.

The `css` tag must be a named import from `'ecij'` (aliasing it is fine, e.g.
`import { css as styled } from 'ecij'`). A local binding of the same name
shadows it, so its templates are left alone.

## Development

```bash
# Build the plugin
npm run build

# Format the code
npm run format

# Run the linter
npm run lint

# Auto-fix lints
npm run lint:fix

# Type check
npm run typecheck

# Run tests once
npm test

# Update test snapshots
npm test -- -u
```

## TODO

- Full import/export handling (default/namespace import/export)

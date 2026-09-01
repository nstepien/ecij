# ecij

[![npm version](https://img.shields.io/npm/v/ecij)](https://www.npmjs.com/package/ecij)
[![Vite compatibility](https://registry.vite.dev/api/badges?package=ecij&tool=vite)](https://registry.vite.dev/plugins?q=ecij)
[![Rolldown compatibility](https://registry.vite.dev/api/badges?package=ecij&tool=rolldown)](https://registry.vite.dev/plugins?q=ecij)
[![CI](https://github.com/nstepien/ecij/actions/workflows/ci.yml/badge.svg)](https://github.com/nstepien/ecij/actions/workflows/ci.yml)

ecij (**E**xtract **C**SS-**i**n-**J**S) is a zero-runtime css-in-js plugin for [Rolldown](https://rolldown.rs/) and [Vite](https://vite.dev/).

It achieves this via static analysis by using [oxc-parser](https://www.npmjs.com/package/oxc-parser), as such it is limited to static expressions. The plugin will ignore dynamic or complex expressions.

The plugin does not process the CSS in any way whatsoever, it is merely output in virtual CSS files for Rolldown and Vite to handle. Separate plugins may be used to process these virtual CSS files.

## Installation

```bash
npm install -D ecij
```

The plugin is built on Rolldown's APIs, so `rolldown` is a required peer dependency. In a Vite project it is already part of the dependency tree — npm and pnpm resolve the peer to that same copy — but package managers which do not install peer dependencies automatically (e.g. Yarn) require it to be installed explicitly.

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

## Development

```bash
# Build the plugin
npm run build

# Format the code
npm run format

# Report lint problems
npm run lint

# Fix the auto-fixable lint problems
npm run lint:fix

# Type check
npm run typecheck

# Run tests once
npm test

# Update inline snapshots after intentional changes
npm test -- -u
```

Tests are **integration tests** using **inline snapshot testing** to validate transformations, so `npm test -- -u` is how intentional changes to the output are accepted.

## TODO

- Full import/export handling (default/namespace import/export)

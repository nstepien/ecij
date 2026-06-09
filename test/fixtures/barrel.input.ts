import { css } from 'ecij';

// Pull a mix of names through a barrel file:
// - `aColor`, `aClass` come from barrel-a via `export *`
// - `bColor`, `bClass` come from barrel-b via `export *`
// - `shared` is exposed by both barrel-b (via `export *`) and barrel-c (explicit
//   `export { shared }`); the explicit re-export must win
// - `aClass` is also reachable through a nested barrel, but should still resolve
//   to the same value (two star paths to the *same* binding are not ambiguous).
// - `dColor` is only reachable through the nested barrel (depth-2 `export *`).
import { aColor, aClass, bColor, bClass, shared, dColor } from './barrel';

export const usesBarrelA = css`
  /* uses-a */
  color: ${aColor};

  &.${aClass} {
    color: red;
  }
`;

export const usesBarrelB = css`
  /* uses-b */
  color: ${bColor};

  &.${bClass} {
    color: red;
  }
`;

export const usesBarrelShared = css`
  /* uses-shared */
  color: ${shared};
`;

export const usesBarrelDeep = css`
  /* uses-deep */
  color: ${dColor};
`;

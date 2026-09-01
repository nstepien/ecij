import { css } from 'ecij';

// Mutual import cycle: this module uses cycle-b's class while cycle-b uses
// this module's class. Resolution must neither deadlock nor lose classes that
// are already extracted when the cycle is entered.
import { bClass } from './cycle-b';

// Declared first, so resolving it loads cycle-b before `aClass` below would be
// reached in source order. `aClass` only depends on a local binding and must be
// extracted before any import is followed, or cycle-b could not see it.
export const usesB = css`
  &.${bClass} {
    color: blue;
  }
`;

const color = 'red';

export const aClass = css`
  /* cycle-a */
  color: ${color};
`;

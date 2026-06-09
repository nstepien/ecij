import { css } from 'ecij';

// Mutual import cycle: this module uses cycle-b's class while cycle-b uses
// this module's class. Resolution must neither deadlock nor lose classes that
// are already extracted when the cycle is entered.
import { bClass } from './cycle-b';

export const aClass = css`
  /* cycle-a */
  color: red;
`;

export const usesB = css`
  &.${bClass} {
    color: blue;
  }
`;

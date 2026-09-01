import { css } from 'ecij';

import { bClass } from './chain-b';

// The rule of `bClass` references `cClass`, so chain-c's stylesheet is needed
// even though this module never imports from chain-c itself.
export const aClass = css`
  /* chain-a */
  &.${bClass} {
    color: red;
  }
`;

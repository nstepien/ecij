import { css } from 'ecij';

import { cClass } from './chain-c';

// Once `bClass` is inlined into the consumer, nothing imports anything from
// this module anymore; its stylesheet imports must still be kept.
export const bClass = css`
  /* chain-b */
  &.${cClass} {
    color: green;
  }
`;

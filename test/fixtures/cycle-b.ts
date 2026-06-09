import { css } from 'ecij';

import { aClass } from './cycle-a.input';

export const bClass = css`
  /* cycle-b */
  &.${aClass} {
    color: green;
  }
`;

import { css } from 'ecij';

import { bClass } from './cycle-b';

export const aClass: string = css`
  &.${bClass} {
    color: red;
  }
`;

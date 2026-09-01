import { css } from 'ecij';

import { producerClass } from './sibling-producer';

export const consumerClass = css`
  /* consumer */
  &.${producerClass} {
    color: blue;
  }
`;

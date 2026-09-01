import { css } from 'ecij';

// Both siblings enter the module graph from here and may be transformed
// concurrently; the consumer resolving the producer's class mid-build must
// wait for its extraction rather than failing spuriously.
import { consumerClass } from './sibling-consumer';
import { producerClass } from './sibling-producer';

export const usesBoth = css`
  /* uses-both */
  &.${producerClass} {
    color: red;
  }

  &.${consumerClass} {
    color: green;
  }
`;

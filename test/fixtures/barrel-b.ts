import { css } from 'ecij';

export const bColor = 'beige';

export const bClass = css`
  /* b */
  color: ${bColor};
`;

// `b` also defines `shared` — barrel-c re-exports an explicit `shared`
// that should win over the `export *` collision.
export const shared = 'b-loses';

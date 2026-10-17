// @ts-nocheck — `virtual:tokens` is provided by an inline plugin of the dev test
import { css } from 'ecij';
import { vcolor } from 'virtual:tokens';

export const usesVirtualToken = css`
  color: ${vcolor};
`;

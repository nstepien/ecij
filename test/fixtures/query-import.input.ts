// @ts-nocheck — `?raw`/`?url` imports need Vite's client types, which the
// test tsconfig does not load.
import { css } from 'ecij';

// A query denotes a different module than the file: `?raw` is the file's text
// and `?url` its asset URL. Both are static strings resolved from that module's
// own default export.
import tokenSource from './export-default-literal.ts?raw';
import tokenUrl from './export-default-literal.ts?url';

export const usesRawImport = css`
  /* ${tokenSource} */
  color: royalblue;
`;

export const usesUrlImport = css`
  background: url(${tokenUrl});
`;

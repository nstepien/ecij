// @ts-nocheck — `?raw`/`?url` imports need Vite's client types, which the
// test tsconfig does not load.
import { css } from 'ecij';

// The query selects a different module (the file's source text, an asset URL)
// whose value cannot be read from the file itself: it must not be resolved as
// if it were the plain module's default export.
import tokenSource from './export-default-literal.ts?raw';
import tokenUrl from './export-default-literal.ts?url';

export const usesRawImport = css`
  content: '${tokenSource}';
`;

export const usesUrlImport = css`
  background: url(${tokenUrl});
`;

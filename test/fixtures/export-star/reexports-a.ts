// The bindings of tokens.ts and its namespace, re-exported
export { gap } from './tokens';
export * as tokens from './tokens';

// A different binding than the `spacing` of reexports-b.ts, with the same value
export const spacing = 8;

// @ts-expect-error -- an external module, which is not installed
export { fromExternal as reexportedExternal } from 'external-tokens';

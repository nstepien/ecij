// The module's own exports take precedence over those of `export *`, even without static values
export const fontWeight = 'normal';
export function width() {}
export const { bgColor } = { bgColor: 'black' };

// Type-only exports do not exist at runtime, so they neither shadow nor add to the names of
// `export *`
export type color = string;
export interface Theme {
  color: color;
}
export type { radius } from './type-exports';
export { type borderStyle } from './type-exports';
export type * as typeNs from './type-exports';

export * from '../imported-literals';
export * from '../imported-style';
export * from './default-export';
export * from './nested';
export * from './reexports-a';
// @ts-expect-error -- `spacing` is exported by both reexports-a.ts and reexports-b.ts
export * from './reexports-b';
// @ts-expect-error -- TypeScript takes the types of its `gap` and those of nested.ts as ambiguous
export type * from './type-exports';
// A cycle
export * from './barrel';
// @ts-expect-error -- an external module, which is not installed
export * from 'external-tokens';

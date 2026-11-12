// The module's own exports take precedence over those of `export *`, even without static values
export const fontWeight = 'normal';
export function width() {}
export const { bgColor } = { bgColor: 'black' };

// Types are not exported at runtime
export type color = string;
export interface Theme {
  color: color;
}

export * from '../imported-literals';
export * from '../imported-style';
export * from './default-export';
export * from './nested';
export * from './reexports-a';
// @ts-expect-error -- `spacing` is exported by both reexports-a.ts and reexports-b.ts
export * from './reexports-b';
// A cycle
export * from './barrel';
// @ts-expect-error -- an external module, which is not installed
export * from 'external-tokens';

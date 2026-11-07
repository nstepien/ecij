// @ts-nocheck — tsc flags the type-only star below as colliding with the
// value star (TS2308), but at runtime the type-only star is erased and the
// name is unambiguous; the plugin must reach the same conclusion.
// Type-only re-exports are erased at runtime and must neither provide nor
// shadow values: the `typedTone` VALUE must resolve through the `export *` of
// typed-tokens below ('salmon'), never through the type-only star re-export
// of the decoy (whose `typedTone` is 'WRONG-decoy-value').
export { type typedTone as DecoyToneType } from './typed-decoy';
export type * from './typed-decoy';
export type { ToneType } from './typed-tokens';
export * from './typed-tokens';

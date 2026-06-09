// @ts-nocheck — the ambiguity below is deliberate.
// `accent` is provided by two different bindings — per ESM the name is
// ambiguous and not exported at all.
export * from './ambiguous-a';
export * from './ambiguous-b';

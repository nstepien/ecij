// @ts-nocheck — the ambiguity below is deliberate.
// `accent` is ambiguous through the barrel and a value through the alias; the
// ambiguity wins — per ESM the name is not exported at all
export * from './ambiguous-barrel';
export * from './ambiguous-alias';

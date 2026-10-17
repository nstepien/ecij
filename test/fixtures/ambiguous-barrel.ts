// @ts-nocheck — the ambiguity below is deliberate.
// `accent` is provided by two different bindings — per ESM the name is
// ambiguous and not exported at all. The local `accent` is only exported as
// `tone`, so it does not resolve the ambiguity.
const accent = 'green';
export { accent as tone };
export * from './ambiguous-a';
export * from './ambiguous-b';

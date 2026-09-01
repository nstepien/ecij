export const typedTone = 'salmon';

export type ToneType = string;

type LocalSpec = string;

// Inline type-only local export — erased at runtime
export { type LocalSpec };

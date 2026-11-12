// a.ts exports `loop` back to this module

// @ts-expect-error -- circular definition
export { loop } from './a';

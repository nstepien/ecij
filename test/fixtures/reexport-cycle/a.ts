// b.ts exports `loop` back to this module

// @ts-expect-error -- circular definition
import { loop } from './b';

// @ts-expect-error -- circular definition
export { loop };

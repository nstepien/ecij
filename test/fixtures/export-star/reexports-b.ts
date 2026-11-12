import { gap } from './tokens';
import * as tokens from './tokens';

// The bindings of tokens.ts and its namespace, imported and exported again
export { gap, tokens };

// A different binding than the `spacing` of reexports-a.ts, with the same value
export const spacing = 8;

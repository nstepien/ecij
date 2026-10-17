// A barrel file with a mix of explicit re-exports and `export *` aggregation.
// Explicit named re-exports must take precedence over `export *` collisions.
export { shared } from './barrel-c';
export * from './barrel-a';
export * from './barrel-b';
export * from './barrel-nested';

// Local export that shadows `aColor` re-exported via `export * from './barrel-a'`.
// Per spec, an explicit named export wins over `export *` for the same name.
export const aColor = 'locally-overridden';

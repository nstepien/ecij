// Nested barrel — re-exports through another barrel layer.
// `dColor` is reachable from the top-level barrel only through this hop.
export * from './barrel-a';
export * from './barrel-d';

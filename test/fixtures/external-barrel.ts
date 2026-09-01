// @ts-nocheck — '@acme/tokens' deliberately does not exist; it is marked
// external in the consuming test's build options.
// The first star source is an external package that cannot be parsed —
// resolution must skip it gracefully and find the value in the next source.
export * from '@acme/tokens';
export * from './external-tokens';

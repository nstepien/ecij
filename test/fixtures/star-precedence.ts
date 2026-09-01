export * from './star-precedence-a';

function computeTone(): string {
  return 'runtime-only';
}

// Explicit export with a non-static value — per ESM it shadows the `tone`
// provided by `export *` above, so the plugin must not resolve it to 'aqua'.
export const tone = computeTone();

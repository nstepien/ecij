// Read from disk, as it does not import from ecij, so its type assertions reach the plugin in Vite
// builds too
export const gap = 4 as const;

export const color = 'teal' satisfies string;

// @ts-expect-error -- `erasableSyntaxOnly` rejects angle-bracket assertions, which still parse
export const width = <number>10;

export const border = `${gap as number}px solid ${color}`;

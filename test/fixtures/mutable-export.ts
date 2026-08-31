export let theme = 'light';

// Reassigns the exported binding: `theme` has no static value
export function toggleTheme() {
  theme = 'dark';
}

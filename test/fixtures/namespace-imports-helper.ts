import * as literals from './imported-literals';

// A namespace import exported again
export { literals };

// A namespace re-exported from another module
export * as style from './imported-style';

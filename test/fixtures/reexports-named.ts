// Re-export named bindings unchanged and renamed
export { accentColor, accentClass as renamedAccentClass } from './named-styles';

// Re-export a default as a named binding
export { default as defaultStyle } from './export-default-css';

// Re-export a named binding as the default
export { accentColor as default } from './named-styles';

import { css } from 'ecij';

import defaultColor, {
  default as namedDefaultColor,
  'string name' as stringName,
  reexportedSize,
  reexportedClass,
  destructured,
  reexported,
  reexportedDefault,
  width,
} from './import-forms-helper';
import * as helper from './import-forms-helper';
import defaultClass from './import-forms-style';
import { themeColor } from './import-forms-types';

// Imports and exports can be named by strings
export const stringNameClass = css`
  color: ${stringName};
`;

// Default imports resolve, of values and class names alike
export const defaultImportsClass = css`
  color: ${defaultColor};
  border-color: ${namedDefaultColor};

  &.${defaultClass} {
    color: inherit;
  }
`;

// Exports resolve beside a default export without a value
export const typedModuleClass = css`
  color: ${themeColor};
`;

// Imports exported again resolve in the module they are imported from
export const reexportedImportsClass = css`
  font-size: ${reexportedSize}px;

  &.${reexportedClass} {
    color: navy;
  }
`;

// Re-exports resolve in the module they re-export from, default exports included
export const reexportClass = css`
  font-weight: ${reexported};

  &.${reexportedDefault} {
    color: inherit;
  }
`;

// So do the names of `export *`
export const starExportClass = css`
  width: ${width}px;
`;

// Members of namespace imports resolve, the default export included
export const namespaceImportClass = css`
  color: ${helper.default};
`;

// Destructured exports do not → NOT extracted
export const destructuredExportClass = css`
  color: ${destructured};
`;

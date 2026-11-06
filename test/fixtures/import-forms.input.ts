import { css } from 'ecij';

import defaultColor, {
  'string name' as stringName,
  reexportedSize,
  reexportedClass,
  destructured,
  reexported,
} from './import-forms-helper';

// Imports and exports can be named by strings
export const stringNameClass = css`
  color: ${stringName};
`;

// Imports exported again resolve in the module they are imported from
export const reexportedImportsClass = css`
  font-size: ${reexportedSize}px;

  &.${reexportedClass} {
    color: navy;
  }
`;

// Default imports are not resolved → NOT extracted
export const defaultImportClass = css`
  color: ${defaultColor};
`;

// Neither are destructured exports → NOT extracted
export const destructuredExportClass = css`
  color: ${destructured};
`;

// Nor exports from other modules → NOT extracted
export const reexportClass = css`
  font-weight: ${reexported};
`;

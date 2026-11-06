import { css } from 'ecij';

import defaultColor, {
  'string name' as stringName,
  destructured,
  reexported,
} from './import-forms-helper';

// Imports and exports can be named by strings
export const stringNameClass = css`
  color: ${stringName};
`;

// Default imports are not resolved → NOT extracted
export const defaultImportClass = css`
  color: ${defaultColor};
`;

// Neither are destructured exports → NOT extracted
export const destructuredExportClass = css`
  color: ${destructured};
`;

// Nor re-exports → NOT extracted
export const reexportClass = css`
  font-weight: ${reexported};
`;

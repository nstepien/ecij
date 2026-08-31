import { css } from 'ecij';

import { theme } from './mutable-export';

// `theme` is reassigned in its module, so the import is a live binding with
// no static value: the consumer must warn instead of baking 'light'.
export const usesMutableExport = css`
  color: ${theme};
`;

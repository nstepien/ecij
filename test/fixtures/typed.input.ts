import { css } from 'ecij';

// Inline type modifier mixed with a value import
import { type LocalSpec, typedTone } from './typed-barrel';
// Statement-level type-only import — erased
import type { ToneType } from './typed-tokens';
// Namespace type-only import — erased
import type * as TypedNs from './typed-tokens';

const toneAnnotation: ToneType = 'plum';
const spec: LocalSpec = '12px';
const nsAnnotated: TypedNs.ToneType = 'navy';

export const usesTypedTone = css`
  /* uses typed-tone */
  color: ${typedTone};
  outline-color: ${toneAnnotation};
  width: ${spec};
  border-color: ${nsAnnotated};
`;

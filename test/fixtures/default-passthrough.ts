// oxc normalizes this pair into a re-export entry that points at the *local*
// binding name instead of 'default' — the plugin must map it back.
import passthroughDefault from './default-passthrough-source';

export { passthroughDefault };

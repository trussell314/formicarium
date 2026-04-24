// Page Visibility API integration. SPEC §7.3.

import type { Loop } from './loop';

export function bindVisibilityPause(loop: Loop): () => void {
  const onChange = (): void => {
    if (document.hidden) loop.pause();
    else loop.resume();
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const listeners: (() => void)[] = [];

export function onPerfCacheInvalidate(fn: () => void) {
  listeners.push(fn);
}

export function invalidatePerfCache() {
  for (const fn of listeners) fn();
}

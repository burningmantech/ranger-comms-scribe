/**
 * Latest-started-wins for overlapping requests: `start()` marks a new request and returns
 * a check that stays true only until the next one starts. A response whose check is false
 * is stale (a newer request is on its way) and is dropped.
 */
export function createLatestRequestGate(): { start: () => () => boolean } {
  let latest = 0;
  return {
    start() {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}

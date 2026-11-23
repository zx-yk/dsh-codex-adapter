/**
 * Four summary tiles shown above the history table. Labels come from the
 * active locale copy; values fall back to zero before the first response so
 * the panel never renders "undefined" while /history is still pending.
 */
export function historyStatItems(stats, copy) {
  return [
    { key: 'total', label: copy.historyTotal, value: stats?.total ?? 0 },
    { key: 'done', label: copy.historyDone, value: stats?.done ?? 0 },
    { key: 'failed', label: copy.historyFailed, value: stats?.failed ?? 0 },
    { key: 'avg', label: copy.historyAvg, value: `${stats?.avgSeconds ?? 0}s` },
  ];
}

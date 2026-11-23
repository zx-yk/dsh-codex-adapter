import test from 'node:test';
import assert from 'node:assert/strict';
import { historyStatItems } from '../src/client/history-view.mjs';

const copy = {
  historyTotal: 'Total',
  historyDone: 'Done',
  historyFailed: 'Failed',
  historyAvg: 'Average duration',
};

test('history summary defaults missing values before the first response', () => {
  assert.deepEqual(historyStatItems(null, copy), [
    { key: 'total', label: 'Total', value: 0 },
    { key: 'done', label: 'Done', value: 0 },
    { key: 'failed', label: 'Failed', value: 0 },
    { key: 'avg', label: 'Average duration', value: '0s' },
  ]);
});

test('history summary maps server totals and average duration', () => {
  assert.deepEqual(historyStatItems({ total: 9, done: 7, failed: 2, avgSeconds: 12 }, copy), [
    { key: 'total', label: 'Total', value: 9 },
    { key: 'done', label: 'Done', value: 7 },
    { key: 'failed', label: 'Failed', value: 2 },
    { key: 'avg', label: 'Average duration', value: '12s' },
  ]);
});

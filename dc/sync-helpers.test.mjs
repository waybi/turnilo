import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindows, scopedFrom, assertOwnedRow, dateSQL } from './sync-helpers.mjs';

test('source date builder preserves text instead of MySQL NULLIF numeric coercion', () => {
  assert.ok(dateSQL('t.date','t.created_at').includes('THEN t.date ELSE CAST(t.created_at AS CHAR)'));
  assert.ok(!dateSQL('t.date','t.created_at').includes('NULLIF'));
  assert.throws(()=>dateSQL('t.date;DELETE','t.created_at'));
});

test('report windows retain all rows within selected non-overlapping periods, independently per store', () => {
  const windows = [{uid:'113',s:'2026-08-30',e:'2026-09-30'}, {uid:'113',s:'2026-09-01',e:'2026-10-01'}, {uid:'112',s:'2026-08-30',e:'2026-09-30'}, {uid:'113',s:'2026-06-18',e:'2026-07-18'}];
  const picked = pickWindows(windows);
  assert.equal(picked.length,3);
  assert.ok(picked.some(w=>w.uid==='113'&&w.e==='2026-10-01'));
  assert.ok(!picked.some(w=>w.uid==='113'&&w.e==='2026-09-30'));
  assert.throws(()=>pickWindows([{uid:'49',s:'2026-09-01',e:'2026-09-30'}]));
});
test('scope cannot be omitted or replaced by an arbitrary column', () => {
  assert.equal(scopedFrom('orders','o','uid'),'FROM `orders` o WHERE o.uid IN (112,113)');
  assert.throws(()=>scopedFrom('orders','o'));
  assert.throws(()=>scopedFrom('orders','o','id'));
  assert.throws(()=>scopedFrom('orders;delete','o','uid'));
});
test('every output row is restricted to the two approved stores and valid time', () => {
  assertOwnedRow({store:'1号店',storeId:113,time:'2026-10-01T00:00:00Z'});
  assert.throws(()=>assertOwnedRow({store:'other',storeId:49,time:'2026-10-01'}));
  assert.throws(()=>assertOwnedRow({store:'1号店',storeId:49,time:'2026-10-01'}));
  assert.throws(()=>assertOwnedRow({store:'2号店',time:null}));
});

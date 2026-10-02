import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLayers, saleBounds, GROWTH_TYPES, MILESTONES } from './overview-derived.mjs';

const o = (store, time, psku, price, status = 'Delivered') => ({ time, store, storeId: store === '1号店' ? '113' : '112', psku, sku: psku + '-1', price, status });
const titles = new Map([['1号店|A', 'Product A'], ['1号店|B', 'Product B']]);

test('contributions reconcile to store totals and classify products', () => {
  const orders = [
    o('1号店', '2026-07-03T10:00:00Z', 'A', 10), o('1号店', '2026-07-20T10:00:00Z', 'A', 10),
    o('1号店', '2026-07-05T10:00:00Z', 'B', 50),
    o('1号店', '2026-08-02T10:00:00Z', 'A', 12), o('1号店', '2026-08-09T10:00:00Z', 'A', 12), o('1号店', '2026-08-16T10:00:00Z', 'A', 12),
    o('1号店', '2026-08-04T10:00:00Z', 'C', 30),
    o('1号店', '2026-08-04T10:00:00Z', 'C', 30, 'CIR'),          // invalid: excluded everywhere
    o('1号店', '2026-06-01T10:00:00Z', 'D', 7), o('1号店', '2026-08-20T10:00:00Z', 'D', 7), // reactivated in Aug
    o('1号店', '2026-09-30T10:00:00Z', 'A', 99)                   // after cutoff month: ignored
  ];
  const { contributions } = deriveLayers({ orders, ads: [], titles, cutoff: '2026-09-01' });
  const aug = contributions.filter(r => r.period === '2026-07 → 2026-08');
  const byPsku = Object.fromEntries(aug.map(r => [r.psku, r]));
  assert.equal(byPsku.A.type, GROWTH_TYPES.existing);
  assert.equal(byPsku.B.type, GROWTH_TYPES.lapsed);
  assert.equal(byPsku.C.type, GROWTH_TYPES.first);
  assert.equal(byPsku.D.type, GROWTH_TYPES.reactivated);
  assert.equal(byPsku.C.gmvAfter, 30, 'CIR row excluded');
  const net = aug.reduce((s, r) => s + r.gmvDelta, 0);
  assert.equal(net, (36 + 30 + 7) - (20 + 50));
  // Old-product volume + price effects equal the old-product delta exactly.
  assert.ok(Math.abs(byPsku.A.volumeEffect + byPsku.A.priceEffect - byPsku.A.gmvDelta) < 1e-9);
  assert.ok(Math.abs(aug.reduce((s, r) => s + r.shareOfNet, 0) - 1) < 1e-9);
  assert.equal(byPsku.A.title, 'Product A');
  assert.equal(byPsku.C.title, null);
  assert.equal(byPsku.A.gmvBeforeScaled, 20 * 31 / 31);
});

test('non-adjacent months are not compared', () => {
  const orders = [o('2号店', '2026-05-01T00:00:00Z', 'X', 5), o('2号店', '2026-07-01T00:00:00Z', 'X', 5)];
  const { contributions } = deriveLayers({ orders, ads: [], titles, cutoff: '2026-08-01' });
  assert.equal(contributions.length, 0);
});

test('milestones and launch windows follow the first valid sale', () => {
  const orders = [o('2号店', '2026-04-16T00:00:00Z', 'Z', 1, 'Cancelled')];
  for (let d = 18; d <= 30; d++) orders.push(o('2号店', `2026-04-${String(d).padStart(2, '0')}T08:00:00Z`, 'Z', 10));
  for (let i = 0; i < 100; i++) orders.push(o('2号店', '2026-05-02T08:00:00Z', 'Y', 2));
  const ads = [{ time: '2026-04-20T00:00:00Z', store: '2号店', spends: 5, revenue: 20, orders: 1 }, { time: '2026-06-01T00:00:00Z', store: '2号店', spends: 99, revenue: 0, orders: 0 }];
  const { milestones, launch, launchProducts } = deriveLayers({ orders, ads, titles, cutoff: '2026-06-01' });
  const at = label => milestones.find(m => m.type === label).time.slice(0, 10);
  assert.equal(at(MILESTONES[0][1]), '2026-04-16');
  assert.equal(at('最早有效首件'), '2026-04-18');
  assert.equal(at('累计10件'), '2026-04-27');
  assert.equal(at('累计100件'), '2026-05-02');
  // Both need a full 7-day observation window (same as the report's rolling(7, min_periods=7)).
  assert.equal(at('首次7天内5天有成交'), '2026-04-24');
  assert.equal(at('首次连续7天每天成交'), '2026-04-24');
  assert.equal(launch.length, 1, 'only the complete 28-day block before the cutoff');
  assert.equal(launch[0].period, '2026-04-18～2026-05-15');
  assert.equal(launch[0].sales, 130 + 200);
  assert.equal(launch[0].products, 2);
  assert.equal(launch[0].days, 14);
  assert.equal(launch[0].spend, 5);
  assert.equal(launch[0].top3, 330);
  assert.deepEqual(launchProducts.map(r => r.psku).sort(), ['Y', 'Z']);
});

test('saleBounds ignores invalid statuses', () => {
  const { first, last } = saleBounds([o('1号店', '2026-01-05T00:00:00Z', 'A', 1, 'Cancelled'), o('1号店', '2026-01-09T00:00:00Z', 'A', 1)]);
  assert.equal(first.get('1号店|A'), '2026-01-09');
  assert.equal(last.get('1号店|A'), '2026-01-09');
});

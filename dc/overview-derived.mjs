// Derived analysis layers for the overview cube, computed only from a run's own exported files.
// Growth decomposition, launch milestones and 28-day launch windows are descriptive arithmetic,
// not causal attribution. Everything here is pure so it can be regression-tested offline.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const INVALID_STATUSES = new Set(['CIR', 'Could Not Be Delivered', 'Cancelled']);
export const NEVER_SOLD = '从未观察有效成交';
export const DERIVED_TITLES = {
  contributions: '复盘·商品月度增减',
  milestones: '复盘·破冰节点',
  launch: '复盘·起步28天',
  launchProducts: '复盘·起步28天商品'
};
export const GROWTH_TYPES = { existing: '老品（两月都有成交）', first: '首次观察成交', reactivated: '恢复成交', lapsed: '本月无成交' };
export const MILESTONES = [
  ['anyOrder', '最早任意状态订单（可能取消）'], ['firstValid', '最早有效首件'],
  ['cum10', '累计10件'], ['cum50', '累计50件'], ['cum100', '累计100件'],
  ['week5', '首次7天内5天有成交'], ['week7', '首次连续7天每天成交']
];

export async function readJsonl(path) {
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line) rows.push(JSON.parse(line));
  return rows;
}

const day = t => t.slice(0, 10);
const month = t => t.slice(0, 7);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysInMonth = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const key = r => r.store + '|' + r.psku;
export const isValid = r => !INVALID_STATUSES.has(r.status);

// First/last valid sale per store×PSKU over all exported history (no cutoff: a first sale is a first sale).
export function saleBounds(orders) {
  const first = new Map(), last = new Map();
  for (const r of orders) {
    if (!isValid(r) || !r.psku) continue;
    const k = key(r), d = day(r.time);
    if (!first.has(k) || d < first.get(k)) first.set(k, d);
    if (!last.has(k) || d > last.get(k)) last.set(k, d);
  }
  return { first, last };
}

// cutoff: exclusive 'YYYY-MM-DD'. Months are complete only when strictly before the cutoff month.
export function deriveLayers({ orders, ads, titles, cutoff }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('cutoff must be YYYY-MM-DD');
  const cutoffMonth = month(cutoff);
  const { first } = saleBounds(orders);
  const title = (store, psku) => titles.get(store + '|' + psku) ?? null;
  const base = (store, date, extra) => ({ time: date + 'T00:00:00Z', store, storeId: store === '1号店' ? '113' : '112', ...extra });
  const out = { contributions: [], milestones: [], launch: [], launchProducts: [] };
  const stores = [...new Set(orders.map(r => r.store))].sort();
  for (const store of stores) {
    const all = orders.filter(r => r.store === store && day(r.time) < cutoff);
    const valid = all.filter(isValid);
    // ---- monthly product contributions ----
    const monthly = new Map(); // month -> psku -> {items,gmv}
    for (const r of valid) {
      const m = month(r.time); if (m >= cutoffMonth) continue;
      if (!monthly.has(m)) monthly.set(m, new Map());
      const bucket = monthly.get(m); const cell = bucket.get(r.psku) || { items: 0, gmv: 0 };
      cell.items++; cell.gmv += r.price; bucket.set(r.psku, cell);
    }
    const months = [...monthly.keys()].sort();
    for (let i = 1; i < months.length; i++) {
      const before = months[i - 1], after = months[i];
      if (daysInMonth(before) && month(addDays(before + '-01', 32)) !== after) continue; // only adjacent months
      const b = monthly.get(before), a = monthly.get(after);
      const pskus = new Set([...b.keys(), ...a.keys()]);
      const rows = [];
      let total = 0;
      for (const psku of pskus) {
        const x = b.get(psku) || { items: 0, gmv: 0 }, y = a.get(psku) || { items: 0, gmv: 0 };
        const delta = y.gmv - x.gmv; total += delta;
        let type, volumeEffect = 0, priceEffect = 0;
        if (x.items > 0 && y.items > 0) {
          type = GROWTH_TYPES.existing;
          const aspB = x.gmv / x.items, aspA = y.gmv / y.items;
          volumeEffect = (y.items - x.items) * (aspB + aspA) / 2;
          priceEffect = (aspA - aspB) * (x.items + y.items) / 2;
        } else if (x.items > 0) type = GROWTH_TYPES.lapsed;
        else type = month(first.get(store + '|' + psku) || '') === after ? GROWTH_TYPES.first : GROWTH_TYPES.reactivated;
        rows.push({ psku, x, y, delta, type, volumeEffect, priceEffect });
      }
      const scale = daysInMonth(after) / daysInMonth(before);
      for (const r of rows) out.contributions.push(base(store, after + '-01', {
        period: `${before} → ${after}`, psku: r.psku, title: title(store, r.psku), type: r.type, firstSale: first.get(store + '|' + r.psku) ?? null,
        gmvBefore: r.x.gmv, gmvAfter: r.y.gmv, gmvDelta: r.delta, gmvBeforeScaled: r.x.gmv * scale,
        itemsBefore: r.x.items, itemsAfter: r.y.items, volumeEffect: r.volumeEffect, priceEffect: r.priceEffect,
        shareOfNet: total ? r.delta / total : 0
      }));
    }
    // ---- milestones ----
    if (!valid.length) continue;
    const anyOrder = all.map(r => day(r.time)).sort()[0];
    const firstValid = valid.map(r => day(r.time)).sort()[0];
    const lastDay = addDays(cutoff, -1);
    const perDay = new Map();
    for (const r of valid) { const d = day(r.time); perDay.set(d, (perDay.get(d) || 0) + 1); }
    const nodes = { anyOrder, firstValid };
    let cum = 0; const window = [];
    for (let d = firstValid; d <= lastDay; d = addDays(d, 1)) {
      const n = perDay.get(d) || 0; cum += n; window.push(n > 0 ? 1 : 0); if (window.length > 7) window.shift();
      for (const [k, t] of [['cum10', 10], ['cum50', 50], ['cum100', 100]]) if (!nodes[k] && cum >= t) nodes[k] = d;
      if (window.length === 7) { const selling = window.reduce((s, v) => s + v, 0); for (const [k, t] of [['week5', 5], ['week7', 7]]) if (!nodes[k] && selling >= t) nodes[k] = d; }
    }
    for (const [k, label] of MILESTONES) if (nodes[k]) out.milestones.push(base(store, nodes[k], { type: label }));
    // ---- complete 28-day launch windows from the first valid sale ----
    const storeAds = ads.filter(r => r.store === store && day(r.time) < cutoff);
    for (let k = 0; ; k++) {
      const from = addDays(firstValid, 28 * k), to = addDays(from, 28);
      if (to > cutoff) break;
      const inWindow = valid.filter(r => day(r.time) >= from && day(r.time) < to);
      const adRows = storeAds.filter(r => day(r.time) >= from && day(r.time) < to);
      const byPsku = new Map();
      for (const r of inWindow) { const c = byPsku.get(r.psku) || { sales: 0, items: 0 }; c.sales += r.price; c.items++; byPsku.set(r.psku, c); }
      const sales = inWindow.reduce((s, r) => s + r.price, 0);
      const top3 = [...byPsku.values()].map(c => c.sales).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
      const label = `第${k + 1}段28天`, period = `${from}～${addDays(to, -1)}`;
      out.launch.push(base(store, from, {
        type: label, period, sales, items: inWindow.length, products: byPsku.size, days: new Set(inWindow.map(r => day(r.time))).size,
        spend: adRows.reduce((s, r) => s + r.spends, 0), revenue: adRows.reduce((s, r) => s + r.revenue, 0), adOrders: adRows.reduce((s, r) => s + r.orders, 0), top3
      }));
      for (const [psku, c] of byPsku) out.launchProducts.push(base(store, from, { type: label, period, psku, title: title(store, psku), firstSale: first.get(store + '|' + psku) ?? null, sales: c.sales, items: c.items }));
    }
  }
  return out;
}

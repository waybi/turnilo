#!/usr/bin/env node
// 把 data-center MySQL 里「大兵一号店(113) / 大兵2号店(112)」的数据导出成 Turnilo 可读的 JSON-lines 文件。
// 内部核心导出，由 node dc/sync-all.mjs 创建版本目录后调用；完成后 node dc/start.mjs 加载。
//
// 规则：
// - 只导出 uid/cid in (112,113)，其他账号一律不导。
// - 广告搜索词 ad_search_queries：Noon 报表按「某日~某日」整段抓取，同一时间段被抓了多次。
//   每家店按 end_date 从新到旧挑选，和已选报表期有重叠的就跳过 → 得到互不重叠的最新报表期，花费可直接加总。
//   所有搜索词都保留（包括没点击的），不做删减。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { pickWindows } from "./sync-helpers.mjs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.DC_EXPORT_OUT || join(HERE, "data"));
if (!OUT.startsWith(join(HERE, "data") + "/")) throw new Error("Use sync-all.mjs: export destination must be a new version under dc/data/");
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const exportsMeta = [];
const SVC_BASE = "/Users/waybi/Desktop/my/copy/data-center/data-center/svc_base";
const STORES = "112,113";
const STORE_NAME = `CASE %s WHEN 113 THEN '1号店' WHEN 112 THEN '2号店' END`;

function readDbConfig() {
  const c = yaml.safeLoad(readFileSync(join(SVC_BASE, "etc/dev.yaml"), "utf8")).mysql;
  if (!["127.0.0.1", "localhost", "::1"].includes(c.host)) throw new Error("Only local MySQL permitted");
  return { host: c.host, port: String(c.port), user: c.username, password: c.password, db: c.name };
}
const DB = readDbConfig();

function query(sql) {
  const out = execFileSync("/usr/local/mysql/bin/mysql", ["--protocol=TCP", "-h", DB.host, "-P", DB.port, "-u", DB.user, DB.db, "-N", "-B", "--raw", "-e", `SET SESSION MAX_EXECUTION_TIME=180000; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION READ ONLY; ${sql}; ROLLBACK;`], {
    env: { ...process.env, MYSQL_PWD: DB.password },
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 200000
  });
  return out.toString("utf8").split("\n").filter(Boolean);
}

// 每行 SELECT JSON_OBJECT(...)，MySQL 自己负责转义，输出就是 JSON-lines
function exportCube(name, sql) {
  const [expectedRaw, ...lines] = query(`SELECT COUNT(*) FROM (${sql}) counted; ${sql}`);
  const expectedRows = Number(expectedRaw);
  if (lines.length !== expectedRows) throw new Error(`source/export mismatch: ${name}`);
  mkdirSync(OUT, { recursive: true });
  const target = join(OUT, `${name}.json`);
  writeFileSync(target, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600, flag: "wx" });
  exportsMeta.push({ name, rows: lines.length, expectedRows, sql });
  console.log(`${name}: ${lines.length} 行`);
  return lines.length;
}

// ---------- 1. 广告搜索词：挑互不重叠的最新报表期 ----------
const windows = query(`SELECT uid, start_date, end_date FROM ad_search_queries
  WHERE uid IN (${STORES}) GROUP BY uid, start_date, end_date ORDER BY uid, end_date DESC, start_date DESC`)
  .map(l => { const [uid, s, e] = l.split("\t"); return { uid, s, e }; });
const picked = pickWindows(windows);
console.log("搜索词选用报表期：");
for (const p of picked) console.log(`  ${p.uid === "113" ? "1号店" : "2号店"}  ${p.s} ~ ${p.e}`);
const windowCond = picked.map(p => `(q.uid=${p.uid} AND q.start_date='${p.s}' AND q.end_date='${p.e}')`).join(" OR ") || "FALSE";

exportCube("search_queries", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(q.start_date, '%Y-%m-%dT00:00:00Z'),
  'store', ${STORE_NAME.replace("%s", "q.uid")},
  'period', CONCAT(DATE_FORMAT(q.start_date,'%m-%d'), '~', DATE_FORMAT(q.end_date,'%m-%d')),
  'campaign', q.campaign_code,
  'campaignName', COALESCE(a.title, q.campaign_code),
  'campaignStatus', COALESCE(a.status, '未知'),
  'campaignBudget', a.budget,
  'adgroup', q.adgroup_code,
  'targeting', q.targeting_type,
  'query', q.query,
  'queryCn', NULLIF(q.query_cn, ''),
  'pushedNegative', IF(q.pushed_negative=1, '已否定', '未否定'),
  'hasClick', IF(q.clicks>0, '有点击', '无点击'),
  'hasOrder', IF(q.orders>0, '有订单', '无订单'),
  'views', q.views, 'clicks', q.clicks, 'orders', q.orders, 'atc', q.atc,
  'spends', q.spends, 'revenue', q.revenue, 'bid', q.bid, 'effectiveBid', q.effective_bid)
FROM ad_search_queries q
LEFT JOIN ads a ON a.uid = q.uid AND a.country = q.country AND a.campaign_code = q.campaign_code
WHERE q.uid IN (${STORES}) AND (${windowCond})`);

// ---------- 2. 广告日报 ----------
exportCube("ad_daily", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(m.date, '%Y-%m-%dT00:00:00Z'),
  'store', ${STORE_NAME.replace("%s", "m.uid")},
  'campaign', m.campaign_code,
  'campaignName', COALESCE(a.title, m.campaign_code),
  'targeting', a.targeting_type,
  'campaignStatus', COALESCE(a.status, '未知'),
  'campaignBudget', a.budget,
  'views', m.views, 'clicks', m.clicks, 'orders', m.orders, 'atc', m.atc,
  'spends', m.spends, 'revenue', m.revenue)
FROM ad_daily_metrics m
LEFT JOIN ads a ON a.uid = m.uid AND a.country = m.country AND a.campaign_code = m.campaign_code
WHERE m.uid IN (${STORES})`);

// ---------- 2b. 广告商品 ad_skus ----------
// 该表没有日期：svc_base SyncAdList 每次拉「最近 1 个月」(util.BeforeMonth(1)~今天) 的 SKU 汇总后覆盖写入
// (usercase_ad.go:205,258-307)。所以用 updated_at 往前推 1 个月作为统计区间。店铺经 ads.adgroup_code 关联。
exportCube("ad_skus", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(DATE_SUB(DATE(s.updated_at), INTERVAL 1 MONTH), '%Y-%m-%dT00:00:00Z'),
  'store', ${STORE_NAME.replace("%s", "a.uid")},
  'window', CONCAT(DATE_FORMAT(DATE_SUB(DATE(s.updated_at), INTERVAL 1 MONTH), '%m-%d'), '~', DATE_FORMAT(s.updated_at, '%m-%d')),
  'campaign', a.campaign_code,
  'campaignName', COALESCE(a.title, a.campaign_code),
  'campaignStatus', COALESCE(a.status, '未知'),
  'adgroup', s.adgroup_code,
  'sku', s.sku, 'skuName', s.name,
  'hasOrder', IF(s.orders>0, '有订单', '无订单'),
  'views', s.views, 'clicks', s.click, 'orders', s.orders, 'atc', s.atc,
  'spends', s.spends, 'revenue', s.revenue)
FROM ad_skus s
JOIN (SELECT adgroup_code, MAX(uid) uid, MAX(campaign_code) campaign_code, MAX(title) title, MAX(status) status
      FROM ads WHERE uid IN (${STORES}) GROUP BY adgroup_code) a ON a.adgroup_code = s.adgroup_code`);

// ---------- 3. 订单 ----------
exportCube("orders", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(o.order_date, '%Y-%m-%dT%H:%i:%sZ'),
  'store', ${STORE_NAME.replace("%s", "o.uid")},
  'orderNr', o.order_nr, 'sku', o.sku, 'psku', o.psku,
  'status', o.status, 'fulfillment', o.fulfillment_model,
  'price', o.base_price, 'fees', o.total_fees)
FROM orders o WHERE o.uid IN (${STORES})`);

// ---------- 4. 到账明细 ----------
exportCube("transactions", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(t.transaction_date, '%Y-%m-%dT00:00:00Z'),
  'store', ${STORE_NAME.replace("%s", "t.uid")},
  'orderNr', t.order_nr, 'type', t.transaction_type,
  'netProceeds', t.net_proceeds, 'referralFee', t.referral_fee, 'referralFeeVat', t.referral_fee_vat,
  'fbnFee', t.fbn_outbound_fee, 'fbnFeeVat', t.fbn_outbound_fee_vat,
  'otherFees', t.other_fees, 'totalFees', t.total_fees, 'subtotal', t.subtotal)
FROM order_transactions t WHERE t.uid IN (${STORES})`);

// ---------- 5. 商品每日快照 ----------
exportCube("catalog", `SELECT JSON_OBJECT(
  'time', DATE_FORMAT(c.snapshot_date, '%Y-%m-%dT00:00:00Z'),
  'store', ${STORE_NAME.replace("%s", "c.cid")},
  'sku', c.sku, 'psku', c.psku, 'title', c.title, 'brand', c.brand_code, 'family', c.family,
  'liveStatus', c.live_status, 'buybox', IF(c.is_winning_buybox=1, '拿到购物车', '没拿到'),
  'price', c.price, 'gvs', c.gvs, 'unitsSold', c.units_sold, 'gmv', c.gmv,
  'fbnStock', c.fbn_stock, 'fbpStock', c.fbp_stock)
FROM sku_catalog_metrics c WHERE c.cid IN (${STORES})`);

// ---------- 合并：广告分析（日报 + 搜索词 + 商品 三层合一） ----------
// 每行加 level 字段标明来自哪一层；配置里每个指标只对自己那一层求和，避免三层互相重复计算。
{
  const parts = [["daily", "ad_daily"], ["query", "search_queries"], ["sku", "ad_skus"]];
  const rows = [];
  const allKeys = new Set();
  for (const [level, file] of parts) {
    for (const line of readFileSync(join(OUT, `${file}.json`), "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      row.level = level;
      if (level === "daily") row.reportWindow = "每日";
      if (level === "query") row.reportWindow = row.period;
      if (level === "sku") row.reportWindow = row.window;
      Object.keys(row).forEach(k => allKeys.add(k));
      rows.push(row);
    }
  }
  // Turnilo 只按文件开头的行推断有哪些列。日报排在最前、没有 skuName/query 等字段，
  // 会导致查询报 "could not resolve $skuName"（HTTP 500）。所以每行补齐全部字段：数值填 0，文本填 null。
  const NUMERIC = new Set(["views", "clicks", "orders", "atc", "spends", "revenue"]);
  const out = rows.map(r => {
    const full = {};
    for (const k of allKeys) full[k] = k in r ? r[k] : (NUMERIC.has(k) ? 0 : null);
    return JSON.stringify(full);
  });
  writeFileSync(join(OUT, "ads_all.json"), out.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  exportsMeta.push({ name: "ads_all", rows: out.length, derivedFrom: parts.map(p => p[1]) });
  console.log(`ads_all（合并）: ${out.length} 行`);
}

writeFileSync(join(OUT, "_export_meta.json"), JSON.stringify({ exportedAt: new Date().toISOString(), stores: [112,113], searchQueryWindows: picked, datasets: exportsMeta }, null, 2), { mode: 0o600, flag: "wx" });
console.log("导出完成 →", OUT);

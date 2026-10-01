#!/usr/bin/env node
// Build one cross-dataset "总览" cube from an existing versioned run.
// Derived only: reads the run's exported JSON files, never touches MySQL or Noon.
// Used by sync-all.mjs on every export; can also be run alone to add the cube to the latest run.
import { createReadStream, createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { assertOwnedRow } from './sync-helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Every row carries every field (0 / null) so Turnilo's first-rows type inference never misses a column.
const NUMERIC = ['price','fee','netProceeds','totalDue','spend','revenue','adOrders','unitsSold','fbnStock','fbpStock','airQty','seaQty','units','freight','itemsSold','sold','sourceRows'];
const TEXT = ['status','type','entity','orderNr','sku','psku','campaign','campaignName','country'];
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;

// file name -> (sub-view cube name, 数据集标题, field mapping). search_windows_* (1.9M rows) and the
// ad_skus/search_queries layers are left to their own cubes; the overview takes the daily ad layer only.
const SOURCES = {
  orders:             { cube:'orders',             title:'订单',           map:r=>({status:r.status,type:r.fulfillment,entity:r.orderNr,orderNr:r.orderNr,sku:r.sku,psku:r.psku,price:r.price,fee:r.fees}) },
  transactions:       { cube:'transactions',       title:'到账明细',       map:r=>({type:r.type,entity:r.orderNr,orderNr:r.orderNr,netProceeds:r.netProceeds,fee:r.totalFees,totalDue:r.subtotal}) },
  statements:         { cube:'statements',         title:'结算账单',       map:r=>({type:r.type,entity:r.reference,country:r.country,netProceeds:r.netProceeds,fee:r.fees,totalDue:r.totalDue}) },
  ad_daily:           { cube:'ads',                title:'广告日报',       map:r=>({status:r.campaignStatus,type:r.targeting,entity:r.campaign,campaign:r.campaign,campaignName:r.campaignName,spend:r.spends,revenue:r.revenue,adOrders:r.orders}) },
  catalog:            { cube:'catalog',             title:'商品每日快照',   map:r=>({status:String(r.liveStatus),type:r.buybox,entity:r.sku,sku:r.sku,psku:r.psku,price:r.price,unitsSold:r.unitsSold,fbnStock:r.fbnStock,fbpStock:r.fbpStock}) },
  inventory:          { cube:'inventory',           title:'商品与当前库存', map:r=>({status:r.liveStatus,type:r.shippingMode,entity:r.sku,sku:r.sku,psku:r.psku,country:r.country,price:r.price,fbnStock:r.fbnStock,fbpStock:r.fbpStock}) },
  campaigns:          { cube:'campaigns',           title:'广告活动当前状态',map:r=>({status:r.status,type:r.targeting,entity:r.campaign,campaign:r.campaign,campaignName:r.title,country:r.country,spend:0}) },
  procurement:        { cube:'procurement',         title:'补货计划',       map:r=>({status:r.status,entity:r.psku,psku:r.psku,country:r.country,fbnStock:r.fbnStock,airQty:r.airQty,seaQty:r.seaQty}) },
  purchases:          { cube:'purchases',           title:'采购批次',       map:r=>({type:r.express,entity:r.batchId,country:r.country,units:r.units,freight:r.freight}) },
  purchase_items:     { cube:'purchase_items',      title:'采购商品明细',   map:r=>({entity:r.batchId,sku:r.sku,country:r.country,units:r.units}) },
  promotions:         { cube:'promotions',          title:'促销活动',       map:r=>({status:r.status,type:r.type,entity:r.dealId,country:r.country,itemsSold:r.itemsSold}) },
  coupons:            { cube:'coupons',             title:'优惠券',         map:r=>({status:r.status,type:r.type,entity:r.couponId,country:r.country}) },
  deal_items:         { cube:'deal_items',          title:'促销商品',       map:r=>({status:r.skuStatus,type:r.status,entity:r.dealId,psku:r.psku,country:r.country}) },
  competitors:        { cube:'competitors',         title:'已绑定竞品',     map:r=>({status:r.live,entity:r.competitorSku,psku:r.psku,country:r.country,price:r.price,sold:r.sold}) },
  competitor_history: { cube:'competitor_history',  title:'竞品历史快照',   map:r=>({status:r.live,entity:r.competitorSku,psku:r.psku,price:r.price,sold:r.sold}) },
  freight_settings:   { cube:'freight_settings',    title:'运输成本参数',   map:r=>({entity:r.storeId}) },
  sync_runs:          { cube:'sync_runs',           title:'数据同步运行记录',map:r=>({status:r.status,type:r.task,entity:r.execution,country:r.country,sourceRows:r.sourceRows}) }
};

const ds = t => `$dataset == '${t}'`;
const m = (name, title, formula, format='0,0.00') => ({ name, title, formula, format });
function measures() {
  return [
    m('count','记录数','$main.count()','0,0'),
    { name:'g_orders', title:'订单', measures:[
      m('o_count','订单 · 商品条目',`$main.filter(${ds('订单')}).count()`,'0,0'),
      m('o_sales','订单 · 金额（含全部状态）',`$main.filter(${ds('订单')}).sum($price)`),
      m('o_delivered','订单 · 已送达金额',`$main.filter(${ds('订单')} and $status == 'Delivered').sum($price)`),
      m('o_returnRate','订单 · 退货率 CIR/(Delivered+CIR)',`$main.filter(${ds('订单')} and $status == 'CIR').count() / $main.filter(${ds('订单')} and ($status == 'CIR' or $status == 'Delivered')).count()`,'0.00%')
    ]},
    { name:'g_tx', title:'到账明细', measures:[
      m('t_net','到账 · 净收入',`$main.filter(${ds('到账明细')}).sum($netProceeds)`),
      m('t_fees','到账 · 总扣费',`$main.filter(${ds('到账明细')}).sum($fee)`),
      m('t_subtotal','到账 · 小计',`$main.filter(${ds('到账明细')}).sum($totalDue)`)
    ]},
    { name:'g_stmt', title:'结算账单（先选交易类型）', measures:[
      m('s_due','账单 · 应付合计',`$main.filter(${ds('结算账单')}).sum($totalDue)`),
      m('s_net','账单 · 净收入',`$main.filter(${ds('结算账单')}).sum($netProceeds)`),
      m('s_fees','账单 · 费用',`$main.filter(${ds('结算账单')}).sum($fee)`)
    ]},
    { name:'g_ads', title:'广告日报', measures:[
      m('a_spend','广告 · 花费',`$main.filter(${ds('广告日报')}).sum($spend)`),
      m('a_revenue','广告 · 广告销售额',`$main.filter(${ds('广告日报')}).sum($revenue)`),
      m('a_orders','广告 · 订单',`$main.filter(${ds('广告日报')}).sum($adOrders)`,'0,0'),
      m('a_roas','广告 · ROAS',`$main.filter(${ds('广告日报')}).sum($revenue) / $main.filter(${ds('广告日报')}).sum($spend)`)
    ]},
    { name:'g_catalog', title:'商品每日快照（只按单日看）', measures:[
      m('c_units','快照 · 销量（勿跨天相加）',`$main.filter(${ds('商品每日快照')}).sum($unitsSold)`,'0,0'),
      m('c_avgPrice','快照 · 平均价格',`$main.filter(${ds('商品每日快照')}).average($price)`),
      m('c_skus','快照 · 商品数',`$main.filter(${ds('商品每日快照')}).countDistinct($sku)`,'0,0')
    ]},
    { name:'g_inv', title:'当前库存', measures:[
      m('i_fbn','库存 · FBN',`$main.filter(${ds('商品与当前库存')}).sum($fbnStock)`,'0,0'),
      m('i_fbp','库存 · FBP',`$main.filter(${ds('商品与当前库存')}).sum($fbpStock)`,'0,0')
    ]},
    { name:'g_proc', title:'补货与采购', measures:[
      m('p_air','补货 · 建议空运数（不与海运相加）',`$main.filter(${ds('补货计划')}).sum($airQty)`,'0,0'),
      m('p_sea','补货 · 建议海运数',`$main.filter(${ds('补货计划')}).sum($seaQty)`,'0,0'),
      m('b_units','采购批次 · 采购数',`$main.filter(${ds('采购批次')}).sum($units)`,'0,0'),
      m('b_freight','采购批次 · 运费',`$main.filter(${ds('采购批次')}).sum($freight)`),
      m('bi_units','采购明细 · 商品数',`$main.filter(${ds('采购商品明细')}).sum($units)`,'0,0')
    ]},
    { name:'g_other', title:'促销 / 竞品 / 同步', measures:[
      m('d_sold','促销活动 · 活动销量',`$main.filter(${ds('促销活动')}).sum($itemsSold)`,'0,0'),
      m('k_price','竞品 · 平均价格',`$main.filter(${ds('已绑定竞品')} or ${ds('竞品历史快照')}).average($price)`),
      m('k_sold','竞品 · 平均销量提示',`$main.filter(${ds('已绑定竞品')} or ${ds('竞品历史快照')}).average($sold)`,'0,0.0'),
      m('r_source','同步 · 来源处理行数',`$main.filter(${ds('数据同步运行记录')}).sum($sourceRows)`,'0,0')
    ]}
  ];
}

function dimensions() {
  return [
    { name:'time', title:'日期', kind:'time', formula:'$time', description:'订单/到账/账单=业务日期；广告日报=当天；快照与清单=更新/采集时间；补货=计划日；采购=采购日' },
    { name:'store', title:'店铺', formula:'$store' },
    { name:'dataset', title:'数据集（子视图）', formula:'$dataset', description:'先拖这个维度拆开，再看各组指标；每组指标只对自己的数据集生效' },
    { name:'status', title:'状态', formula:'$status', description:'订单状态 / 活动状态 / 上架状态 / 同步步骤状态，含义随数据集不同' },
    { name:'type', title:'类型', formula:'$type', description:'发货方式 / 交易类型 / 单据类型 / 投放方式 / 任务名' },
    { name:'entity', title:'主体编号', formula:'$entity', description:'订单号 / 账单号 / 活动编码 / 批次 / 执行ID 等' },
    { name:'orderNr', title:'订单号', formula:'$orderNr' },
    { name:'sku', title:'SKU', formula:'$sku' },
    { name:'psku', title:'商家SKU', formula:'$psku' },
    { name:'campaign', title:'广告活动编码', formula:'$campaign' },
    { name:'campaignName', title:'广告活动名称', formula:'$campaignName' },
    { name:'country', title:'站点', formula:'$country' }
  ];
}

function description(run, cubes) {
  const byName = Object.fromEntries(cubes.map(c => [c.name, c]));
  const links = Object.entries(SOURCES).map(([file, s]) => `[${s.title}](#${s.cube})`).join('、');
  return `两店 17 个数据集合在一张表里，用「数据集（子视图）」维度拆开看。每组指标只计算自己的数据集，不会互相串加；**不同数据集的金额不要相加**（订单金额、到账、账单是同一笔生意的不同环节）。

未并入：搜索词全部窗口（约 191 万行，重叠报表期）、广告搜索词/商品层——请到各自子视图看。快照类（商品每日快照、库存、竞品）跨天求和没有意义。

子视图直达：${links}、[1号店搜索词全部窗口](#search_windows_113)、[2号店搜索词全部窗口](#search_windows_112)。数据版本 ${run}。`;
}

export async function buildOverview({ runDir, run, manifest, cubes }) {
  const target = join(runDir, 'overview.json');
  const file = createWriteStream(target, { mode:0o600, flags:'wx' });
  const stats = { name:'overview', title:'总览（跨视图）', derivedFrom:Object.keys(SOURCES), rows:0, byStore:{}, byDataset:{}, minTime:null, maxTime:null, numericTotals:{} };
  const hash = createHash('sha256');
  for (const [fileName, s] of Object.entries(SOURCES)) {
    const src = join(runDir, fileName + '.json');
    if (!existsSync(src)) throw new Error('Overview source missing: ' + src);
    const expected = manifest.datasets.find(d => d.name === fileName);
    if (!expected) throw new Error('No manifest entry for ' + fileName);
    let n = 0;
    for await (const line of createInterface({ input:createReadStream(src), crlfDelay:Infinity })) {
      if (!line) continue;
      const r = JSON.parse(line);
      const mapped = s.map(r);
      const row = { time:r.time, store:r.store, storeId:String(r.storeId ?? (r.store === '1号店' ? 113 : 112)), dataset:s.title };
      for (const k of TEXT) row[k] = mapped[k] == null || mapped[k] === '' ? null : String(mapped[k]);
      for (const k of NUMERIC) row[k] = num(mapped[k]);
      assertOwnedRow(row);
      const out = JSON.stringify(row);
      hash.update(out + '\n');
      stats.rows++; n++;
      stats.byStore[row.store] = (stats.byStore[row.store] || 0) + 1;
      stats.byDataset[s.title] = (stats.byDataset[s.title] || 0) + 1;
      if (!stats.minTime || row.time < stats.minTime) stats.minTime = row.time;
      if (!stats.maxTime || row.time > stats.maxTime) stats.maxTime = row.time;
      for (const k of NUMERIC) stats.numericTotals[k] = (stats.numericTotals[k] || 0) + row[k];
      if (!file.write(out + '\n')) await once(file, 'drain');
    }
    if (n !== expected.rows) throw new Error(`Overview row mismatch for ${fileName}: ${n} != ${expected.rows}`);
  }
  file.end(); await once(file, 'finish');
  stats.sha256 = hash.digest('hex');
  const cube = {
    name:'overview', title:'总览（跨视图）', description:description(run, cubes),
    clusterName:'native', source:`data/runs/${run}/overview.json`, timeAttribute:'time',
    defaultDuration:'P1Y', defaultSortMeasure:'count', defaultSelectedMeasures:['count'],
    defaultPinnedDimensions:['dataset','store'], introspection:'no-autofill', maxSplits:4,
    dimensions:dimensions(), measures:measures()
  };
  return { cube, stats };
}

// CLI: add the overview cube to the latest run without re-exporting anything.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const latestPath = join(HERE, 'data', 'latest-run.json');
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(latest.manifestPath, 'utf8'));
  const config = yaml.safeLoad(readFileSync(latest.configPath, 'utf8'));
  if (config.dataCubes.some(c => c.name === 'overview')) throw new Error('Latest run already has an overview cube');
  const runDir = dirname(latest.manifestPath);
  const { cube, stats } = await buildOverview({ runDir, run:latest.run, manifest, cubes:config.dataCubes });
  const configPath = join(HERE, `config.${latest.run}-overview.yaml`);
  writeFileSync(configPath, yaml.safeDump({ ...config, dataCubes:[cube, ...config.dataCubes] }, { lineWidth:140, noRefs:true }), { mode:0o600, flag:'wx' });
  manifest.datasets.push(stats);
  manifest.cubes = [{ name:cube.name, title:cube.title, source:cube.source }, ...(manifest.cubes || [])];
  manifest.configPath = configPath;
  manifest.overviewAddedAt = new Date().toISOString();
  writeFileSync(latest.manifestPath, JSON.stringify(manifest, null, 2), { mode:0o600 });
  writeFileSync(latestPath, JSON.stringify({ ...latest, configPath }, null, 2), { mode:0o600 });
  console.log(`overview: ${stats.rows} rows ${JSON.stringify(stats.byStore)}\n${JSON.stringify(stats.byDataset)}\nREADY ${configPath}`);
}

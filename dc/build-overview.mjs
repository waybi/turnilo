#!/usr/bin/env node
// Build one cross-dataset "总览" cube from an existing versioned run.
// Derived only: reads the run's exported JSON files, never touches MySQL or Noon.
// Used by sync-all.mjs on every export; can also be run alone to add the cube to the latest run.
// Rule (2026-10-02): the overview is the only front-end entry; analysis layers are added here as
// extra datasets/dimensions/measures instead of separate cubes.
import { createReadStream, createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { assertOwnedRow } from './sync-helpers.mjs';
import { deriveLayers, readJsonl, DERIVED_TITLES, GROWTH_TYPES, INVALID_STATUSES } from './overview-derived.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Every row carries every field (0 / null) so Turnilo's first-rows type inference never misses a column.
// Text fields must be null when absent: Plywood types '' as NUMBER and then string filters fail.
const NUMERIC = ['price','fee','netProceeds','totalDue','spend','revenue','adOrders','unitsSold','fbnStock','fbpStock','airQty','seaQty','units','freight','itemsSold','sold','sourceRows',
  'gmvBefore','gmvAfter','gmvDelta','gmvBeforeScaled','itemsBefore','itemsAfter','volumeEffect','priceEffect','shareOfNet','sales','items','products','days','top3'];
const TEXT = ['status','type','entity','orderNr','sku','psku','title','campaign','campaignName','country','period','firstSale','event'];
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;

// file name -> (sub-view cube name, 数据集标题, field mapping). search_windows_* (1.9M rows) and the
// ad_skus/search_queries layers are left to their own cubes; the overview takes the daily ad layer only.
const SOURCES = {
  orders:             { cube:'orders',             title:'订单',           map:r=>({status:r.status,type:r.fulfillment,entity:r.orderNr,orderNr:r.orderNr,sku:r.sku,psku:r.psku,price:r.price,fee:r.fees}) },
  transactions:       { cube:'transactions',       title:'到账明细',       map:r=>({type:r.type,entity:r.orderNr,orderNr:r.orderNr,netProceeds:r.netProceeds,fee:r.totalFees,totalDue:r.subtotal}) },
  statements:         { cube:'statements',         title:'结算账单',       map:r=>({type:r.type,entity:r.reference,country:r.country,netProceeds:r.netProceeds,fee:r.fees,totalDue:r.totalDue}) },
  ad_daily:           { cube:'ads',                title:'广告日报',       map:r=>({status:r.campaignStatus,type:r.targeting,entity:r.campaign,campaign:r.campaign,campaignName:r.campaignName,spend:r.spends,revenue:r.revenue,adOrders:r.orders}) },
  ad_skus:            { cube:'ads',                title:'广告商品关联（当前）', map:r=>({status:r.campaignStatus,entity:r.adgroup,sku:r.sku,title:r.skuName,campaign:r.campaign,campaignName:r.campaignName,period:r.window}) },
  catalog:            { cube:'catalog',             title:'商品每日快照',   map:r=>({status:String(r.liveStatus),type:r.buybox,entity:r.sku,sku:r.sku,psku:r.psku,title:r.title,price:r.price,unitsSold:r.unitsSold,fbnStock:r.fbnStock,fbpStock:r.fbpStock}) },
  inventory:          { cube:'inventory',           title:'商品与当前库存', map:r=>({status:r.liveStatus,type:r.shippingMode,entity:r.sku,sku:r.sku,psku:r.psku,title:r.title,country:r.country,price:r.price,fbnStock:r.fbnStock,fbpStock:r.fbpStock}) },
  campaigns:          { cube:'campaigns',           title:'广告活动当前状态',map:r=>({status:r.status,type:r.targeting,entity:r.campaign,campaign:r.campaign,campaignName:r.title,country:r.country,spend:0}) },
  procurement:        { cube:'procurement',         title:'补货计划',       map:r=>({status:r.status,entity:r.psku,psku:r.psku,title:r.title,country:r.country,fbnStock:r.fbnStock,airQty:r.airQty,seaQty:r.seaQty}) },
  purchases:          { cube:'purchases',           title:'采购批次',       map:r=>({type:r.express,entity:r.batchId,country:r.country,units:r.units,freight:r.freight,event:r.fbnDate?'送仓 '+r.fbnDate:'送仓未记录',period:r.listingDate?'上架 '+r.listingDate:'上架日未记录'}) },
  purchase_items:     { cube:'purchase_items',      title:'采购商品明细',   map:r=>({entity:r.batchId,sku:r.sku,psku:r.sku,country:r.country,units:r.units}) },
  promotions:         { cube:'promotions',          title:'促销活动',       map:r=>({status:r.status,type:r.type,entity:r.dealId,title:r.title,country:r.country,itemsSold:r.itemsSold}) },
  coupons:            { cube:'coupons',             title:'优惠券',         map:r=>({status:r.status,type:r.type,entity:r.couponId,title:r.title,country:r.country}) },
  deal_items:         { cube:'deal_items',          title:'促销商品',       map:r=>({status:r.skuStatus,type:r.status,entity:r.dealId,psku:r.psku,title:r.title,country:r.country}) },
  competitors:        { cube:'competitors',         title:'已绑定竞品',     map:r=>({status:r.live,entity:r.competitorSku,psku:r.psku,country:r.country,price:r.price,sold:r.sold}) },
  competitor_history: { cube:'competitor_history',  title:'竞品历史快照',   map:r=>({status:r.live,entity:r.competitorSku,psku:r.psku,price:r.price,sold:r.sold}) },
  freight_settings:   { cube:'freight_settings',    title:'运输成本参数',   map:r=>({entity:r.storeId}) },
  sync_runs:          { cube:'sync_runs',           title:'数据同步运行记录',map:r=>({status:r.status,type:r.task,entity:r.execution,event:r.step,country:r.country,sourceRows:r.sourceRows}) }
};
// Analysis layers computed from the run's own orders / ad_daily / inventory files (see overview-derived.mjs).
const DERIVED = {
  contributions:  { title:DERIVED_TITLES.contributions,  map:r=>({type:r.type,period:r.period,psku:r.psku,title:r.title,firstSale:r.firstSale,gmvBefore:r.gmvBefore,gmvAfter:r.gmvAfter,gmvDelta:r.gmvDelta,gmvBeforeScaled:r.gmvBeforeScaled,itemsBefore:r.itemsBefore,itemsAfter:r.itemsAfter,volumeEffect:r.volumeEffect,priceEffect:r.priceEffect,shareOfNet:r.shareOfNet}) },
  milestones:     { title:DERIVED_TITLES.milestones,     map:r=>({type:r.type,event:r.type}) },
  launch:         { title:DERIVED_TITLES.launch,         map:r=>({type:r.type,period:r.period,sales:r.sales,items:r.items,products:r.products,days:r.days,spend:r.spend,revenue:r.revenue,adOrders:r.adOrders,top3:r.top3}) },
  launchProducts: { title:DERIVED_TITLES.launchProducts, map:r=>({type:r.type,period:r.period,psku:r.psku,title:r.title,firstSale:r.firstSale,sales:r.sales,items:r.items}) }
};

const ds = t => `$dataset == '${t}'`;
const VALID = [...INVALID_STATUSES].map(s => `$status != '${s}'`).join(' and ');
const ORDERS = `$main.filter(${ds('订单')})`, VALID_ORDERS = `$main.filter(${ds('订单')} and ${VALID})`;
const ADS = `$main.filter(${ds('广告日报')})`;
const m = (name, title, formula, format='0,0.00', description) => ({ name, title, formula, format, ...(description ? { description } : {}) });
const EFFECTIVE = '剔除 CIR（客户退货）、Could Not Be Delivered（没送到）、Cancelled（已取消）后的订单商品行；在途的也算。';
function measures() {
  return [
    m('count','记录数','$main.count()','0,0','当前筛选下所有数据集的记录行数；不同数据集一行代表不同东西，先按“数据集”拆开再看业务指标。'),
    { name:'g_orders', title:'订单', measures:[
      m('o_count','订单 · 商品条目',`${ORDERS}.count()`,'0,0'),
      m('o_sales','订单 · 金额（含全部状态）',`${ORDERS}.sum($price)`),
      m('o_valid_sales','订单 · 有效销售额',`${VALID_ORDERS}.sum($price)`,'0,0.00',`有效销售额（SAR）= ${EFFECTIVE}是售价合计，不是利润。复盘报告里的“销售额/GMV”就是它。`),
      m('o_valid_items','订单 · 有效商品条目',`${VALID_ORDERS}.count()`,'0,0',`有效商品条目 = ${EFFECTIVE}一行=一个 item_nr，不是结账订单数。`),
      m('o_valid_asp','订单 · 有效条目均价',`${VALID_ORDERS}.sum($price) / ${VALID_ORDERS}.count()`,'0,0.00','有效销售额 ÷ 有效商品条目；是每件均价，不是客单价。'),
      m('o_selling_pskus','订单 · 出单商品数（PSKU）',`${VALID_ORDERS}.countDistinct($psku)`,'0,0','当前筛选范围内有过有效成交的不同商家SKU数；按月拆开就是“当月出单商品数”，跨期不要相加。'),
      m('o_selling_days','订单 · 有成交天数',`${VALID_ORDERS}.countDistinct($time.timeFloor('P1D','Etc/UTC'))`,'0,0','当前筛选范围内至少有 1 件有效成交的天数（按原始日）。'),
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
      m('a_spend','广告 · 花费',`${ADS}.sum($spend)`),
      m('a_revenue','广告 · 广告销售额',`${ADS}.sum($revenue)`),
      m('a_orders','广告 · 订单',`${ADS}.sum($adOrders)`,'0,0'),
      m('a_roas','广告 · ROAS',`${ADS}.sum($revenue) / ${ADS}.sum($spend)`),
      m('a_ratio','广告 · 归因额/有效销售额',`${ADS}.sum($revenue) / ${VALID_ORDERS}.sum($price)`,'0.0%','广告后台归因销售额 ÷ 同期订单有效销售额。只说明广告参与程度，归因额会和自然成交重叠，不是“广告带来的订单占比”。'),
      m('a_sku_rows','广告 · 当前关联商品行',`$main.filter(${ds('广告商品关联（当前）')}).count()`,'0,0','广告活动当前挂了哪些商品（最近 1 个月商品层快照）。一个活动常挂多个商品，活动名不能当商品归属，更不代表历史投放。')
    ]},
    { name:'g_growth', title:'复盘 · 商品月度增减（先按“对比期间”筛一组相邻月）', measures:[
      m('w_before','增减 · 前月有效销售额',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvBefore)`,'0,0.00','所选相邻两月中前一个月的有效销售额；全店或按商品拆。'),
      m('w_after','增减 · 当月有效销售额',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvAfter)`),
      m('w_delta','增减 · 净增额',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvDelta)`,'0,0.00','当月 − 前月（SAR）。全部商品相加 = 全店净变化；按“增长分类”拆开 = 老品/首次出单/恢复成交/本月无成交四类拆分；按商家SKU拆开排序 = 谁拉动、谁拖累。是算术拆分，不是因果。'),
      m('w_change','增减 · 环比变化率',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvDelta) / $main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvBefore)`,'0.00%','净增额 ÷ 前月有效销售额。'),
      m('w_dailyChange','增减 · 日均环比变化率',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvAfter) / $main.filter(${ds(DERIVED_TITLES.contributions)}).sum($gmvBeforeScaled) - 1`,'0.00%','把前月金额按两月天数比折算后再比较，排除 30 天 vs 31 天的影响。'),
      m('w_itemsBefore','增减 · 前月有效条目',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($itemsBefore)`,'0,0'),
      m('w_itemsAfter','增减 · 当月有效条目',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($itemsAfter)`,'0,0'),
      m('w_volume','增减 · 老品销量效应',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($volumeEffect)`,'0,0.00','老品因件数变化带来的金额变化：(当月件数−前月件数)×两月均价的平均。只对两个月都有成交的老品算，与均价效应相加 = 老品增额。'),
      m('w_price','增减 · 老品均价效应',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($priceEffect)`,'0,0.00','老品因每件均价变化带来的金额变化：(当月均价−前月均价)×两月件数的平均。'),
      m('w_share','增减 · 占全店净增额比例',`$main.filter(${ds(DERIVED_TITLES.contributions)}).sum($shareOfNet)`,'0.0%','该商品/分类的净增额 ÷ 全店净增额。分母很小或为负时比例会很夸张，只在净变化明显的月份看。')
    ]},
    { name:'g_launch', title:'复盘 · 破冰与起步28天', measures:[
      m('l_events','破冰 · 节点数',`$main.filter(${ds(DERIVED_TITLES.milestones)}).count()`,'0,0','破冰节点个数：最早任意状态订单、最早有效首件、累计 10/50/100 件、首次 7 天里 5 天/7 天有成交。按“日期”和“事件/节点”拆开看时间线；日期是本地数据观察到的，不是开店或上架日。'),
      m('l_sales','起步 · 窗口有效销售额',`$main.filter(${ds(DERIVED_TITLES.launch)}).sum($sales)`,'0,0.00','从最早有效首件起每 28 天一段的有效销售额，只保留完整段；按“类型（第N段）”拆开。'),
      m('l_items','起步 · 窗口有效条目',`$main.filter(${ds(DERIVED_TITLES.launch)}).sum($items)`,'0,0'),
      m('l_products','起步 · 窗口出单商品数',`$main.filter(${ds(DERIVED_TITLES.launch)}).max($products)`,'0,0','单段内有过有效成交的商品数，取最大值，不能跨段相加。'),
      m('l_days','起步 · 窗口有成交天数',`$main.filter(${ds(DERIVED_TITLES.launch)}).max($days)`,'0,0','单段内有成交的天数（满 28 为天天出单），不能跨段相加。'),
      m('l_spend','起步 · 窗口广告花费',`$main.filter(${ds(DERIVED_TITLES.launch)}).sum($spend)`),
      m('l_adRatio','起步 · 归因额/有效销售额',`$main.filter(${ds(DERIVED_TITLES.launch)}).sum($revenue) / $main.filter(${ds(DERIVED_TITLES.launch)}).sum($sales)`,'0.0%','广告归因额 ÷ 窗口有效销售额，反映起步期对广告的依赖程度；不是付费订单占比。'),
      m('l_top3share','起步 · 前三商品占比',`$main.filter(${ds(DERIVED_TITLES.launch)}).sum($top3) / $main.filter(${ds(DERIVED_TITLES.launch)}).sum($sales)`,'0.0%','销售额前三的商品占窗口有效销售额的比例，看起步是否靠少数爆品。只在单段内有意义。'),
      m('lp_sales','起步商品 · 有效销售额',`$main.filter(${ds(DERIVED_TITLES.launchProducts)}).sum($sales)`,'0,0.00','各 28 天段内每个商品的有效销售额；按“商家SKU”拆开排序就是起步主力商品。'),
      m('lp_items','起步商品 · 有效条目',`$main.filter(${ds(DERIVED_TITLES.launchProducts)}).sum($items)`,'0,0')
    ]},
    { name:'g_catalog', title:'商品每日快照（只按单日看）', measures:[
      m('c_units','快照 · 销量（勿跨天相加）',`$main.filter(${ds('商品每日快照')}).sum($unitsSold)`,'0,0'),
      m('c_avgPrice','快照 · 平均价格',`$main.filter(${ds('商品每日快照')}).average($price)`),
      m('c_skus','快照 · 商品数',`$main.filter(${ds('商品每日快照')}).countDistinct($sku)`,'0,0'),
      m('c_fbnMin','快照 · FBN库存最小值',`$main.filter(${ds('商品每日快照')}).min($fbnStock)`,'0,0','所选范围内快照库存的最小值。按“日期×商家SKU”拆开时最小=最大=当天读数；快照只在观察日有，不能推断连续缺货天数。'),
      m('c_fbnMax','快照 · FBN库存最大值',`$main.filter(${ds('商品每日快照')}).max($fbnStock)`,'0,0'),
      m('c_fbpMax','快照 · FBP库存最大值',`$main.filter(${ds('商品每日快照')}).max($fbpStock)`,'0,0'),
      m('c_priceMin','快照 · 价格最小值',`$main.filter(${ds('商品每日快照')}).min($price)`,'0,0.00','按“日期×商家SKU”拆开可看价格何时变动。'),
      m('c_priceMax','快照 · 价格最大值',`$main.filter(${ds('商品每日快照')}).max($price)`),
      m('c_live','快照 · 可售商品数',`$main.filter(${ds('商品每日快照')} and $status == '1').countDistinct($sku)`,'0,0','快照里上架状态为 1（可售）的不同商品数；配合“状态”维度看哪些商品不可售。')
    ]},
    { name:'g_inv', title:'当前库存', measures:[
      m('i_fbn','库存 · FBN',`$main.filter(${ds('商品与当前库存')}).sum($fbnStock)`,'0,0'),
      m('i_fbp','库存 · FBP',`$main.filter(${ds('商品与当前库存')}).sum($fbpStock)`,'0,0'),
      m('i_skus','库存 · 当前商品数',`$main.filter(${ds('商品与当前库存')}).count()`,'0,0','当前商品表的商品数（抽取时）。')
    ]},
    { name:'g_proc', title:'补货与采购', measures:[
      m('p_air','补货 · 建议空运数（不与海运相加）',`$main.filter(${ds('补货计划')}).sum($airQty)`,'0,0'),
      m('p_sea','补货 · 建议海运数',`$main.filter(${ds('补货计划')}).sum($seaQty)`,'0,0'),
      m('b_units','采购批次 · 采购数',`$main.filter(${ds('采购批次')}).sum($units)`,'0,0'),
      m('b_freight','采购批次 · 运费',`$main.filter(${ds('采购批次')}).sum($freight)`),
      m('bi_units','采购明细 · 商品数',`$main.filter(${ds('采购商品明细')}).sum($units)`,'0,0','采购批次里每个商品的发货件数；日期是发货日，送仓日期在“采购批次”数据集的“事件/节点”维度。送仓≠上架。')
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
    { name:'time', title:'日期', kind:'time', formula:'$time', description:'订单/到账/账单=业务日期；广告日报=当天；快照与清单=更新/采集时间；补货=计划日；采购=发货日；复盘增减=当月1日；破冰节点=节点日；起步28天=该段起始日。按原始日编码到 UTC 坐标，用 Etc/UTC 读图。' },
    { name:'store', title:'店铺', formula:'$store' },
    { name:'dataset', title:'数据集（子视图）', formula:'$dataset', description:'先拖这个维度拆开，再看各组指标；每组指标只对自己的数据集生效' },
    { name:'status', title:'状态', formula:'$status', description:'订单状态 / 活动状态 / 上架状态 / 同步步骤状态，含义随数据集不同' },
    { name:'type', title:'类型 / 增长分类 / 窗口段', formula:'$type', description:'发货方式 / 交易类型 / 单据类型 / 投放方式 / 任务名；复盘增减=老品、首次观察成交、恢复成交、本月无成交；起步=第N段28天；破冰=节点名称' },
    { name:'period', title:'对比期间 / 窗口 / 上架日', formula:'$period', description:'复盘增减=“前月 → 当月”；起步=该段起止日；采购批次=上架日（多为未记录）；广告商品关联=报表窗口' },
    { name:'event', title:'事件 / 节点 / 送仓日期', formula:'$event', description:'破冰节点名称；采购批次的送仓日期；同步步骤名' },
    { name:'entity', title:'主体编号', formula:'$entity', description:'订单号 / 账单号 / 活动编码 / 批次 / 执行ID 等' },
    { name:'orderNr', title:'订单号', formula:'$orderNr' },
    { name:'sku', title:'SKU', formula:'$sku' },
    { name:'psku', title:'商家SKU', formula:'$psku' },
    { name:'title', title:'商品标题（当前）', formula:'$title', description:'当前商品表/快照里的标题，仅用于识别商品，不是历史标题' },
    { name:'firstSale', title:'首次观察有效成交日', formula:'$firstSale', description:'该商品在本地历史里第一次出现有效成交的日期，不是上架日' },
    { name:'campaign', title:'广告活动编码', formula:'$campaign' },
    { name:'campaignName', title:'广告活动名称', formula:'$campaignName', description:'当前活动标题；一个活动常挂多个商品，不能当商品归属' },
    { name:'country', title:'站点', formula:'$country' }
  ];
}

function description(run, cubes, cutoff) {
  const links = Object.entries(SOURCES).filter(([f]) => f !== 'ad_skus').map(([file, s]) => `[${s.title}](#${s.cube})`).join('、');
  return `两店全部数据集合在一张表里，用「数据集（子视图）」维度拆开看。每组指标只计算自己的数据集，不会互相串加；**不同数据集的金额不要相加**（订单金额、到账、账单是同一笔生意的不同环节）。

复盘层（由本版本的订单、广告日报、当前商品表算出，经营截止 ${cutoff}，不含未完整的当月）：「复盘·商品月度增减」按相邻两月拆每个商品的有效销售额变化与老品销量/均价效应；「复盘·破冰节点」记录首单、累计件数、首次连续出单的日期；「复盘·起步28天」与「复盘·起步28天商品」从最早有效首件起按完整 28 天分段。有效销售额 = 剔除 CIR / Could Not Be Delivered / Cancelled 的订单售价合计，不是利润；广告归因不是因果；库存快照只代表观察日。

未并入：搜索词全部窗口（约 191 万行，重叠报表期）、广告搜索词层——请到各自子视图看。快照类（商品每日快照、库存、竞品）跨天求和没有意义。

子视图直达：${links}、[1号店搜索词全部窗口](#search_windows_113)、[2号店搜索词全部窗口](#search_windows_112)。数据版本 ${run}。`;
}

// cutoff: exclusive ISO date for the derived layers; default = first day of the export month (complete months only).
// fileName lets a rebuild write a new file next to an older overview instead of overwriting evidence.
export async function buildOverview({ runDir, run, manifest, cubes, cutoff, fileName = 'overview.json' }) {
  const target = join(runDir, fileName);
  const file = createWriteStream(target, { mode:0o600, flags:'wx' });
  const exportMonth = (manifest.startedAt || new Date().toISOString()).slice(0, 7);
  cutoff = cutoff || exportMonth + '-01';
  const stats = { name:'overview', title:'总览（跨视图）', derivedFrom:Object.keys(SOURCES), derivedLayers:Object.values(DERIVED_TITLES), cutoff, rows:0, byStore:{}, byDataset:{}, minTime:null, maxTime:null, numericTotals:{} };
  const hash = createHash('sha256');
  const writeRow = async (r, mapped, dataset) => {
    const row = { time:r.time, store:r.store, storeId:String(r.storeId ?? (r.store === '1号店' ? 113 : 112)), dataset };
    for (const k of TEXT) row[k] = mapped[k] == null || mapped[k] === '' ? null : String(mapped[k]);
    for (const k of NUMERIC) row[k] = num(mapped[k]);
    assertOwnedRow(row);
    const out = JSON.stringify(row);
    hash.update(out + '\n');
    stats.rows++;
    stats.byStore[row.store] = (stats.byStore[row.store] || 0) + 1;
    stats.byDataset[dataset] = (stats.byDataset[dataset] || 0) + 1;
    if (!stats.minTime || row.time < stats.minTime) stats.minTime = row.time;
    if (!stats.maxTime || row.time > stats.maxTime) stats.maxTime = row.time;
    for (const k of NUMERIC) stats.numericTotals[k] = (stats.numericTotals[k] || 0) + row[k];
    if (!file.write(out + '\n')) await once(file, 'drain');
  };
  for (const [fileName, s] of Object.entries(SOURCES)) {
    const src = join(runDir, fileName + '.json');
    if (!existsSync(src)) throw new Error('Overview source missing: ' + src);
    const expected = manifest.datasets.find(d => d.name === fileName);
    if (!expected) throw new Error('No manifest entry for ' + fileName);
    let n = 0;
    for await (const line of createInterface({ input:createReadStream(src), crlfDelay:Infinity })) {
      if (!line) continue;
      const r = JSON.parse(line);
      await writeRow(r, s.map(r), s.title);
      n++;
    }
    if (n !== expected.rows) throw new Error(`Overview row mismatch for ${fileName}: ${n} != ${expected.rows}`);
  }
  // Derived layers: same source files, descriptive arithmetic only.
  const [orders, ads, inventory] = await Promise.all(['orders', 'ad_daily', 'inventory'].map(n => readJsonl(join(runDir, n + '.json'))));
  const titles = new Map(inventory.map(r => [r.store + '|' + r.psku, r.title]));
  const derived = deriveLayers({ orders, ads, titles, cutoff });
  for (const [name, d] of Object.entries(DERIVED)) for (const r of derived[name]) await writeRow(r, d.map(r), d.title);
  stats.derivedRows = Object.fromEntries(Object.entries(derived).map(([k, v]) => [DERIVED_TITLES[k], v.length]));
  file.end(); await once(file, 'finish');
  stats.sha256 = hash.digest('hex');
  const cube = {
    name:'overview', title:'总览（跨视图）', description:description(run, cubes, cutoff),
    clusterName:'native', source:`data/runs/${run}/${fileName}`, timeAttribute:'time', defaultTimezone:'Etc/UTC',
    defaultDuration:'P1Y', defaultSortMeasure:'count', defaultSelectedMeasures:['count'],
    defaultPinnedDimensions:['dataset','store'], introspection:'no-autofill', maxSplits:4,
    dimensions:dimensions(), measures:measures()
  };
  return { cube, stats };
}

// CLI: add the overview cube to the latest run without re-exporting anything.
// `--rebuild` regenerates the overview for a run that already has one (new file + new config; old files stay).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rebuild = process.argv.includes('--rebuild');
  const latestPath = join(HERE, 'data', 'latest-run.json');
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(latest.manifestPath, 'utf8'));
  const config = yaml.safeLoad(readFileSync(latest.configPath, 'utf8'));
  const hasOverview = config.dataCubes.some(c => c.name === 'overview');
  if (hasOverview && !rebuild) throw new Error('Latest run already has an overview cube (use --rebuild to regenerate)');
  const runDir = dirname(latest.manifestPath);
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const fileName = rebuild ? `overview.${stamp}.json` : 'overview.json';
  const others = config.dataCubes.filter(c => c.name !== 'overview');
  const { cube, stats } = await buildOverview({ runDir, run:latest.run, manifest, cubes:others, fileName });
  const configPath = join(HERE, rebuild ? `config.${latest.run}-overview.${stamp}.yaml` : `config.${latest.run}-overview.yaml`);
  writeFileSync(configPath, yaml.safeDump({ ...config, dataCubes:[cube, ...others] }, { lineWidth:140, noRefs:true }), { mode:0o600, flag:'wx' });
  const superseded = manifest.datasets.filter(d => d.name === 'overview');
  if (superseded.length) manifest.supersededDatasets = [...(manifest.supersededDatasets || []), ...superseded];
  manifest.datasets = [...manifest.datasets.filter(d => d.name !== 'overview'), stats];
  manifest.cubes = [{ name:cube.name, title:cube.title, source:cube.source }, ...(manifest.cubes || []).filter(c => c.name !== 'overview')];
  manifest.configPath = configPath;
  manifest.overviewAddedAt = new Date().toISOString();
  writeFileSync(latest.manifestPath, JSON.stringify(manifest, null, 2), { mode:0o600 });
  writeFileSync(latestPath, JSON.stringify({ ...latest, configPath }, null, 2), { mode:0o600 });
  console.log(`overview: ${stats.rows} rows ${JSON.stringify(stats.byStore)}\n${JSON.stringify(stats.byDataset)}\nREADY ${configPath}`);
}

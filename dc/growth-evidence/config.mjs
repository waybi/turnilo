// Native Turnilo preset links for the growth/launch report, all pointing at the overview cube.
// No separate cube: the overview carries the derived layers (see build-overview.mjs / overview-derived.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { DERIVED_TITLES } from '../overview-derived.mjs';
const require=createRequire(import.meta.url);
const {DataCube}=require('../../build/common/models/data-cube/data-cube');
const {definitionConverters}=require('../../build/common/view-definitions');
const {urlHashConverter}=require('../../build/common/utils/url-hash-converter/url-hash-converter');
const HERE=path.dirname(fileURLToPath(import.meta.url));
const DC=path.dirname(HERE);
export const CUBE='overview';
export const BASE_URL='http://127.0.0.1:9092/';
// Report facts that presets point at (business cutoff 2026-09-30; first valid sales 2025-12-10 / 2026-04-18).
export const REPORT={cutoff:'2026-10-01',firstSale:{113:'2025-12-10',112:'2026-04-18'},mainProducts:{113:['MZH045','MZH048'],112:['ZA054','ZA055']},watchProducts:{113:['MZH071','MZH095'],112:['ZA157','ZA085']}};
const STORE={113:'1号店',112:'2号店'};
const T=DERIVED_TITLES;
const filter=(ref,values)=>({type:'string',ref,action:'in',not:false,values:Array.isArray(values)?values:[values]});
const not=(ref,values)=>({...filter(ref,values),not:true});
const split=(dimension,sort=dimension,direction='ascending',limit=200)=>({type:'string',dimension,sort:{ref:sort,type:sort===dimension?'dimension':'series',direction},limit});
const timeSplit=(grain='P1D')=>({type:'time',dimension:'time',granularity:grain,sort:{ref:'time',type:'dimension',direction:'ascending'},limit:1000});
const VALID_EXCLUDED=['CIR','Could Not Be Delivered','Cancelled'];

export function buildViews(cube){
 const dc=DataCube.fromJS(cube);const result=[];
 const add=(id,title,dataset,series,splits,opts={})=>{
  const from=opts.from||'2025-11-01',to=opts.to||REPORT.cutoff;
  const filters=[{type:'time',ref:'time',timeRanges:[{start:from+'T00:00:00Z',end:to+'T00:00:00Z'}]},filter('dataset',dataset)];
  if(opts.store)filters.push(filter('store',STORE[opts.store]));
  for(const [k,v] of Object.entries(opts.filters||{}))filters.push(filter(k,v));
  for(const [k,v] of Object.entries(opts.exclude||{}))filters.push(not(k,v));
  const viewDefinition={visualization:opts.vis||'table',timezone:'Etc/UTC',filters,splits,series:series.map(reference=>({reference})),pinnedDimensions:['dataset','store','psku'],pinnedSort:series[0],...(opts.timeShift?{timeShift:opts.timeShift}:{})};
  const essence=definitionConverters['4'].fromViewDefinition(viewDefinition,dc);
  if(opts.timeShift&&!essence.hasComparison())throw new Error(`timeShift dropped for ${id}`);
  const hash='#'+CUBE+'/'+urlHashConverter.toHash(essence);
  result.push({id,title,dataset,caveat:opts.caveat||'',viewDefinition,hash,url:BASE_URL+hash});
 };
 const O='订单',A='广告日报',C='商品每日快照';
 const orderSeries=['o_valid_sales','o_valid_items','o_selling_pskus','o_delivered'];
 // E01 monthly track: live orders dataset, valid statuses, split by store × month.
 add('monthly','两店月度经营（有效销售额、条目、出单商品数）',O,[...orderSeries,'o_valid_asp'],[split('store'),timeSplit('P1M')],{caveat:'一行=店铺×月；有效=剔除CIR/未送达/取消。起步月不完整。广告在另一数据集，不能与订单金额相加。'});
 add('monthly-ads','两店月度广告花费与归因',A,['a_spend','a_revenue','a_orders','a_roas'],[split('store'),timeSplit('P1M')],{caveat:'广告日报按日可相加；归因额不是因果增量，ROAS 不是利润率。'});
 for(const uid of [113,112]){
  add('monthly-'+uid,`${uid===113?'一':'二'}号店月度经营`,O,[...orderSeries,'o_valid_asp'],[timeSplit('P1M')],{store:uid});
  add('trend-'+uid,`${uid===113?'一':'二'}号店逐日有效销售`,O,['o_valid_sales','o_valid_items'],[timeSplit('P1D')],{store:uid,from:REPORT.firstSale[uid],vis:'line-chart',caveat:'逐日有效销售额与条目；日期沿用原始业务日。'});
 }
 // E02 recent complete months with native previous-period comparison (Sep vs Aug).
 add('recent','9月 vs 8月（表格里的灰色小字=8月及变化率）',O,['o_valid_sales','o_valid_items','o_delivered','o_selling_pskus'],[split('store')],{from:'2026-09-01',to:'2026-10-01',timeShift:'P1M',caveat:'主数字=9月，括号内=相对8月的变化率（Turnilo 原生对比）。两月天数不同，日均口径见复盘增减层的“日均环比变化率”。'});
 add('recent-ads','9月 vs 8月广告花费',A,['a_spend','a_revenue','a_roas'],[split('store')],{from:'2026-09-01',to:'2026-10-01',timeShift:'P1M'});
 add('recent-rates','8月→9月净增额、环比与日均环比',T.contributions,['w_before','w_after','w_delta','w_change','w_dailyChange'],[split('store')],{from:'2026-09-01',to:'2026-10-01',caveat:'来自复盘增减层（当月1日为日期坐标）；日均环比把前月按天数折算。'});
 // E03 bridges: growth classes per adjacent month pair.
 add('bridges','老品/首次出单/恢复/流失拆分（全部相邻月）',T.contributions,['w_delta','w_share','w_volume','w_price'],[split('store'),split('period'),split('type')],{caveat:'四类净增额相加=全店净变化；老品销量效应+均价效应=老品增额。算术拆分，不是因果。'});
 for(const [uid,b,a] of [[113,'2026-01','2026-02'],[113,'2026-02','2026-03'],[113,'2026-07','2026-08'],[112,'2026-05','2026-06'],[112,'2026-06','2026-07']]){
  add(`bridge-${uid}-${a}`,`${uid===113?'一':'二'}号店 ${b}→${a} 拆分`,T.contributions,['w_before','w_after','w_delta','w_share','w_volume','w_price'],[split('type')],{store:uid,filters:{period:b+' → '+a},from:a+'-01',to:a+'-02'});
  add(`growth-${uid}-${a}`,`${uid===113?'一':'二'}号店 ${b}→${a} 商品贡献`,T.contributions,['w_itemsBefore','w_itemsAfter','w_before','w_after','w_delta'],[split('psku','w_delta','descending')],{store:uid,filters:{period:b+' → '+a},from:a+'-01',to:a+'-02'});
 }
 add('products','各商品增减贡献（所有相邻月）',T.contributions,['w_itemsBefore','w_itemsAfter','w_delta'],[split('store'),split('period'),split('psku','w_delta','descending')]);
 // E05 milestones
 add('milestones','两店首单与持续出单节点',T.milestones,['l_events'],[split('store'),timeSplit('P1D'),split('event')],{caveat:'日期是本地数据观察到的节点，不是开店或上架日；“最早任意状态订单”可能是取消单。'});
 // E06/E07 launch windows
 add('launch','两店起步完整28天分段比较',T.launch,['l_sales','l_items','l_products','l_days','l_spend','l_adRatio','l_top3share'],[split('store'),split('type')],{caveat:'从最早有效首件起每28天一段，只保留完整段；出单商品数/有成交天数不能跨段相加。归因额比值不是付费订单占比。'});
 add('launch-products','起步第1段28天主力商品',T.launchProducts,['lp_sales','lp_items'],[split('store'),split('psku','lp_sales','descending')],{filters:{type:'第1段28天'}});
 // E08/E09 first day orders and ads
 for(const uid of [113,112]){
  const day=REPORT.firstSale[uid],next=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  add('first-orders-'+uid,`${uid===113?'一':'二'}号店首日有效成交`,O,['o_valid_sales','o_valid_items'],[split('psku'),split('type')],{store:uid,from:day,to:next,caveat:'类型=履约方式（FBN=Noon仓配）。'});
  add('first-ads-'+uid,`${uid===113?'一':'二'}号店首日广告归因`,A,['a_spend','a_orders','a_revenue'],[split('campaignName','a_revenue','descending')],{store:uid,from:day,to:next,caveat:'同日广告归因金额与订单金额吻合只说明广告参与，两套系统未逐单对齐。'});
 }
 add('orders','订单逐日证据（有效口径）',O,['o_valid_sales','o_valid_items','o_delivered'],[split('store'),timeSplit('P1D'),split('psku')]);
 add('ads','广告逐月证据',A,['a_spend','a_revenue','a_orders'],[split('store'),timeSplit('P1M')]);
 // E10/E11 September decliners and risers
 add('decline','9月下降商品排名',T.contributions,['w_itemsBefore','w_itemsAfter','w_delta'],[split('store'),split('psku','w_delta','ascending')],{filters:{period:'2026-08 → 2026-09'},from:'2026-09-01',to:'2026-09-02'});
 add('positive','9月增长商品排名',T.contributions,['w_itemsBefore','w_itemsAfter','w_delta','w_share'],[split('store'),split('psku','w_delta','descending')],{filters:{period:'2026-08 → 2026-09'},from:'2026-09-01',to:'2026-09-02',caveat:'“恢复成交”类型表示历史卖过、上月没卖、本月又卖了，不是新品。按“类型”维度可看增长分类。'});
 // E12 stock snapshots (catalog dataset, min/max per day × psku)
 const stockSeries=['c_fbnMin','c_fbnMax','c_fbpMax','c_priceMin','c_live'];
 add('stock','主力品库存与价格快照',C,stockSeries,[split('store'),split('psku'),timeSplit('P1D')],{filters:{psku:[...REPORT.mainProducts[113],...REPORT.watchProducts[113],...REPORT.mainProducts[112]]},from:'2026-08-01',to:'2026-10-02',caveat:'只有观察日有快照，不能推断连续缺货天数；按日期×商品拆开后最小=最大=当日读数；可售商品数 0 表示当日不可售。'});
 for(const uid of [113,112])add('stock-'+uid,`${uid===113?'一':'二'}号店主力品库存与可售`,C,stockSeries,[split('psku'),timeSplit('P1D')],{store:uid,filters:{psku:REPORT.mainProducts[uid]},from:'2026-08-01',to:'2026-10-02'});
 add('stock-coverage','历史库存快照覆盖日期',C,['c_skus','c_live'],[split('store'),timeSplit('P1D')],{from:'2026-06-01',to:'2026-10-02',caveat:'每个店有快照的日期及当天商品数；覆盖稀疏，不能当连续库存史。'});
 // E13 inbound: purchase batches (send/FBN dates) + purchase items (per SKU units)
 add('inbound','起步商品的发货批次（按发货日）','采购商品明细',['bi_units'],[split('store'),split('psku'),timeSplit('P1D'),split('entity')],{filters:{psku:['SK030','MZH095','ZA015','ZA062','ZA054','ZA055']},caveat:'日期=发货日；送仓日期在“采购批次”数据集的“事件”维度，按批次号（主体编号）对应。送仓≠上架。'});
 add('inbound-batches','采购批次送仓日期与上架日','采购批次',['b_units','b_freight'],[split('store'),timeSplit('P1D'),split('entity'),split('event')],{caveat:'事件=送仓日期；“对比期间/上架日”维度显示上架日，目前全部未记录。'});
 add('inbound-all','全部发货商品明细','采购商品明细',['bi_units'],[split('store'),split('psku'),timeSplit('P1D')]);
 // E14/E15 MZH095 case
 add('mzh095-orders','MZH095从首单到持续成交（8月逐日）',O,['o_valid_sales','o_valid_items','o_valid_asp'],[timeSplit('P1D')],{store:113,from:'2026-08-01',to:'2026-09-01',filters:{psku:'MZH095'}});
 add('mzh095-ads','MZH095活动同期广告记录（8月逐日）',A,['a_spend','a_orders','a_revenue'],[timeSplit('P1D')],{store:113,from:'2026-08-01',to:'2026-09-01',filters:{campaign:'C_F1DBGUJAGH'},caveat:'广告16日已记归因成交而订单下一次有效成交是17日，两表不能按日强行一一匹配。'});
 add('mzh095-inbound','MZH095试卖发货批次','采购商品明细',['bi_units'],[timeSplit('P1D'),split('entity')],{store:113,filters:{psku:'MZH095'}});
 // E16 weekly: ISO weeks (Mon–Sun) match the report's windows.
 add('weeks','周度有效销售与条目（周一起）',O,['o_valid_sales','o_valid_items'],[split('store'),timeSplit('P1W')],{from:'2026-08-03',to:'2026-09-21'});
 add('weeks-ads','周度广告花费与归因（周一起）',A,['a_spend','a_revenue','a_orders'],[split('store'),timeSplit('P1W')],{from:'2026-08-03',to:'2026-09-21',caveat:'与订单周表同一周界；广告归因额不能从订单额里扣出自然销售额。'});
 // E17 campaign ↔ product mapping caveat
 add('mapping','广告名称与实际当前关联商品','广告商品关联（当前）',['a_sku_rows'],[split('campaignName'),split('sku'),split('title')],{store:112,filters:{campaign:['C_IW4ZIG1XNV','C_D69S53AZ5L']},from:'2026-09-01',to:'2026-10-02',caveat:'“ZA157-假睫毛”活动当前挂着音箱、键盘、耳贴、假睫毛，活动名不能当商品归属，也不代表历史每日投放。'});
 // E18 coverage of current product pool
 add('coverage','当前商品池：有过有效成交的商品数',O,['o_selling_pskus'],[split('store')],{caveat:'与“当前库存·当前商品数”对照：当前商品数 − 有过有效成交的商品数 = 从未观察有效成交的商品。不是新品失败率，没有可靠上架日期。'});
 add('coverage-current','当前商品数（当前商品表）','商品与当前库存',['i_skus','i_fbn'],[split('store')],{to:'2026-10-02'});
 add('coverage-september','9月有成交的当前商品',O,['o_selling_pskus','o_valid_sales'],[split('store')],{from:'2026-09-01',to:'2026-10-01'});
 // E19 priority gaps
 for(const uid of [113,112])add('gaps-'+uid,`${uid===113?'一':'二'}号店主力品 8→9 月缺口`,T.contributions,['w_before','w_after','w_delta','w_change','w_share'],[split('psku')],{store:uid,filters:{period:'2026-08 → 2026-09',psku:REPORT.mainProducts[uid]},from:'2026-09-01',to:'2026-09-02',caveat:'“占全店净增额比例”就是该商品下滑占全店下滑的份额；是算术分解，不能全归因于缺货或停投。'});
 add('gaps-store','两店 8→9 月全店净变化',T.contributions,['w_before','w_after','w_delta','w_change','w_dailyChange'],[split('store')],{filters:{period:'2026-08 → 2026-09'},from:'2026-09-01',to:'2026-09-02'});
 // Equal-length windows: previous-28-days comparison native to Turnilo.
 add('windows','最近28天 vs 前28天（9/3–9/30 对 8/6–9/2）',O,['o_valid_sales','o_valid_items','o_delivered'],[split('store')],{from:'2026-09-03',to:'2026-10-01',timeShift:'P28D',caveat:'等长28天窗口，排除自然月天数差。'});
 add('product-trends','MZH095 / ZA157 逐月有效销售',O,['o_valid_sales','o_valid_items'],[split('store'),split('psku'),timeSplit('P1M')],{filters:{psku:['MZH095','ZA157']}});
 add('sync','同步步骤成功与失败记录','数据同步运行记录',['count'],[split('store'),split('type'),split('event'),split('status')],{to:'2026-10-02',caveat:'同步成功不证明 Noon 源端全部历史完整。'});
 return result;
}

export function publishViews(configPath,outDir){
 const config=yaml.safeLoad(fs.readFileSync(configPath,'utf8'));
 const cube=config.dataCubes.find(c=>c.name===CUBE);
 if(!cube)throw new Error('overview cube missing in '+configPath);
 const views=buildViews(cube);
 fs.mkdirSync(outDir,{recursive:true,mode:0o700});
 const out=path.join(outDir,'views.json');
 fs.writeFileSync(out,JSON.stringify({cube:CUBE,configPath,generatedAt:new Date().toISOString(),report:REPORT,views},null,2),{mode:0o600});
 return {views,out};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const latest=JSON.parse(fs.readFileSync(path.join(DC,'data/latest-run.json'),'utf8'));
 const {views,out}=publishViews(latest.configPath,path.join(DC,'data/growth-evidence/overview-presets'));
 console.log(`${views.length} overview presets → ${out}`);
}

// Compatibility for dc/start.mjs: the report evidence now lives inside the overview cube, so the
// startup config is the run's own config. Presets are regenerated here so links always match it.
export function composeGrowthConfig(basePath){
 try{publishViews(basePath,path.join(DC,'data/growth-evidence/overview-presets'));}
 catch(e){console.warn('overview presets not regenerated: '+e.message);}
 return basePath;
}

#!/usr/bin/env node
// One-shot, read-only MySQL -> versioned Turnilo files. No source writes or credential export.
// Run from turnilo: node --max-old-space-size=4096 dc/sync-all.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { scopedFrom, assertOwnedRow, dateSQL } from './sync-helpers.mjs';
import { buildOverview } from './build-overview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const RUN = new Date().toISOString().replace(/[-:.]/g,'');
const OUT = join(HERE,'data','runs',RUN);
mkdirSync(OUT,{recursive:true,mode:0o700});
const cfg = yaml.safeLoad(readFileSync('/Users/waybi/Desktop/my/copy/data-center/data-center/svc_base/etc/dev.yaml','utf8')).mysql;
if (!['127.0.0.1','localhost','::1'].includes(cfg.host)) throw new Error('Local database required');
const mysqlArgs = ['--protocol=TCP','-h',cfg.host,'-P',String(cfg.port),'-u',cfg.username,cfg.name,'--batch','--raw','--skip-column-names','--quick'];
const env = {...process.env, MYSQL_PWD:cfg.password};
const prefix='SET SESSION MAX_EXECUTION_TIME=180000; SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION READ ONLY; ';
function query(sql) {
  return execFileSync('/usr/local/mysql/bin/mysql',[...mysqlArgs,'-e',prefix+sql+'; ROLLBACK;'],{env,encoding:'utf8',timeout:200000,maxBuffer:32*1024*1024}).trim();
}
const sq=s=>`'${String(s).replaceAll("'","''")}'`;
const timeSQL=e=>`DATE_FORMAT(${e},'%Y-%m-%dT%H:%i:%sZ')`;
const nameSQL=e=>`CASE ${e} WHEN 113 THEN '1号店' WHEN 112 THEN '2号店' END`;
const manifest={startedAt:new Date().toISOString(),stores:[112,113],scope:'all history of two stores; no login or customer personal data',version:RUN,datasets:[],emptyTables:[],exclusions:[
  {tables:'accounts,user_accounts,customers,users,buyers,buyer_addresses,logistics_accounts,customer_menus,customer_features',reason:'身份凭据、客户个人资料、权限配置，不进入BI'},
  {tables:'*_backup*,*_bak*',reason:'备份重复数据不进入分析'},
  {tables:'goods,sales,trends,stock_histories等公共市场爬虫表',reason:'无uid/cid归属，不属于两店自有业务数据；stock_histories按两店shop_id检索无匹配'},
  {tables:'catalog_stocks,catalog_fbp_stocks',reason:'没有店铺列；相同PSKU在多店可复用，不能安全认定历史归属。两店库存由skus及sku_catalog_metrics提供'}
]};
// Fail before export if a campaign join could multiply metrics or cross stores/countries.
if(query("SELECT COUNT(*) FROM (SELECT uid,country,campaign_code FROM ads WHERE uid IN (112,113) GROUP BY uid,country,campaign_code HAVING COUNT(*)>1) x")!=='0') throw new Error('Duplicate campaign join keys');
if(query("SELECT COUNT(*) FROM (SELECT adgroup_code FROM ads WHERE uid IN (112,113) AND adgroup_code<>'' GROUP BY adgroup_code HAVING COUNT(*)>1) x")!=='0') throw new Error('Ambiguous adgroup owners');
execFileSync(process.execPath,['--max-old-space-size=3072',join(HERE,'export.mjs')],{cwd:ROOT,env:{...process.env,DC_EXPORT_OUT:OUT},stdio:'inherit',timeout:600000});
const core=yaml.safeLoad(readFileSync(join(HERE,'config.yaml'),'utf8'));
const coreMeta=JSON.parse(readFileSync(join(OUT,'_export_meta.json'),'utf8'));
// Preserve the user's existing four cubes and their field/measure customizations.
const cubes=core.dataCubes.filter(c=>['ads','orders','transactions','catalog'].includes(c.name));
for(const c of cubes)c.source=`data/runs/${RUN}/${c.name==='ads'?'ads_all':c.name}.json`;
const ads=cubes.find(c=>c.name==='ads');
if(ads)ads.description=`广告日报、搜索词、商品三层视图；每组指标只计算本层。搜索词按店铺选择不重叠的完整报表期（不拆分、不按月摊分）。本次窗口：${coreMeta.searchQueryWindows.map(w=>`${w.uid=== '113'?'1号店':'2号店'} ${w.s}～${w.e}`).join('；')}。日报是每日事实，商品是最近一月的当前快照。活动状态为当前值。全部重叠历史另见“搜索词全部窗口”，不可跨窗口累计。2号店2026-07为重复开广告异常月。`;
for(const c of cubes){
  if(c.name==='orders') { c.description+=' 计数为item_nr商品条目，不是结账主订单数。'; c.measures.find(m=>m.name==='count').title='订单商品条目'; }
}
for(const d of coreMeta.datasets){
  const stats={...d,byStore:{},minTime:null,maxTime:null};
  const hash=createHash('sha256');let n=0;
  for await (const line of createInterface({input:createReadStream(join(OUT,d.name+'.json')),crlfDelay:Infinity})){
    if(!line)continue;const r=JSON.parse(line);assertOwnedRow(r); n++;hash.update(line+'\n');
    stats.byStore[r.store]=(stats.byStore[r.store]||0)+1;
    if(!stats.minTime||r.time<stats.minTime)stats.minTime=r.time;
    if(!stats.maxTime||r.time>stats.maxTime)stats.maxTime=r.time;
  }
  if(n!==d.rows)throw new Error(`Core count mismatch ${d.name}`);
  stats.sha256=hash.digest('hex');manifest.datasets.push(stats);
}
// Column spec is [field, title, SQL, numeric, aggregation]. Do not add raw credentials/PII.
const text=(field,title,sql=field)=>[field,title,sql,false];
const num=(field,title,sql=field,aggregate='sum')=>[field,title,sql,true,aggregate];
async function exportDataset({name,title,from,owner,time,fields,description,sourceTables,dimensions=[],defaultMeasures=[]}){
  if(!/\b(?:uid|cid) IN \(112,113\)/.test(from)) throw new Error('Missing explicit two-store SQL scope: '+name);
  const cols=[text('time','日期',time),text('store','店铺',nameSQL(owner)),text('storeId','店铺ID',`CAST(${owner} AS CHAR)`),...fields];
  const json=`JSON_OBJECT(${cols.flatMap(([k,,expr,numeric])=>[sq(k),numeric?`COALESCE(${expr},0)`:expr]).join(',')})`;
  const sql=`SELECT COUNT(*) ${from}; SELECT ${json} ${from}`;
  const child=spawn('/usr/local/mysql/bin/mysql',[...mysqlArgs,'-e',prefix+sql+'; ROLLBACK;'],{env,stdio:['ignore','pipe','pipe']});
  const completed=once(child,'close'); let stderr='';child.stderr.on('data',b=>{stderr+=b.toString()});
  const timer=setTimeout(()=>child.kill('SIGTERM'),200000);
  const file=createWriteStream(join(OUT,name+'.json'),{mode:0o600,flags:'wx'});
  const stats={name,title,sourceTables,sql:`SELECT ${json} ${from}`,rows:0,expectedRows:null,byStore:{},minTime:null,maxTime:null,numericTotals:{}};
  const hash=createHash('sha256');
  try{
    for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
      if(stats.expectedRows===null){stats.expectedRows=Number(line);if(!Number.isSafeInteger(stats.expectedRows))throw new Error('Invalid source count');continue;}
      if(!line)continue;
      const r=JSON.parse(line);assertOwnedRow(r);stats.rows++;hash.update(line+'\n');
      stats.byStore[r.store]=(stats.byStore[r.store]||0)+1;
      if(!stats.minTime||r.time<stats.minTime)stats.minTime=r.time;
      if(!stats.maxTime||r.time>stats.maxTime)stats.maxTime=r.time;
      for(const [k,,,numeric] of fields)if(numeric)stats.numericTotals[k]=(stats.numericTotals[k]||0)+Number(r[k]);
      if(!file.write(line+'\n'))await once(file,'drain');
    }
    const [code]=await completed; if(code!==0)throw new Error(`${name}: mysql exit ${code}: ${stderr}`);
    file.end();await once(file,'finish');
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');}
  if(stats.rows!==stats.expectedRows)throw new Error(`Source/export mismatch ${name}`);
  stats.sha256=hash.digest('hex');manifest.datasets.push(stats);
  if(!stats.rows){manifest.emptyTables.push(...sourceTables);console.log(name+': 0 (not displayed)');return;}
  const dims=cols.filter(([k,,,numeric])=>!numeric&&k!=='storeId').map(([name,title])=>({name,title,...(name==='time'?{kind:'time'}:{}),formula:'$'+name}));
  dims.push(...dimensions);
  const measures=[{name:'count',title:'记录数',formula:'$main.count()',format:'0,0'},...fields.filter(([, , ,n])=>n).map(([name,title,,,agg])=>({name,title,formula:`$main.${agg}($${name})`,format:'0,0.00'}))];
  cubes.push({name,title,description,clusterName:'native',source:`data/runs/${RUN}/${name}.json`,timeAttribute:'time',defaultDuration:'P1Y',defaultSortMeasure:'count',defaultSelectedMeasures:defaultMeasures.length?defaultMeasures:['count'],defaultPinnedDimensions:['store'],introspection:'no-autofill',dimensions:dims,measures});
  console.log(`${name}: ${stats.rows} rows ${JSON.stringify(stats.byStore)}`);
}
const direct=(table,owner)=>({from:scopedFrom(table,'t',owner),owner:`t.${owner}`,sourceTables:[table]});
await exportDataset({name:'statements',title:'结算账单',...direct('statements','uid'),time:timeSQL('t.statement_date'),description:'每行一份结算账单/合同业务键；交易与账单属于不同粒度，不能相加。货币按currency区分。',fields:[text('reference','账单号','t.reference_nr'),text('contract','合同号','t.contract_order_nr'),text('type','交易类型','t.transaction_type'),text('currency','币种','t.currency_code'),text('country','站点','t.country'),num('netProceeds','净收入','t.net_proceeds'),num('fees','费用','t.fees'),num('others','其他','t.others'),num('totalDue','应付合计','t.total_due'),text('feesDetail','费用明细JSON','CAST(t.fees_detail AS CHAR)'),text('othersDetail','其他明细JSON','CAST(t.others_detail AS CHAR)')],defaultMeasures:['totalDue','count']});
await exportDataset({name:'inventory',title:'商品与当前库存',...direct('skus','cid'),time:timeSQL('t.updated_at'),description:'每行一个当前商品，日期是源表更新时间，不是历史库存；采购价/销售价请看平均值。',fields:[text('sku','SKU','t.sku'),text('psku','商家SKU','t.psku'),text('title','商品标题','t.title'),text('country','站点','t.country'),text('liveStatus','上架状态','CAST(t.live_status AS CHAR)'),text('active','是否活跃','CAST(t.is_active AS CHAR)'),text('shippingMode','运输方式','t.shipping_mode'),num('price','平均售价','t.price','average'),num('purchasePrice','平均采购价','t.purchase_price','average'),num('fbnStock','FBN库存','t.fbn_stock'),num('fbpStock','FBP库存','t.fbp_stock'),num('weight','平均重量','t.weight','average')],defaultMeasures:['fbnStock','fbpStock','count']});
await exportDataset({name:'campaigns',title:'广告活动当前状态',...direct('ads','uid'),time:timeSQL('t.updated_at'),description:'当前广告活动/广告组清单；日预算是当前配置，不是实际花费。',fields:[text('campaign','活动编码','t.campaign_code'),text('title','活动名称','t.title'),text('adgroup','广告组','t.adgroup_code'),text('status','状态','t.status'),text('country','站点','t.country'),text('targeting','投放类型','t.targeting_type'),text('startDate','开始日期','t.start_date'),text('endDate','结束日期','t.end_date'),num('budget','日预算','t.budget')]});
await exportDataset({name:'procurement',title:'补货计划',...direct('procurement_plans','cid'),time:dateSQL('t.plan_date','t.created_at'),description:'每行一个计划日期×商品；跨计划日期是不同版本，库存与建议补货量不能当真实采购量累加。',fields:[text('psku','商家SKU','t.psku'),text('title','商品标题','t.title'),text('country','站点','t.country'),text('status','状态码','CAST(t.status AS CHAR)'),num('fbnStock','平均参考库存','t.fbn_stock','average'),num('dailySales','平均日销量','t.daily_sales','average'),num('airQty','计划空运数','t.air_qty'),num('seaQty','计划海运数','t.sea_qty')]});
await exportDataset({name:'purchases',title:'采购批次',...direct('purchases','cid'),time:dateSQL('t.date','t.created_at'),description:'每行一批采购；日期缺失时使用创建日。与采购商品明细是父子两层，数量不可相加。',fields:[text('batchId','批次ID','CAST(t.id AS CHAR)'),text('country','站点','t.country'),text('box','箱号','t.box_no'),text('fbnDate','入仓日','t.fbn_date'),text('listingDate','上架日','t.listing_date'),text('express','物流','t.express'),text('asn','ASN','t.asn'),num('units','采购数','t.total'),num('freight','运费','t.freight'),num('weight','重量','t.weight'),num('volume','体积','t.volume')]});
await exportDataset({name:'purchase_items',title:'采购商品明细',from:'FROM purchase_skus t JOIN purchases p ON p.id=t.purchase_id WHERE p.cid IN (112,113)',owner:'p.cid',sourceTables:['purchase_skus','purchases'],time:dateSQL('p.date','p.created_at'),description:'每行一批次内一个商品；仅采购商品数量，不重复分摊整批运费。',fields:[text('batchId','批次ID','CAST(t.purchase_id AS CHAR)'),text('sku','SKU','t.sku'),text('country','站点','p.country'),text('box','箱号','p.box_no'),num('units','采购商品数','t.total')]});
await exportDataset({name:'promotions',title:'促销活动',...direct('promo_deals','cid'),time:timeSQL('t.updated_at'),description:'当前促销活动快照；时间为更新日，活动起止日期独立显示。GMV原文未确认币种不自动加总。',fields:[text('dealId','活动ID','t.deal_uid'),text('title','活动名','t.deal_name'),text('type','活动类型','t.deal_type'),text('status','状态','t.status'),text('country','站点','t.country'),text('startDate','开始','t.start_date'),text('endDate','结束','t.end_date'),text('enrolled','已参加','CAST(t.enrolled AS CHAR)'),text('gmvText','GMV源文本','t.gmv'),num('discountPct','平均折扣比例','t.discount_pct','average'),num('itemsSold','活动销量','t.items_sold')]});
await exportDataset({name:'coupons',title:'优惠券',...direct('promo_coupons','cid'),time:timeSQL('t.updated_at'),description:'优惠券当前快照；折扣额度/比例需按折扣类型阅读。',fields:[text('couponId','优惠券ID','t.coupon_uid'),text('title','券名称','t.coupon_name'),text('code','券码','t.coupon_code'),text('type','折扣类型','t.discount_type'),text('status','状态','t.status'),text('country','站点','t.country'),text('startDate','开始','t.start_date'),text('endDate','结束','t.end_date'),text('enrolled','已参加','CAST(t.is_enrolled AS CHAR)'),num('budget','预算','t.coupon_budget'),num('burnt','已使用预算','t.coupon_burnt_amount'),num('products','适用商品数','t.psku_count')]});
await exportDataset({name:'deal_items',title:'促销商品',...direct('sku_deals','cid'),time:timeSQL('t.updated_at'),description:'每行活动×商家SKU当前参与状态；价格保留源文本，不把异常文本转为零。',fields:[text('dealId','活动ID','t.deal_uid'),text('title','活动标题','t.deal_title'),text('psku','商家SKU','t.psku'),text('country','站点','t.country'),text('status','活动状态','t.status'),text('skuStatus','商品状态','t.sku_status'),text('price','促销价原文','t.deal_price'),text('recommended','建议价原文','t.reco_price'),text('startDate','开始','t.start_date'),text('endDate','结束','t.end_date')]});
await exportDataset({name:'competitors',title:'已绑定竞品',...direct('sku_competitors','cid'),time:timeSQL('t.updated_at'),description:'两店绑定的竞品当前快照；销量为源端快照，不能按抓取次数累计。',fields:[text('psku','商家SKU','t.psku'),text('competitorSku','竞品SKU','t.competitor_sku'),text('country','站点','t.country'),text('live','在售','CAST(t.is_live AS CHAR)'),num('price','平均竞品价','t.competitor_price','average'),num('sold','平均销量快照','t.competitor_sold','average'),num('ratingCount','平均评价数','t.competitor_rating_count','average')]});
await exportDataset({name:'competitor_history',title:'竞品历史快照',from:'FROM sku_competitor_logs t JOIN sku_competitors p ON p.id=t.competitor_id WHERE p.cid IN (112,113)',owner:'p.cid',sourceTables:['sku_competitor_logs','sku_competitors'],time:timeSQL('t.created_at'),description:'每次抓取的竞品快照，库存/累计销量不跨时点求和。',fields:[text('psku','商家SKU','p.psku'),text('competitorSku','竞品SKU','p.competitor_sku'),text('live','在售','CAST(t.is_live AS CHAR)'),num('price','平均竞品价','t.competitor_price','average'),num('sold','平均销量快照','t.competitor_sold','average'),num('ratingCount','平均评价数','t.competitor_rating_count','average')]});
await exportDataset({name:'freight_settings',title:'运输成本参数',...direct('freights','cid'),time:timeSQL('t.updated_at'),description:'当前成本参数，不能跨店相加；均以平均值展示。',fields:[num('airFee','空运费率','t.air_fee','average'),num('shippingFee','海运费率','t.shipping_fee','average'),num('exchangeRate','汇率','t.exchange','average'),num('airDays','空运天数','t.air_time','average'),num('shippingDays','海运天数','t.shipping_time','average')]});
await exportDataset({name:'sync_runs',title:'数据同步运行记录',...direct('sync_reconciliation_runs','cid'),time:timeSQL('t.started_at'),description:'每行一个任务步骤；来源行数/存储行数是每次执行处理量，不能跨运行当作独立订单数。错误原文可能带敏感信息，未导出。',fields:[text('execution','执行ID','t.execution_id'),text('task','任务','t.task_name'),text('step','步骤','t.step'),text('status','状态','t.status'),text('trigger','触发方式','t.trigger'),text('country','站点','t.country'),text('latestDate','最新业务日','CAST(t.latest_business_date AS CHAR)'),num('sourceRows','来源处理行数','t.source_rows'),num('storedRows','本地处理行数','t.stored_rows'),num('pendingRows','待处理行数','t.pending_rows')]});
// Full raw report windows are separate per store to keep startup allocations bounded.
for(const uid of [113,112]){
  await exportDataset({name:`search_windows_${uid}`,title:`${uid===113?'1号店':'2号店'}搜索词全部窗口`,from:`FROM ad_search_queries t WHERE t.uid IN (112,113) AND t.uid=${uid}`,owner:'t.uid',sourceTables:['ad_search_queries'],time:timeSQL('t.start_date'),description:'保留全部原始报表区间（包括重叠）。先选一个完整报表期再看花费/订单；默认只显示记录数。日趋势请使用广告分析的日报指标，去重累计用广告分析的搜索词指标。',fields:[text('period','报表期',"CONCAT(t.start_date,'～',t.end_date)"),text('country','站点','t.country'),text('campaign','活动编码','t.campaign_code'),text('adgroup','广告组','t.adgroup_code'),text('targeting','投放方式','t.targeting_type'),text('query','搜索词','t.query'),text('queryCn','搜索词中文',"NULLIF(t.query_cn,'')"),text('negative','已否定','CAST(t.pushed_negative AS CHAR)'),num('views','曝光（限定单报表期）','t.views'),num('clicks','点击（限定单报表期）','t.clicks'),num('orders','订单（限定单报表期）','t.orders'),num('atc','加购（限定单报表期）','t.atc'),num('spends','花费（限定单报表期）','t.spends'),num('revenue','收入（限定单报表期）','t.revenue'),num('bid','平均出价','t.bid','average'),num('effectiveBid','平均有效出价','t.effective_bid','average')]});
  const c=cubes.at(-1);c.defaultPinnedDimensions=['period','campaign'];
}
// Explicitly check every currently empty, non-sensitive owned business table.
const emptyOwner={ad_schedules:'uid',ad_schedule_logs:'uid',sku_schedules:'uid',sku_schedule_logs:'uid',sku_keywords:'uid',sku_keyword_ranks:'uid',sku_keyword_suggestions:'uid',catalogs:'cid',procures:'cid',sku_non_saleables:'cid',sku_price_logs:'cid',sku_price_adjust_requests:'cid',finance_entries:'cid',finance_entry_allocations:'cid',asns:'cid',collect_goods:'cid',collect_skus:'cid',alibabas:'cid',bagniunius:'cid',lamsa2:'cid',rayhanats:'cid',shareefcorners:'cid',noon_orders:'cid',ds_orders:'uid',trend_daily_candidates:'cid',takelot_skus:'uid',takelot_cart_jobs:'uid'};
for(const [table,owner] of Object.entries(emptyOwner)){
  const n=Number(query(`SELECT COUNT(*) ${scopedFrom(table,'t',owner)}`));
  if(n)throw new Error(`Previously empty business table ${table} now has ${n} rows; add an explicit safe mapping before publication`);
  manifest.emptyTables.push(table);
}
// One cross-dataset cube on top; every sub-view stays as its own cube.
const overview=await buildOverview({runDir:OUT,run:RUN,manifest,cubes});
manifest.datasets.push(overview.stats);
cubes.unshift(overview.cube);
const outputCfg={...core,dataCubes:cubes};
const configPath=join(HERE,`config.${RUN}.yaml`);
writeFileSync(configPath,yaml.safeDump(outputCfg,{lineWidth:140,noRefs:true}),{mode:0o600,flag:'wx'});
manifest.configPath=configPath;manifest.completedAt=new Date().toISOString();manifest.cubes=cubes.map(c=>({name:c.name,title:c.title,source:c.source}));
writeFileSync(join(OUT,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
writeFileSync(join(HERE,'data','latest-run.json'),JSON.stringify({run:RUN,configPath,manifestPath:join(OUT,'manifest.json')},null,2),{mode:0o600});
console.log(`READY ${configPath}\nMANIFEST ${join(OUT,'manifest.json')}`);

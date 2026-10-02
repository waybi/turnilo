#!/usr/bin/env python3
"""Publish the frozen 2026-09 growth report evidence for Turnilo; never reads MySQL.
Each layer has its own filtered measures; dates are raw-source calendar dates.
Generated paths are explicit, regular data artifacts. Old frozen evidence is untouched.
"""
from pathlib import Path
import argparse,csv,json,hashlib,math,io,os
os.umask(0o077)
from datetime import datetime,timedelta,timezone
p=argparse.ArgumentParser();p.add_argument('--source',default='/Users/waybi/Desktop/my/knowledge-system/noon/store-growth-2026-10-02');p.add_argument('--out',required=True);a=p.parse_args();base=Path(a.source);out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
if any(out.iterdir()):raise SystemExit('Use an empty --out directory.')
NUM=[f'n{i}' for i in range(1,21)];TEXT=['layer','store','storeId','period','product','psku','sku','event','campaign','campaignName','status','detail','source','dateLabel','endDate','firstDate','fulfillment','batch','checkName','sourceHash']
rows=[];layers={};sourcefiles={}
def load(path):
 q=base/path;raw=q.read_bytes();sourcefiles[path]={'sha256':hashlib.sha256(raw).hexdigest()};return list(csv.DictReader(io.StringIO(raw.decode()),delimiter='\t' if path.endswith('.tsv') else ','))
def num(x):
 try:v=float(x);return v if math.isfinite(v) else 0
 except (ValueError,TypeError):return 0

def layer(key,title,description,metrics):
 # Metrics: (name, title, input slot 1..20, aggregation, format)
 layers[key]={'key':key,'title':title,'description':description,'metrics':[{'name':name,'title':label,'slot':slot,'agg':agg,'format':fmt} for name,label,slot,agg,fmt in metrics]}
def metric(key,label,slot,agg='sum',fmt='0,0.00'):return (key,label,slot,agg,fmt)
def add(key,r,date='2026-09-30',values=(),**text):
 uid=int(num(r.get('uid',r.get('cid',0))));assert uid in (112,113),r
 date=str(date or '2026-09-30')[:10];date=date if date not in ('NULL','nan','') else '2026-09-30'
 obj={k:None for k in TEXT};obj.update({k:0 for k in NUM});obj.update(time=date+'T00:00:00.000Z',dateLabel=date,layer=layers[key]['title'],store='1号店' if uid==113 else '2号店',storeId='uid'+str(uid));obj.update({k:('批次'+str(v) if k=='batch' else str(v)) if v else None for k,v in text.items()})
 for i,v in enumerate(values,1):obj['n'+str(i)]=num(v)
 assert set(obj)==set(TEXT+NUM+['time']);rows.append(obj)
F='0,0.00';I='0,0';P='0.0%'
layer('monthly','01 月度经营','一行=店铺×月；销售額剔除CIR、未送达、取消。起步月不完整。广告收入不等于增量归因。',[metric('sales','有效销售额 SAR',1),metric('items','有效商品条目',2,fmt=I),metric('spend','广告花费 SAR',3),metric('adRevenue','广告归因额 SAR',4),metric('adOrders','广告归因单',5,fmt=I),metric('delivered','已送达金额 SAR',6),metric('sellingProducts','出单商品数（单月）',7,'max',I),metric('sellingDays','出单天数（单月）',8,'max',I),metric('days','日历天数',9,'max',I),metric('clicks','广告点击',10,fmt=I),metric('views','广告曝光',11,fmt=I)])
for r in load('results/monthly.csv'):add('monthly',r,r['month']+'-01',[r[k] for k in ['gmv','valid_rows','ad_spend','ad_revenue','ad_orders','delivered_gmv','selling_pskus','selling_days','calendar_days','ad_clicks','ad_views']],period=r['month'],source='orders + ad_daily_metrics')
layer('products','02 商品增减贡献','一行=店铺×相邻月份×PSKU；金额是当月减上月。分组后老品销量/均价效应精确相加；不是因果模型。',[metric('before','前月销售额 SAR',1),metric('after','当月销售额 SAR',2),metric('delta','增加销售额 SAR',3),metric('beforeItems','前月条目',4,fmt=I),metric('afterItems','当月条目',5,fmt=I),metric('volume','老品销量效应 SAR',6),metric('price','老品均价效应 SAR',7)])
types={'existing':'两月均有成交','first_observed_sale':'首次观察成交','reactivated':'恢复成交','lapsed':'本月无成交'}
for r in load('results/contributions.csv'):add('products',r,r['after']+'-01',[r[k] for k in ['gmv_before','gmv_after','delta','valid_rows_before','valid_rows_after','volume_effect','price_effect']],period=r['before']+' → '+r['after'],psku=r['psku'],product=r['psku']+'｜'+(r.get('title') or '历史商品'),status=types.get(r['type'],r['type']),firstDate=r['first_valid_date'][:10],source='orders')
layer('bridge','03 老品新出单拆分','一行=店铺×相邻月份；老品、新出单、恢复成交、流失四类加总=全店差额。比例分母为净变化。',[metric('net','全店净增额 SAR',1),metric('old','老品增额 SAR',2),metric('first','首次观察出单 SAR',3),metric('reactivate','恢复成交 SAR',4),metric('lapsed','本月无成交 SAR',5),metric('volume','老品销量效应 SAR',6),metric('price','老品均价效应 SAR',7)])
for r in load('results/bridges.csv'):add('bridge',r,r['after']+'-01',[r[k] for k in ['delta','existing_delta','first_sale_delta','reactivation_delta','lapsed_delta','volume_effect_existing','price_effect_existing']],period=r['before']+' → '+r['after'],source='orders')
layer('milestones','04 破冰里程碑','日期是本地历史观察节点。不是开店/上架日期。连续7天每天至少1件为本文定义。',[metric('events','节点数',1,fmt=I)])
for r in load('summary/milestones.csv'):
 for k,title in [('first_observed_any_order','最早任意状态订单（可能取消）'),('first_observed_valid_item','最早有效首件'),('cumulative_10','累计10件'),('cumulative_50','累计50件'),('cumulative_100','累计100件'),('first_week_selling_5_days','首次7天内5天有成交'),('first_week_selling_7_days','首次连续7天每天成交')]:add('milestones',r,r[k],[1],event=title,source='orders')
layer('launch','05 起步28日窗口','从本地最早有效首件起，完整等长28天；出单商品数不能跨窗口相加。广告金额比值不是付费订单占比。',[metric('sales','有效销售额 SAR',1),metric('items','有效商品条目',2,fmt=I),metric('spend','广告花费 SAR',3),metric('adRevenue','广告归因额 SAR',4),metric('products','出单商品数（单窗）',5,'max',I),metric('days','有成交天数（单窗）',6,'max',I),metric('top3','前三商品销售额 SAR',7)])
for r in load('results/launch_blocks.csv'):
 if int(r['block'])<=3:add('launch',r,r['from'],[r[k] for k in ['gmv','valid_rows','ad_spend','ad_revenue','selling_pskus','selling_days','top3_gmv']],period='第'+r['block']+'段28天',endDate=(datetime.fromisoformat(r['to_exclusive'])-timedelta(days=1)).date().isoformat(),source='orders + ad_daily_metrics')
starts={113:'2025-12-10',112:'2026-04-18'}
layer('launchProducts','06 起步商品贡献','一行=店铺×28天段×商品。展示完整候选池，排名按选定段销售额。',[metric('sales','起步商品销售额 SAR',1),metric('items','起步商品条目',2,fmt=I)])
for r in load('results/launch_skus.csv'):
 if int(r['block'])<=3:add('launchProducts',r,(datetime.fromisoformat(starts[int(r['uid'])])+timedelta(days=(int(r['block'])-1)*28)).date().isoformat(),[r['gmv'],r['valid_rows']],period='第'+r['block']+'段28天',psku=r['psku'],product=r['psku']+'｜'+r['title'],source='orders')
layer('orders','07 订单逐日证据','日期沿用原始日；一行=店铺×日×商品×履约；零成交可能有取消等排除项，含状态尚未最终完成的有效条目。',[metric('sales','有效销售额 SAR',1),metric('items','有效商品条目',2,fmt=I),metric('delivered','已送达金额 SAR',3),metric('deliveredItems','已送达条目',4,fmt=I),metric('all','所有状态条目',5,fmt=I),metric('returns','CIR条目',6,fmt=I),metric('cancels','取消条目',7,fmt=I),metric('failed','未送达条目',8,fmt=I)])
dim=load('evidence/03_current_skus.tsv');titles={(r['cid'],r['psku']):r['title'] for r in dim}
for r in load('evidence/02_daily_sku_orders.tsv'):add('orders',r,r['date'],[r[k] for k in ['gmv','valid_rows','delivered_gmv','delivered_rows','all_rows','cir_rows','cancelled_rows','nondelivery_rows']],psku=r['psku'],sku=r['sku'],product=r['psku']+'｜'+titles.get((r['uid'],r['psku']),'历史商品'),fulfillment=r['fulfillment_model'],source='orders')
layer('ads','08 广告逐日证据','一行=店铺×日×活动；可按日相加。活动名称为当前标题，不能将活动全额归给标题中的商品，不能与订单逐单匹配。',[metric('spend','广告花费 SAR',1),metric('revenue','广告归因额 SAR',2),metric('orders','广告归因单',3,fmt=I),metric('clicks','广告点击',4,fmt=I),metric('views','广告曝光',5,fmt=I)])
cm={(r['uid'],r['campaign_code']):r['title'] for r in load('evidence/05_ads.tsv')}
for r in load('evidence/04_ad_daily.tsv'):add('ads',r,r['date'],[r[k] for k in ['spends','revenue','orders','clicks','views']],campaign=r['campaign_code'],campaignName=cm.get((r['uid'],r['campaign_code']),''),source='ad_daily_metrics')
layer('stock','09 库存价格快照','仅观察日，不能推断连续缺货天数；库存/价格采用最小最大值，不跨天累加。按日期×PSKU后最小最大相同=当日读数。',[metric('stockMin','FBN库存最小值',1,'min',I),metric('stockMax','FBN库存最大值',1,'max',I),metric('fbp','FBP库存最大值',2,'max',I),metric('priceMin','快照价格最小 SAR',3,'min'),metric('priceMax','快照价格最大 SAR',3,'max'),metric('live','可售标记最小 0/1',4,'min',I),metric('issues','问题数最大值',5,'max',I)])
for r in load('context/11_catalog_recent.tsv'):add('stock',r,r['snapshot_date'],[r[k] for k in ['fbn_stock','fbp_stock','price','live_status','offer_issue_count']],psku=r['psku'],sku=r['sku'],product=r['psku']+'｜'+r['title'],status='可售' if r['live_status']=='1' else '不可售',source='sku_catalog_metrics')
layer('inbound','10 发货送仓记录','一行=采购批次×商品。日期按发货日；送仓日期见事件列；未填送仓不代表未到。不是平台上架时间。',[metric('units','该批商品数量',1,fmt=I)])
for r in load('context/14_inbound.tsv'):add('inbound',r,r['ship_date'],[r['total']],psku=r['sku'],product=r['sku']+'｜'+titles.get((r['cid'],r['sku']),''),batch=r['purchase_id'],event='送仓 '+(r['fbn_date'] if r['fbn_date']!='NULL' else '未记录'),detail='上架日 '+(r['listing_date'] if r['listing_date']!='NULL' else '未记录'),source='purchases + purchase_skus')
layer('mapping','11 广告当前商品关联','一行=当前活动/广告组/商品，不代表历史每日归属。用于说明不能按活动标题分摊商品广告费。',[metric('rows','关联行数',1,fmt=I)])
for r in load('context/16_ad_sku_mapping.tsv'):add('mapping',r,'2026-10-02',[1],sku=r['sku'],product=r['name'],campaign=r['campaign_code'],campaignName=cm.get((r['uid'],r['campaign_code']),''),detail=r['adgroup_code'],source='ads JOIN ad_skus')
layer('coverage','12 当前商品成交覆盖','截至9月30日已有成交与当前商品池比对；不是新品成功率，没有可靠上架日期。',[metric('current','当前商品数',1,fmt=I),metric('never','未观察有效成交商品',2,fmt=I),metric('september','9月有成交商品',3,fmt=I)])
for r in load('summary/current_sales_coverage.csv'):add('coverage',r,'2026-09-30',[r[k] for k in ['current_sku_rows','current_never_observed_valid_sale','current_with_sale_in_september']],source='skus + orders')
layer('gaps','13 主力品缺口','两款合计；缺口占比为全店下滑的算术分解，不能全归因于缺货或停投；等长缺口不是收益预测。',[metric('aug','8月销售额 SAR',1),metric('sep','9月销售额 SAR',2),metric('decline','少掉销售额 SAR',3),metric('equal','按8月日均折30天缺口 SAR',4),metric('share','占全店下滑比例',5,'max',P)])
for r in load('summary/priority_gaps.csv'):add('gaps',r,'2026-09-01',[r['aug_gmv'],r['sep_gmv'],r['decline'],r['equal30day_reference_gap'],num(r['share_of_store_decline_pct'])/100],psku=r['pskus'],source='orders')
layer('windows','14 等长窗口复核','时间止日不含；等长30天、连续两段28天，另看仅Delivered，验证9月下滑不是自然月天数差。',[metric('sales','有效销售额 SAR',1),metric('items','有效条目',2,fmt=I),metric('delivered','已送达金额 SAR',3),metric('days','窗口天数',4,'max',I)])
for r in load('results/equal_windows.csv'):add('windows',r,r['from'],[r[k] for k in ['gmv','valid_rows','delivered_gmv','days']],period=r['window'],endDate=r['to'],source='orders')
layer('weeks','15 周度广告与经营','各行都是完整7天；广告归因额不能从订单额扣出自然销售额。',[metric('sales','有效销售额 SAR',1),metric('items','有效条目',2,fmt=I),metric('spend','广告花费 SAR',3),metric('adRevenue','广告归因额 SAR',4),metric('clicks','广告点击',5,fmt=I)])
for r in load('summary/weekly_windows.csv'):add('weeks',r,r['from'],[r[k] for k in ['gmv','items','ad_spend','ad_revenue','ad_clicks']],endDate=r['to_exclusive'],source='orders + ad_daily_metrics')
layer('quality','16 来源与质量核验','核验记录及来源范围；源文件哈希一致≠Noon源端完整。同步成功也不证明广告全历史完整。',[metric('observed','观测值/记录行数',1,fmt=I),metric('difference','差值/异常数',2,fmt=I)])
for r in load('evidence/01_order_quality.tsv'):
 for key,title in [('item_rows','订单所有状态商品行'),('valid_rows','有效商品行（含10月1日）'),('nonpositive_price','价格非正数'),('empty_psku','空PSKU'),('empty_sku','空SKU')]:add('quality',r,'2026-10-02',[r[key],0],checkName=title,detail=r['first_date']+' 至 '+r['last_date'],source='orders')
for r in load('evidence/06_ad_quality.tsv'):
 # Preserve all reported fields as check rows rather than assuming schema spellings.
 for key,val in r.items():
  if key not in ('uid','country'):add('quality',r,'2026-10-02',[num(val),0],checkName='广告 '+key,detail=val,source='ad_daily_metrics')
for r in load('context/10_catalog_coverage.tsv'):add('quality',r,r['snapshot_date'],[r['sku_rows'],0],checkName='库存快照覆盖',detail='库存>0商品 '+r['in_stock_rows']+'；可售 '+r['live_rows'],source='sku_catalog_metrics')
for r in load('context/17_recent_sync.tsv'):add('quality',r,r['latest_run'],[r['runs_n'],0],checkName=r['task_name']+' / '+r['step'],status=r['status'],detail=r['latest_run'],source='sync_reconciliation_runs')
for r in load('context/09_monthly_sql.tsv'):add('quality',r,r['month']+'-01',[r['gmv'],0],checkName='SQL独立月额核验',period=r['month'],detail='有效条目 '+r['valid_rows'],source='orders')
# Explicit per-store contract checks and schema limitations; not fake measurements.
for uid in (112,113):
 add('quality',{'uid':uid},'2026-10-02',[0,0],checkName='订单定义',detail='商品条目item_nr；有效状态剔除CIR、Could Not Be Delivered、Cancelled；金额OfferPrice合计；不是利润',source='订单DTO + 写入映射')
 add('quality',{'uid':uid},'2026-10-02',[0,0],checkName='历史上架日期',status='未验证',detail='送仓≠上架；采购商品listing_date全部为空；skus.created_at晚于不少首单',source='purchases + skus')
 add('quality',{'uid':uid},'2026-10-02',[0,0],checkName='测评与价格日志覆盖',status='未查到记录',detail='本次scoped noon_orders、sku_price_logs为0行，不证明从未测评或未调价',source='noon_orders + sku_price_logs')
for folder in ['evidence','context']:
 man=json.loads((base/folder/'manifest.json').read_text())
 for qid,entry in man['sources'].items():
  q=base/folder/(qid+'.tsv');assert hashlib.sha256(q.read_bytes()).hexdigest()==entry['sha256']
  for uid in (112,113):add('quality',{'uid':uid},'2026-10-02',[entry['rows'],0],checkName='来源清单 '+qid,status='SHA256匹配',detail='两店合计来源行数，按店重复展示不可相加；'+man['started_at'],sourceHash=entry['sha256'],source=qid)
qa=json.loads((base/'results/qa.json').read_text())
for uid in (112,113):
 for k in ['order_pskus_multiple_skus','dim_psku_duplicates','unmatched_title_order_items','ad_duplicate_keys','total_monthly_delta_checksum','sum_monthly_gmv','sum_sku_monthly_gmv']:
  add('quality',{'uid':uid},'2026-10-02',[qa[k],0],checkName='自动复算 '+k,status='已复核',detail='两店整体复算结果，按店重复展示不可相加；经营截止2026-09-30',source='results/qa.json')
layer('current','17 当前商品档案','创建时间是入库时间，不是上架日；该时间晚于不少首单。库存是抽取时当前读数，不反推历史。',[metric('rows','商品数',1,fmt=I),metric('stock','当前FBN库存',2,fmt=I),metric('price','当前价格 SAR',3,'max')])
for r in dim:add('current',r,r['created_at'],[1,r['fbn_stock'],r['price']],psku=r['psku'],sku=r['sku'],product=r['psku']+'｜'+r['title'],detail='创建 '+r['created_at']+'；更新 '+r['updated_at'],status='可售' if r['live_status']=='1' else '不可售',source='skus')
blob=''.join(json.dumps(r,ensure_ascii=False,allow_nan=False)+'\n' for r in rows);(out/'evidence.json').write_text(blob)
meta={'builtAt':datetime.now(timezone.utc).isoformat(),'sourceRoot':str(base),'scope':[112,113],'businessCutoff':'2026-09-30','frozen':True,'rows':len(rows),'sha256':hashlib.sha256(blob.encode()).hexdigest(),'layers':list(layers.values()),'textFields':TEXT,'numberFields':NUM,'sources':sourcefiles,'byLayer':{v['title']:sum(r['layer']==v['title'] for r in rows) for v in layers.values()}}
(out/'manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2));print(json.dumps({'rows':len(rows),'layers':len(layers),'byLayer':meta['byLayer']},ensure_ascii=False))

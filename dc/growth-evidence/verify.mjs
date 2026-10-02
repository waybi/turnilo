#!/usr/bin/env node
// Verify the overview-based report presets against the live server: native /mkurl hashes, every
// split group's metrics versus an offline recomputation from the served overview file, and the
// report's key numbers. Also checks the derived layers against the frozen report CSVs when present.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import yaml from 'js-yaml';
import plywood from 'plywood';
import { CUBE, REPORT } from './config.mjs';
import { readJsonl, DERIVED_TITLES } from '../overview-derived.mjs';
const {Expression,$}=plywood;
const DC=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const published=JSON.parse(fs.readFileSync(path.join(DC,'data/growth-evidence/overview-presets/views.json'),'utf8'));
const config=yaml.safeLoad(fs.readFileSync(published.configPath,'utf8'));
const cube=config.dataCubes.find(c=>c.name===CUBE);
assert(!config.dataCubes.some(c=>c.name==='growth_evidence_202609'),'separate evidence cube must be gone');
const rows=await readJsonl(path.join(DC,cube.source));
const metrics=Object.fromEntries(cube.measures.flatMap(m=>m.measures||[m]).map(m=>[m.name,m]));
const close=(a,b,label,tol=1e-6)=>assert(Math.abs(a-b)<Math.max(tol,Math.abs(b)*1e-9),`${label}: ${a} != ${b}`);
const api=async(route,body)=>{const res=await fetch('http://127.0.0.1:9092/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const json=await res.json();assert(res.ok,route+' '+JSON.stringify(json));return json;};
const query=async e=>(await api('plywood',{dataCube:CUBE,expression:(typeof e==='string'?Expression.parse(e):e).toJS(),timezone:'Etc/UTC'})).result;
const resultRow=r=>r.data?.[0]??r[0];
function filterExpression(view){let e=Expression.TRUE;for(const f of view.filters){if(f.type==='time')e=e.and($(f.ref).overlap(new Date(f.timeRanges[0].start),new Date(f.timeRanges[0].end)));else{const o=$(f.ref).overlap(f.values);e=e.and(f.not?o.not():o);}}return e;}
function matches(row,view){return view.filters.every(f=>{if(f.type==='time')return Date.parse(row[f.ref])>=Date.parse(f.timeRanges[0].start)&&Date.parse(row[f.ref])<Date.parse(f.timeRanges[0].end);const hit=f.values.includes(row[f.ref]);return f.not?!hit:hit;});}
// Offline evaluator for every overview measure used by presets (mirrors the formulas in build-overview.mjs).
const INVALID=new Set(['CIR','Could Not Be Delivered','Cancelled']);
const T=DERIVED_TITLES;
const ds=(records,name)=>records.filter(r=>r.dataset===name);
const sum=(records,k)=>records.reduce((s,r)=>s+r[k],0);
const valid=records=>ds(records,'订单').filter(r=>!INVALID.has(r.status));
const uniq=(records,f)=>new Set(records.map(f)).size;
const ratio=(a,b)=>b===0?null:a/b;
const minmax=(records,k,fn)=>records.length?fn(...records.map(r=>r[k])):null;
const EXPECTED={
 count:r=>r.length,
 o_valid_sales:r=>sum(valid(r),'price'),o_valid_items:r=>valid(r).length,o_valid_asp:r=>ratio(sum(valid(r),'price'),valid(r).length),
 o_selling_pskus:r=>uniq(valid(r),x=>x.psku),o_selling_days:r=>uniq(valid(r),x=>x.time.slice(0,10)),
 o_delivered:r=>sum(ds(r,'订单').filter(x=>x.status==='Delivered'),'price'),
 a_spend:r=>sum(ds(r,'广告日报'),'spend'),a_revenue:r=>sum(ds(r,'广告日报'),'revenue'),a_orders:r=>sum(ds(r,'广告日报'),'adOrders'),a_roas:r=>ratio(sum(ds(r,'广告日报'),'revenue'),sum(ds(r,'广告日报'),'spend')),
 a_sku_rows:r=>ds(r,'广告商品关联（当前）').length,
 w_before:r=>sum(ds(r,T.contributions),'gmvBefore'),w_after:r=>sum(ds(r,T.contributions),'gmvAfter'),w_delta:r=>sum(ds(r,T.contributions),'gmvDelta'),
 w_change:r=>ratio(sum(ds(r,T.contributions),'gmvDelta'),sum(ds(r,T.contributions),'gmvBefore')),
 w_dailyChange:r=>{const b=sum(ds(r,T.contributions),'gmvBeforeScaled');return b===0?null:sum(ds(r,T.contributions),'gmvAfter')/b-1;},
 w_itemsBefore:r=>sum(ds(r,T.contributions),'itemsBefore'),w_itemsAfter:r=>sum(ds(r,T.contributions),'itemsAfter'),w_volume:r=>sum(ds(r,T.contributions),'volumeEffect'),w_price:r=>sum(ds(r,T.contributions),'priceEffect'),w_share:r=>sum(ds(r,T.contributions),'shareOfNet'),
 l_events:r=>ds(r,T.milestones).length,l_sales:r=>sum(ds(r,T.launch),'sales'),l_items:r=>sum(ds(r,T.launch),'items'),l_products:r=>minmax(ds(r,T.launch),'products',Math.max),l_days:r=>minmax(ds(r,T.launch),'days',Math.max),l_spend:r=>sum(ds(r,T.launch),'spend'),
 l_adRatio:r=>ratio(sum(ds(r,T.launch),'revenue'),sum(ds(r,T.launch),'sales')),l_top3share:r=>ratio(sum(ds(r,T.launch),'top3'),sum(ds(r,T.launch),'sales')),
 lp_sales:r=>sum(ds(r,T.launchProducts),'sales'),lp_items:r=>sum(ds(r,T.launchProducts),'items'),
 c_skus:r=>uniq(ds(r,'商品每日快照'),x=>x.sku),c_fbnMin:r=>minmax(ds(r,'商品每日快照'),'fbnStock',Math.min),c_fbnMax:r=>minmax(ds(r,'商品每日快照'),'fbnStock',Math.max),c_fbpMax:r=>minmax(ds(r,'商品每日快照'),'fbpStock',Math.max),
 c_priceMin:r=>minmax(ds(r,'商品每日快照'),'price',Math.min),c_live:r=>uniq(ds(r,'商品每日快照').filter(x=>x.status==='1'),x=>x.sku),
 i_skus:r=>ds(r,'商品与当前库存').length,i_fbn:r=>sum(ds(r,'商品与当前库存'),'fbnStock'),
 b_units:r=>sum(ds(r,'采购批次'),'units'),b_freight:r=>sum(ds(r,'采购批次'),'freight'),bi_units:r=>sum(ds(r,'采购商品明细'),'units')
};
const checks=[];
assert.equal(await query('$main.count()'),rows.length,'served row count');
for(const v of published.views){
 const url=await api('mkurl',{dataCubeName:CUBE,viewDefinitionVersion:'4',viewDefinition:v.viewDefinition});assert.equal(url.hash,v.hash,v.id+' hash');
 const records=rows.filter(r=>matches(r,v.viewDefinition));assert(records.length>0,v.id+' matches no rows');
 const main=$('main').filter(filterExpression(v.viewDefinition));
 let total=Expression.parse('ply()').apply('main',main);
 for(const s of v.viewDefinition.series)total=total.apply(s.reference,Expression.parse(metrics[s.reference].formula));
 const actual=resultRow(await query(total));
 const compare=(got,source,label)=>{for(const s of v.viewDefinition.series){const fn=EXPECTED[s.reference];assert(fn,'no offline evaluator for '+s.reference);const want=fn(source);if(want===null||!Number.isFinite(want))assert(got[s.reference]===null||!Number.isFinite(got[s.reference]),label+'/'+s.reference+' expected empty');else close(got[s.reference],want,label+'/'+s.reference);}};
 compare(actual,records,v.id);
 // Leaf groups: the actual split combination the preset renders.
 const groupExpressions=Object.fromEntries(v.viewDefinition.splits.map(s=>[s.dimension,s.type==='time'?$(s.dimension).timeBucket(s.granularity,'Etc/UTC'):$(s.dimension)]));
 let grouped=main.split(groupExpressions,'main');for(const s of v.viewDefinition.series)grouped=grouped.apply(s.reference,Expression.parse(metrics[s.reference].formula));
 const groups=(await query(grouped)).data;assert(Array.isArray(groups),v.id+' grouped');
 const bucketStart=(t,g)=>{const d=new Date(t);if(g==='P1M')return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);if(g==='P1W'){const day=(d.getUTCDay()+6)%7;return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day);}return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());};
 const keyOf=(row,fromServer)=>JSON.stringify(v.viewDefinition.splits.map(s=>s.type==='time'?(fromServer?Date.parse(row[s.dimension].start):bucketStart(row[s.dimension],s.granularity)):row[s.dimension]));
 const expectedGroups=new Map();for(const r of records){const k=keyOf(r,false);if(!expectedGroups.has(k))expectedGroups.set(k,[]);expectedGroups.get(k).push(r);}
 assert.equal(groups.length,expectedGroups.size,v.id+' leaf group count');
 for(const g of groups){const source=expectedGroups.get(keyOf(g,true));assert(source,v.id+' unexpected group '+keyOf(g,true));compare(g,source,v.id+'/group');}
 checks.push({id:v.id,rows:records.length,groups:groups.length,metrics:Object.fromEntries(v.viewDefinition.series.map(s=>[s.reference,actual[s.reference]])),status:'passed'});
}
// Report anchors straight from the served cube (frozen report numbers, business cutoff 2026-09-30).
// Plywood's parser has no time() literal: build time-window filters with the expression API instead.
const tw=(from,to)=>$('time').overlap(new Date(from+'T00:00:00Z'),new Date(to+'T00:00:00Z'));
const q=async(where,field,agg='sum',win)=>{let f=Expression.parse(where);if(win)f=f.and(tw(win[0],win[1]));const m=$('main').filter(f);return query(agg==='count'?m.count():m[agg]($(field)));};
const V="$dataset == '订单' and $status != 'CIR' and $status != 'Could Not Be Delivered' and $status != 'Cancelled'";
const nextMonth=m=>m==='2026-12'?'2027-01':m.slice(0,5)+String(Number(m.slice(5))+1).padStart(2,'0');
const mw=m=>[m+'-01',nextMonth(m)+'-01'];
close(await q(`${V} and $store == '1号店'`,'price','sum',mw('2026-09')),17577.38,'113 Sep valid sales',0.01);
close(await q(`${V} and $store == '2号店'`,'price','sum',mw('2026-09')),7547.74,'112 Sep valid sales',0.01);
close(await q(`${V} and $store == '1号店'`,'price','sum',mw('2026-08')),25332.64,'113 Aug valid sales',0.01);
close(await q(`${V} and $store == '2号店'`,'price','sum',mw('2026-08')),17192.52,'112 Aug valid sales',0.01);
assert.equal(await q(`${V} and $store == '1号店'`,'price','count',mw('2026-09')),361,'113 Sep items');
close(await q(`$dataset == '${T.contributions}' and $store == '2号店' and $period == '2026-06 → 2026-07' and ($psku == 'ZA054' or $psku == 'ZA055')`,'gmvDelta'),4302.92,'112 Jul pair',0.01);
close(await q(`$dataset == '${T.contributions}' and $store == '1号店' and $period == '2026-08 → 2026-09' and ($psku == 'MZH045' or $psku == 'MZH048')`,'gmvDelta'),-4353.40,'113 Sep pair',0.01);
close(await q(`${V} and $store == '1号店' and $psku == 'MZH095'`,'price','sum',mw('2026-08')),1300.5,'MZH095 Aug',0.01);
close(await q(`${V} and $store == '2号店'`,'price','sum',['2026-04-18','2026-04-19']),247.34,'112 first day',0.01);
close(await q(`$dataset == '商品每日快照' and $store == '1号店' and ($psku == 'MZH045' or $psku == 'MZH048')`,'fbnStock','max',['2026-09-05','2026-09-06']),0,'113 stockout 09-05');
close(await q(`$dataset == '${T.launch}' and $store == '1号店' and $type == '第1段28天'`,'sales'),7008.10,'113 first 28d',0.01);
close(await q(`$dataset == '${T.launch}' and $store == '2号店' and $type == '第1段28天'`,'sales'),6458.11,'112 first 28d',0.01);
assert.equal(await q(`$dataset == '${T.milestones}'`,'count','count'),14,'milestone rows');
// Frozen report CSVs (if the knowledge workspace is present): derived layer must reproduce them.
const frozen='/Users/waybi/Desktop/my/knowledge-system/noon/store-growth-2026-10-02/results';
let frozenChecks=0;
if(fs.existsSync(frozen)){
 const csv=n=>{const [h,...b]=fs.readFileSync(path.join(frozen,n),'utf8').trim().split('\n');const keys=h.split(',');return b.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[keys[i],v])));};
 const storeOf=uid=>uid==='113'?'1号店':'2号店';
 for(const b of csv('bridges.csv')){const where=`$dataset == '${T.contributions}' and $store == '${storeOf(b.uid)}' and $period == '${b.before} → ${b.after}'`;close(await q(where,'gmvDelta'),Number(b.delta),`bridge ${b.uid} ${b.after}`,0.01);close(await q(where+" and $type == '老品（两月都有成交）'",'gmvDelta'),Number(b.existing_delta),`existing ${b.uid} ${b.after}`,0.01);close(await q(where,'volumeEffect'),Number(b.volume_effect_existing),`volume ${b.uid} ${b.after}`,0.01);frozenChecks+=3;}
 for(const m of csv('milestones.csv'))for(const [col,label] of [['first_observed_valid_item','最早有效首件'],['cumulative_100','累计100件'],['first_week_selling_7_days','首次连续7天每天成交']]){const t=await query(`$main.filter($dataset == '${T.milestones}' and $store == '${storeOf(m.uid)}' and $type == '${label}').min($time)`);assert.equal(String(t).slice(0,10),m[col],`milestone ${m.uid} ${label}`);frozenChecks++;}
 for(const l of csv('launch_blocks.csv')){if(l.complete!=='True')continue;const where=`$dataset == '${T.launch}' and $store == '${storeOf(l.uid)}' and $type == '第${l.block}段28天'`;close(await q(where,'sales'),Number(l.gmv),`launch ${l.uid} ${l.block}`,0.01);close(await q(where,'spend'),Number(l.ad_spend),`launch ad ${l.uid} ${l.block}`,0.01);assert.equal(await q(where,'products','max'),Number(l.selling_pskus),`launch products ${l.uid} ${l.block}`);frozenChecks+=3;}
}
const report={verifiedAt:new Date().toISOString(),cube:CUBE,configPath:published.configPath,rows:rows.length,presets:checks,frozenReportChecks:frozenChecks,status:'passed'};
const dest=path.join(DC,'data/growth-evidence/overview-presets','verification.'+Date.now()+'.json');fs.writeFileSync(dest,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
console.log(`PASS: ${rows.length} overview rows, ${checks.length} presets (totals + every leaf group), 13 report anchors, ${frozenChecks} frozen-report checks.\n${dest}`);

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import yaml from '/Users/waybi/Desktop/my/turnilo/node_modules/js-yaml/index.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const root='/Users/waybi/Desktop/my/turnilo/dc';
const latest=JSON.parse(fs.readFileSync(path.join(root,'data/latest-run.json')));
const manifest=JSON.parse(fs.readFileSync(latest.manifestPath));
const config=yaml.safeLoad(fs.readFileSync(latest.configPath,'utf8'));
const run=path.dirname(latest.manifestPath);
const rows={};
const result={reviewedAt:new Date().toISOString(),run:latest.run,exportStarted:manifest.startedAt,exportCompleted:manifest.completedAt,views:config.dataCubes.map(c=>({name:c.name,title:c.title,measures:c.measures,description:c.description})),datasets:{}};
const groupFields={orders:['status'],transactions:['type'],statements:['type','currency'],promotions:['enrolled','status'],coupons:['enrolled','status','type'],deal_items:['status','skuStatus'],procurement:['status'],sync_runs:['status','task','step'],inventory:['liveStatus','active'],campaigns:['status']};
for(const d of manifest.datasets){
 if(d.name==='ads_all'||d.name==='search_queries')continue;
 const s={rows:0,byStore:{},numeric:{},groups:{},periods:{}};
 const keep=!d.name.startsWith('search_windows_');if(keep)rows[d.name]=[];
 for await(const line of readline.createInterface({input:fs.createReadStream(path.join(run,d.name+'.json')),crlfDelay:Infinity})){
  if(!line)continue;const r=JSON.parse(line);if(keep)rows[d.name].push(r);s.rows++;
  const st=s.byStore[r.store]??={rows:0,min:r.time,max:r.time,days:new Set()};st.rows++;st.min=r.time<st.min?r.time:st.min;st.max=r.time>st.max?r.time:st.max;st.days.add(r.time.slice(0,10));
  for(const [key,val]of Object.entries(r)){if(typeof val==='number'){const n=s.numeric[key]??={sum:0,zero:0,nonzero:0,min:val,max:val};n.sum+=val;n[val===0?'zero':'nonzero']++;n.min=Math.min(n.min,val);n.max=Math.max(n.max,val);}}
  for(const field of groupFields[d.name]||[]){const g=s.groups[field]??={};const x=g[String(r[field])]??={rows:0};x.rows++;for(const k of ['price','netProceeds','totalFees','otherFees','subtotal','fees','others','totalDue','itemsSold','budget','burnt'])if(typeof r[k]==='number')x[k]=(x[k]||0)+r[k];}
  if(d.name.startsWith('search_windows_')){const p=s.periods[r.period]??={rows:0,campaigns:new Set(),spends:0,revenue:0,orders:0,translated:0};p.rows++;p.campaigns.add(r.campaign);for(const k of ['spends','revenue','orders'])p[k]+=r[k]||0;if(r.queryCn)p.translated++;}
 }
 for(const v of Object.values(s.byStore)){v.days=[...v.days].sort();}
 for(const v of Object.values(s.periods))v.campaigns=v.campaigns.size;
 if(!Object.keys(s.periods).length)delete s.periods;
 result.datasets[d.name]=s;
}
for(const name of ['transactions','statements']){
 const sum=rows[name].reduce((a,r)=>a+(r.netProceeds||0)+(r.totalFees??r.fees??0)+(r.otherFees??r.others??0)-(r.subtotal??r.totalDue??0),0);
 const mismatch=rows[name].filter(r=>Math.abs((r.netProceeds||0)+(r.totalFees??r.fees??0)+(r.otherFees??r.others??0)-(r.subtotal??r.totalDue??0))>0.025).length;
 result.datasets[name].arithmetic={netPlusFeesPlusOtherMinusTotal:sum,mismatchRows:mismatch};
}
const children={};for(const r of rows.purchase_items)children[r.batchId]=(children[r.batchId]||0)+r.units;
result.purchaseConsistency={parentRows:rows.purchases.length,childRows:rows.purchase_items.length,mismatchBatches:rows.purchases.filter(r=>r.units!==(children[r.batchId]||0)).map(r=>({batchId:r.batchId,parentUnits:r.units,childUnits:children[r.batchId]||0}))};
result.freightRows=rows.freight_settings;
result.catalogDateCoverage=Object.fromEntries(['1号店','2号店'].map(store=>{const data=rows.catalog.filter(r=>r.store===store),days=[...new Set(data.map(r=>r.time.slice(0,10)))].sort();return[store,{rows:data.length,days:days.length,first:days[0],last:days.at(-1),spanDays:(Date.parse(days.at(-1))-Date.parse(days[0]))/86400000+1}]}));
const out=path.join(here,'profile.json');fs.writeFileSync(out,JSON.stringify(result,null,2),{mode:0o600});
console.log('Evidence',out);
console.log('View count',result.views.length,'run',result.run,'snapshot completed',result.exportCompleted);
for(const name of ['orders','transactions','statements','catalog','promotions','coupons','inventory','purchases']){const s=result.datasets[name];console.log(name,'rows',s.rows,'numeric',JSON.stringify(s.numeric));}
console.log('catalog coverage',JSON.stringify(result.catalogDateCoverage));console.log('purchase reconciliation',JSON.stringify(result.purchaseConsistency));
for(const name of ['search_windows_113','search_windows_112'])console.log(name,JSON.stringify(result.datasets[name].periods));

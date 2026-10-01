#!/usr/bin/env node
// Verify actual served datasets against immutable export counts, store totals and metrics.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import plywood from 'plywood';
const { Expression }=plywood;
const HERE=dirname(fileURLToPath(import.meta.url));
const latest=JSON.parse(readFileSync(join(HERE,'data/latest-run.json'),'utf8'));
const manifest=JSON.parse(readFileSync(latest.manifestPath,'utf8'));
const config=yaml.safeLoad(readFileSync(latest.configPath,'utf8'));
const url='http://127.0.0.1:9092';
const results=[];
function flatten(items,key){return items.flatMap(x=>x[key]?flatten(x[key],key):[x]);}
async function call(cube,expr){
  const r=await fetch(url+'/plywood',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataCube:cube,expression:Expression.parse(expr).toJS(),timezone:'Etc/UTC'}),signal:AbortSignal.timeout(120000)});
  const data=await r.json();if(!r.ok)throw new Error(`${cube}: ${r.status} ${JSON.stringify(data)}`);return data.result;
}
for(const cube of config.dataCubes){
  const name=cube.name==='ads'?'ads_all':cube.name;
  const expected=manifest.datasets.find(d=>d.name===name);
  if(!expected)throw new Error('No source manifest for '+name);
  const n=await call(cube.name,'$main.count()');if(n!==expected.rows)throw new Error(`${name} count ${n} != ${expected.rows}`);
  for(const store of ['1号店','2号店']){
    const n=await call(cube.name,`$main.filter($store == '${store}').count()`);
    if(n!==(expected.byStore[store]||0))throw new Error(`${name} ${store} mismatch`);
  }
  const outside=await call(cube.name,"$main.filter($store != '1号店' and $store != '2号店').count()");if(outside!==0)throw new Error('Other store leaked');
  const minTime=await call(cube.name,'$main.min($time)');
  const maxTime=await call(cube.name,'$main.max($time)');
  if(Date.parse(minTime)!==Date.parse(expected.minTime)||Date.parse(maxTime)!==Date.parse(expected.maxTime))throw new Error('Served date range mismatch '+name);
  const measures=flatten(cube.measures,'measures');
  let expr='ply()';for(const m of measures)expr+=`.apply('${m.name}', ${m.formula})`;
  const metricResult=await call(cube.name,expr);
  // Resolve every configured dimension without grouping high-cardinality raw history.
  const fields=[...new Set(flatten(cube.dimensions,'dimensions').map(d=>d.formula).filter(f=>/^\$\w+$/.test(f)).map(f=>f.slice(1)))];
  const row=await call(cube.name,`$main.limit(1).select(${fields.map(f=>`'${f}'`).join(',')})`);
  const metrics=metricResult.data?.[0] || metricResult[0];
  for(const m of measures){
    if(m.formula===`$main.sum($${m.name})` && expected.numericTotals && expected.numericTotals[m.name]!==undefined){
      const diff=Math.abs(Number(metrics[m.name])-expected.numericTotals[m.name]);
      if(diff>Math.max(0.01,Math.abs(expected.numericTotals[m.name])*1e-9))throw new Error('Metric total mismatch '+name+'/'+m.name);
    }
  }
  results.push({cube:cube.name,title:cube.title,rows:n,stores:expected.byStore,fieldsTested:fields.length,metricsTested:measures.length,metrics,sourceMinTime:expected.minTime,sourceMaxTime:expected.maxTime,status:'passed'});
  console.log(`${cube.name}: ${n} rows, ${fields.length} dimensions, ${measures.length} measures OK`);
}
const report={verifiedAt:new Date().toISOString(),url,run:latest.run,status:'passed',results};
const firstPath=join(dirname(latest.manifestPath),'verification.json');
const output=existsSync(firstPath)?join(dirname(latest.manifestPath),`verification.${Date.now()}.json`):firstPath;
writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
console.log('VERIFIED '+results.length+' cubes');

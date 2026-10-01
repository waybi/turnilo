#!/usr/bin/env node
// Read-only time-filter regression: served BI must match the current immutable snapshot.
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $, r } from 'plywood';
const here=path.dirname(fileURLToPath(import.meta.url));
const latest=JSON.parse(fs.readFileSync(path.join(here,'data/latest-run.json')));
const root=path.dirname(latest.manifestPath);
const from=process.argv[2]||'2026-09-25';
const to=process.argv[3]||'2026-10-01';
if(![from,to].every(s=>/^\d{4}-\d{2}-\d{2}$/.test(s))||from>to)throw Error('YYYY-MM-DD range required');
const start=new Date(from+'T00:00:00Z');const end=new Date(to+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+1);
const expected={'1号店':0,'2号店':0};
for await(const line of readline.createInterface({input:fs.createReadStream(path.join(root,'orders.json')),crlfDelay:Infinity})){
  if(!line)continue;const row=JSON.parse(line);if(row.time.slice(0,10)>=from&&row.time.slice(0,10)<=to)expected[row.store]++;
}
for(const [store,n] of Object.entries(expected)){
  const expression=$('main').filter($('store').is(r(store)).and($('time').greaterThanOrEqual(r(start))).and($('time').lessThan(r(end)))).count();
  const response=await fetch('http://127.0.0.1:9092/plywood',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataCube:'orders',expression:expression.toJS()}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok||data.result!==n)throw Error(JSON.stringify(data));
  console.log(store,from+'～'+to,n,'matches');
}
fs.writeFileSync(path.join(root,`recent-orders-check.${Date.now()}.json`),JSON.stringify({checkedAt:new Date().toISOString(),from,to,byStore:expected},null,2),{mode:0o600,flag:'wx'});

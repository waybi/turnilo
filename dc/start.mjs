#!/usr/bin/env node
// Resume the last complete version. No export or source mutation during startup.
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { composeGrowthConfig } from './growth-evidence/config.mjs';
import { writeWithDocs } from './measure-docs.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const latest=JSON.parse(readFileSync(join(root,'dc/data/latest-run.json'),'utf8'));
const baseConfig=resolve(latest.configPath);
if(dirname(baseConfig)!==join(root,'dc'))throw new Error('Unexpected config path');
// Optional frozen report evidence is added without changing the rolling snapshot pointer.
const composed=composeGrowthConfig(baseConfig);
// Fill every measure's hover explanation (description only; formulas and data untouched).
const config=writeWithDocs(composed,join(root,'dc/config.live.yaml')).outputPath;
const child=spawn(process.execPath,['--max-old-space-size=6144',join(root,'bin/turnilo'),'--config',config,'--port','9092','--server-host','127.0.0.1'],{cwd:root,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

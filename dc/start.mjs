#!/usr/bin/env node
// Resume the last complete version. No export or source mutation during startup.
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const latest=JSON.parse(readFileSync(join(root,'dc/data/latest-run.json'),'utf8'));
const config=resolve(latest.configPath);
if(dirname(config)!==join(root,'dc'))throw new Error('Unexpected config path');
const child=spawn(process.execPath,['--max-old-space-size=6144',join(root,'bin/turnilo'),'--config',config,'--port','9092','--server-host','127.0.0.1'],{cwd:root,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

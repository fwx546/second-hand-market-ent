import './sites-env.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Only migrate the local emulator. Hosted migrations are applied by Sites.
const builtPath=resolve('dist/server/wrangler.json');
if(!existsSync(builtPath)) throw new Error('请先运行 npm run build，再运行 npm run db:migrate。');
const config=JSON.parse(readFileSync(builtPath,'utf8'));
if(!config.d1_databases?.some(binding=>binding.binding==='DB')) throw new Error('构建配置未包含 DB，请检查 .openai/hosting.json 并重新构建。');
if(config.main) config.main=resolve(dirname(builtPath),config.main);
if(config.assets?.directory) config.assets.directory=resolve(dirname(builtPath),config.assets.directory);
config.d1_databases=config.d1_databases.map(binding=>({...binding,migrations_dir:resolve('drizzle')}));
const localConfig=resolve('.sites-runtime/local-migrations.wrangler.json');
mkdirSync(dirname(localConfig),{recursive:true});
writeFileSync(localConfig,JSON.stringify(config,null,2)+'\n');
const result=spawnSync(process.execPath,[
  resolve('node_modules/wrangler/bin/wrangler.js'),
  'd1','migrations','apply','DB','--local','--config',localConfig,
  '--persist-to',resolve('.wrangler/state'),
],{stdio:['ignore','inherit','inherit'],env:process.env});
if(result.error) throw result.error;
process.exitCode=result.status??1;

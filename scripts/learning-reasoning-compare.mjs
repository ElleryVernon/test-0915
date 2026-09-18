// Sequential, counterbalanced paired experiment. Never changes .env or product data.
import 'dotenv/config';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

if(!process.argv.includes('--allow-live')) throw Error('Requires --allow-live (bounded paid model calls).');
const args=process.argv.slice(2);
const at=args.indexOf('--out');
const out=resolve(at<0?'.unlazy/university-learning/reasoning-comparison':args[at+1]);
mkdirSync(out); // Never overwrite a previous experiment.
const binary=join(out,'learning-eval');
const build=spawnSync('go',['build','-o',binary,'./cmd/learning-eval'],{cwd:resolve('server'),stdio:'inherit'});
if(build.status!==0)process.exit(build.status??2);
const sequence=[['high','xhigh'],['xhigh','high'],['high','xhigh']];
const plan={version:1,model:process.env.OPENROUTER_MODEL,judgeEffort:'high',count:1,rounds:3,
 ids:['lehninger-enzyme-competitive','mcmurry-substitution-elimination'],
 tasks:['quiz','essay','cards','grade'],answers:['correct','misconception','keyword-only'],
 sequence,binarySHA256:createHash('sha256').update(readFileSync(binary)).digest('hex'),startedAt:new Date().toISOString()};
writeFileSync(join(out,'plan.json'),JSON.stringify(plan,null,2));
for(let round=0;round<sequence.length;round++)for(const effort of sequence[round]){
 const runDir=join(out,`round-${round+1}-${effort}`);
 const argv=['--allow-live','--cases',resolve('evals/university/cases.json'),'--split','dev','--ids',plan.ids.join(','),'--answers',plan.answers.join(','),'--tasks',plan.tasks.join(','),'--count','1','--jobs','1','--out',runDir];
 const r=spawnSync(binary,argv,{cwd:resolve('server'),env:{...process.env,OPENROUTER_REASONING_EFFORT:effort},stdio:'inherit'});
 if(r.status!==0&&r.status!==1)throw Error(`Evaluation infrastructure stopped: round ${round+1}, ${effort}, ${r.status}`);
}
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2;};
const output={plan,groups:[]};
for(const effort of ['high','xhigh']){
 const reports=sequence.map((_,r)=>JSON.parse(readFileSync(join(out,`round-${r+1}-${effort}`,'report.json'),'utf8')));
 if(reports.some(r=>r.reasoningEffort!==effort||r.judgeEffort!=='high'))throw Error('Effort mismatch');
 for(const task of ['all',...plan.tasks]){
 const rows=reports.flatMap(r=>r.results).filter(r=>task==='all'||r.task.split('/')[0]===task);
 const calls=rows.flatMap(r=>r.usage??[]).filter(u=>!u.task.startsWith('memoryz_eval_'));
 output.groups.push({effort,task,n:rows.length,passed:rows.filter(r=>!r.error&&!r.failures.length).length,errors:rows.filter(r=>r.error).length,
  medianSeconds:median(rows.map(r=>r.productDurationMs/1000)),meanSeconds:rows.reduce((n,r)=>n+r.productDurationMs/1000,0)/rows.length,
  minSeconds:Math.min(...rows.map(r=>r.productDurationMs/1000)),maxSeconds:Math.max(...rows.map(r=>r.productDurationMs/1000)),
  retries:rows.reduce((n,r)=>n+(r.retries?.length??0),0),providerCalls:calls.length,
  reasoningTokens:calls.reduce((n,u)=>n+u.reasoningTokens,0),reportedCostUSD:calls.reduce((n,u)=>n+(u.cost??0),0),providers:[...new Set(calls.map(u=>u.provider))]});
 }
}
writeFileSync(join(out,'comparison.json'),JSON.stringify(output,null,2));
console.log('REASONING_COMPARISON_COMPLETE',JSON.stringify(output.groups));

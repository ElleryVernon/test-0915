// Same-code paired comparison. Product model/provider vary; judge and contracts stay fixed.
import 'dotenv/config';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(!args.includes('--allow-live'))throw Error('Requires --allow-live: bounded paid model calls.');
const at=args.indexOf('--out');
if(at<0||!args[at+1])throw Error('--out is required');
const out=resolve(args[at+1]), resume=args.includes('--resume');
const providerAt=args.indexOf('--glm-provider');
const requestedProvider=providerAt<0?undefined:args[providerAt+1];
const providers={'baseten/fp8':'BaseTen','modal/fp8':'Modal',together:'Together'};
if(providerAt>=0&&!Object.hasOwn(providers,requestedProvider))throw Error('--glm-provider must be baseten/fp8, modal/fp8 or together');
const digest=b=>createHash('sha256').update(b).digest('hex');
const cases=resolve('evals/university/cases.json');
const binary=join(out,'learning-eval');
let plan;
if(resume){
 plan=JSON.parse(readFileSync(join(out,'plan.json'),'utf8'));
 if(plan.version!==2)throw Error('Old interleaved experiment preserved; use its saved v1 script or start a new staged comparison');
 if(digest(readFileSync(binary))!==plan.binarySHA256||digest(readFileSync(cases))!==plan.caseSHA256)throw Error('Frozen binary/cases changed');
 if(requestedProvider&&requestedProvider!==plan.variants.glm.provider)throw Error('Provider changed; start a new comparison directory');
}else{
 mkdirSync(out);
 const b=spawnSync('go',['build','-o',binary,'./cmd/learning-eval'],{cwd:resolve('server'),stdio:'inherit'});
 if(b.status!==0)process.exit(b.status??2);
 plan={version:2,startedAt:new Date().toISOString(),binarySHA256:digest(readFileSync(binary)),caseSHA256:digest(readFileSync(cases)),
  ids:['lehninger-enzyme-competitive','mcmurry-substitution-elimination'],tasks:['quiz','essay','cards','grade'],answers:['correct','misconception','keyword-only'],count:1,
  effort:'high',structuredMode:'json_schema',judgeModel:'openai/gpt-5.6-luna',judgeProviders:'openai/fast',qualityModel:'',
  variants:{luna:{model:'openai/gpt-5.6-luna',provider:'openai/fast',expectedProvider:'OpenAI'},glm:{model:'z-ai/glm-5.3-flash',provider:requestedProvider??'together',expectedProvider:providers[requestedProvider??'together']}},
  sequence:[['glm','luna'],['luna','glm'],['glm','luna']],runs:[]};
 writeFileSync(join(out,'plan.json'),JSON.stringify(plan,null,2));
}
// Finish all product calls before offline judging. A judge timeout cannot force
// regeneration, and successful quality refusals are retained in the denominator.
for(const phase of ['product','judge'])for(let round=0;round<plan.sequence.length;round++)for(const variant of plan.sequence[round]){
 if(plan.runs.some(r=>r.phase===phase&&r.round===round+1&&r.variant===variant&&r.complete))continue;
 const cfg=plan.variants[variant],attempt=plan.runs.filter(r=>r.phase===phase&&r.round===round+1&&r.variant===variant).length+1;
 const dir=join(out,`round-${round+1}-${variant}-${phase}-attempt-${attempt}`);
 const env={...process.env,OPENROUTER_MODEL:cfg.model,OPENROUTER_PROVIDER_ORDER:cfg.provider,OPENROUTER_QUALITY_MODEL:plan.qualityModel,
  OPENROUTER_STRUCTURED_MODE:plan.structuredMode,OPENROUTER_REASONING_EFFORT:plan.effort,AI_QUALITY_REVIEW:'true'};
 const flags=['--allow-live','--cases',cases,'--split','dev','--ids',plan.ids.join(','),'--tasks',plan.tasks.join(','),'--answers',plan.answers.join(','),
  '--count',String(plan.count),'--jobs','1','--stop-on-infrastructure-error','--judge-model',plan.judgeModel,'--judge-provider-order',plan.judgeProviders,'--out',dir];
 if(phase==='product')flags.push('--judge=false');
 else{
  const product=plan.runs.find(r=>r.phase==='product'&&r.round===round+1&&r.variant===variant&&r.complete);
  if(!product)throw Error('Missing completed product outputs');
  flags.push('--review-results',join(product.dir,'report.json'));
 }
 const r=spawnSync(binary,flags,{cwd:resolve('server'),env,stdio:'inherit'});
 const report=existsSync(join(dir,'report.json'))?JSON.parse(readFileSync(join(dir,'report.json'),'utf8')):null;
 const calls=(report?.results??[]).flatMap(x=>x.usage??[]).filter(u=>!u.task.startsWith('memoryz_eval_'));
 if(calls.some(u=>u.provider!==cfg.expectedProvider||u.effort!==plan.effort))throw Error('Actual provider/effort mismatch; comparison not valid');
 const complete=Boolean(report&&!report.incomplete&&report.tasks===12&&(r.status===0||r.status===1));
 plan.runs.push({phase,round:round+1,variant,attempt,dir,exit:r.status,complete});
 writeFileSync(join(out,'plan.json'),JSON.stringify(plan,null,2));
 if(!complete){console.log('MODEL_COMPARISON_BLOCKED: partial evidence retained; resume only after provider recovery.');process.exit(2);}
}
const median=ns=>{const a=[...ns].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const groups=[];
for(const variant of Object.keys(plan.variants))for(const task of ['all',...plan.tasks]){
 const rows=plan.runs.filter(r=>r.phase==='product'&&r.complete&&r.variant===variant).flatMap(r=>{
  const reviewed=plan.runs.find(x=>x.phase==='judge'&&x.complete&&x.variant===variant&&x.round===r.round);
  const judgments=JSON.parse(readFileSync(join(reviewed.dir,'report.json'),'utf8')).results;
  return JSON.parse(readFileSync(join(r.dir,'report.json'),'utf8')).results.map(item=>{
   const judged=judgments.find(j=>j.caseId===item.caseId&&j.task===item.task);
   if(!judged)throw Error('Incomplete review coverage');
   return {...item,judged};
  });
 }).filter(r=>task==='all'||r.task.split('/')[0]===task);
 const calls=rows.flatMap(r=>r.usage??[]).filter(u=>!u.task.startsWith('memoryz_eval_'));
 groups.push({variant,task,n:rows.length,passed:rows.filter(r=>!r.judged.error&&!r.judged.failures.length).length,generationErrors:rows.filter(r=>r.error).length,
  meanSeconds:rows.reduce((sum,r)=>sum+r.productDurationMs/1000,0)/rows.length,medianSeconds:median(rows.map(r=>r.productDurationMs/1000)),
  productCostUSD:calls.reduce((sum,u)=>sum+(u.cost??0),0),callsWithoutCost:calls.filter(u=>u.cost==null).length,
  retries:rows.reduce((sum,r)=>sum+(r.retries?.length??0),0),providers:[...new Set(calls.map(u=>u.provider))]});
}
writeFileSync(join(out,'comparison.json'),JSON.stringify({plan,groups},null,2));
console.log('MODEL_COMPARISON_COMPLETE',JSON.stringify(groups));

#!/usr/bin/env node
/** Reviewed contributor tooling. PR prose and candidate code are never executed. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMetadataApi } from './pr-project-metadata-api.mjs';
import { synchronizeMetadata } from './pr-project-metadata-sync.mjs';
import { CONFIG } from './pr-project-metadata.mjs';
import { createRoadmapApi, synchronizeDates } from './roadmap-dates-sync.mjs';
import { appNetworkError, NETWORK_EXIT_CODE } from './gh-app.mjs';

export function parseOptions(args) {
  const options={write:false,ci:false};const seen=new Set();
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if(seen.has(arg))throw new Error('Duplicate option.');seen.add(arg);
    if(arg==='--write')options.write=true;
    else if(arg==='--ci')options.ci=true;
    else if(arg==='--roadmap')options.roadmap=true;
    else if(arg==='--pr'||arg==='--issue'){
      const raw=args[++index];
      if(!/^[1-9]\d*$/.test(raw??'')||!Number.isSafeInteger(Number(raw)))throw new Error('Invalid issue/PR number.');
      options.number=Number(raw);
    } else throw new Error('Usage: node .agents/skills/jarvis-backlog/scripts/github/sync-pr-project-metadata.mjs [--pr NUMBER | --roadmap [--issue NUMBER]] [--write] [--ci]');
  }
  if((seen.has('--pr')&&options.roadmap)||(seen.has('--issue')&&!options.roadmap)||(seen.has('--pr')&&seen.has('--issue')))throw new Error('Use --pr for PR metadata or --roadmap with optional --issue.');
  return options;
}
export function assertCiContext(env) {
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==CONFIG.repository||env.GITHUB_REF!=='refs/heads/main'||
    env.GITHUB_WORKFLOW_REF!=='grasdouble/Jarvis/.github/workflows/pr-project-metadata.yml@refs/heads/main'||
    !['pull_request_target','issues','schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||!env.GH_TOKEN)
    throw new Error('CI authentication requires the trusted main workflow and an explicit installation token.');
}
export function requestError(error) {
  const network = appNetworkError(error);
  if (network) return network;
  // Inspect error classification internally; never emit raw stderr, headers, tokens or response bodies.
  const diagnostic=String(error.stderr??'');
  const safeToRetry=/HTTP 429|API rate limit exceeded|rate.?limit exceeded|resource limit/i.test(diagnostic);
  const ambiguous=error.code==='ETIMEDOUT'||/HTTP (502|503|504)/i.test(diagnostic);
  return Object.assign(new Error('GitHub request failed; inspect permissions or service availability.'),
    {retryable:safeToRetry||ambiguous,safeToRetry,ambiguous});
}
export async function main(args=process.argv.slice(2),env=process.env) {
  const options=parseOptions(args);
  if(options.ci)assertCiContext(env);
  else if(env.GITHUB_ACTIONS==='true')throw new Error('Use --ci in Actions; local Mac credentials are not a CI fallback.');
  const temporary=options.ci?mkdtempSync(path.join(tmpdir(),'jarvis-project-sync-')):null;
  const helper=fileURLToPath(new URL('./gh-app.mjs',import.meta.url));
  try {
    const childEnv={...env};
    for(const name of Object.keys(childEnv))if(name.startsWith('GIT_CONFIG_')||
      ['GH_DEBUG','GH_HOST','GH_REPO','GH_CONFIG_DIR','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','GIT_TRACE','GIT_TRACE_CURL','GIT_CURL_VERBOSE'].includes(name))delete childEnv[name];
    if(options.ci)Object.assign(childEnv,{GH_HOST:'github.com',GH_REPO:CONFIG.repository,GH_CONFIG_DIR:temporary,GH_PROMPT_DISABLED:'1'});
    const api=async request=>{
      if(request.write&&!options.write)throw new Error('Mutation is disabled in preview.');
      const ghArgs=['api',request.path,'--method',request.method,'--input','-'];
      try {
        const output=execFileSync(options.ci?'gh':process.execPath,options.ci?ghArgs:
          [helper,...(request.write?['--write']:[]),'--',...ghArgs],
          {input:JSON.stringify(request.body),encoding:'utf8',stdio:['pipe','pipe','pipe'],env:childEnv,timeout:45000,maxBuffer:16*1024*1024});
        return JSON.parse(output);
      } catch(error){throw requestError(error);}
    };
    const adapter=options.roadmap?createRoadmapApi({api}):createMetadataApi({api});
    const load=number=>adapter.load(options.number??number);
    const synchronize=options.roadmap?synchronizeDates:synchronizeMetadata;
    const result=await synchronize({load,apply:adapter.apply,write:options.write});
    console.log(JSON.stringify(result,null,2));
    return result.diagnostics.some(d=>d.severity==='error')?1:0;
  } finally {if(temporary)rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {process.exitCode=await main();}catch(error){console.error(error.message);process.exitCode=error.networkFailure?NETWORK_EXIT_CODE:1;}
}

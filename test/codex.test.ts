import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, CodexCredentialError, codexEnvironment, managedAuth, trustedCodexRunner, validRepository } from '../runner/src/codex';
import { decrypt, encrypt } from '../runner/src/google';
import { makeCaptions } from '../runner/src/captioner';

const key=Buffer.alloc(32,7).toString('base64');
const auth=(refresh='test-refresh-token')=>JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,last_refresh:'2026-11-07T10:00:00Z',tokens:{access_token:'test-access-token',refresh_token:refresh,id_token:'test-id-token'}});
const trusted:NodeJS.ProcessEnv={PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'TifahEfendijaM/Video-Publishing-Pipeline',GITHUB_REPOSITORY_ID:'1407843658',GITHUB_REPOSITORY_OWNER_ID:'50710040',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',VIDEO_CODEX_REPOSITORY_PRIVATE:'true'};
const repository={id:1407843658,full_name:'TifahEfendijaM/Video-Publishing-Pipeline',owner:{id:50710040},default_branch:'main',private:false};
const temporary:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const dir of temporary.splice(0))rmSync(dir,{recursive:true,force:true});});

function fixture(body:string, initial:string|null=null) {
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(repository)));
  const dir=mkdtempSync(join(tmpdir(),'fake-video-codex-'));temporary.push(dir);
  const executable=join(dir,'codex');
  writeFileSync(executable,`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');\nconst args=process.argv.slice(2),out=args[args.indexOf('--output-last-message')+1],authFile=path.join(process.env.CODEX_HOME,'auth.json');\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{${body}\n});\n`);
  chmodSync(executable,0o700);
  let ciphertext=initial ? encrypt(key,initial):null;
  const state={getCredential:vi.fn(async(_name:string)=>({credential:ciphertext?{ciphertext,updated_at:'now'}:null})),putCredential:vi.fn(async(_name:string,value:string)=>{ciphertext=value;return {ok:true};})};
  const client=new CodexClient({state,encryptionKey:key,seedAuth:auth(),env:{...trusted,OPENAI_API_KEY:'must-not-inherit',STATE_API_TOKEN:'must-not-inherit',VIDEO_CODEX_AUTH_JSON:'must-not-inherit',GH_TOKEN:'must-not-inherit'},executable,timeoutMs:3000});
  return {client,state,executable,saved:()=>ciphertext?decrypt(key,ciphertext):null};
}

describe('subscription Codex execution',()=>{
  it('refuses API credentials and incomplete account sign-ins',()=>{
    for(const value of ['{}','invalid',JSON.stringify({...JSON.parse(auth()),OPENAI_API_KEY:'api-key'}),JSON.stringify({...JSON.parse(auth()),auth_mode:'apikey'}),JSON.stringify({...JSON.parse(auth()),tokens:{access_token:'incomplete'}})])expect(()=>managedAuth(value)).toThrow(CodexCredentialError);
    expect(managedAuth(auth())).toBe(auth());
  });
  it('rejects fork, PR, non-main and unknown-visibility jobs before loading credentials',async()=>{
    const f=fixture('');
    for(const extra of [{VIDEO_CODEX_REPOSITORY_PRIVATE:''},{GITHUB_REPOSITORY_ID:'another-repo'},{GITHUB_REF:'refs/heads/untrusted'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_ACTIONS:'false'}]){
      const client=new CodexClient({state:f.state,encryptionKey:key,seedAuth:auth(),env:{...trusted,...extra}});
      await expect(client.verify()).rejects.toThrow(CodexCredentialError);
    }
    expect(f.state.getCredential).not.toHaveBeenCalled();
    expect(()=>trustedCodexRunner(trusted)).not.toThrow();
    expect(()=>trustedCodexRunner({...trusted,VIDEO_CODEX_REPOSITORY_PRIVATE:'false'})).not.toThrow();
  });
  it('accepts authorized public/private metadata and rejects renamed, transferred or unknown repositories',async()=>{
    expect(validRepository(repository)).toBe(true);
    expect(validRepository({...repository,private:true})).toBe(true);
    for(const changed of [{id:7},{owner:{id:7}},{full_name:'someone/else'},{default_branch:'other'},{private:null}])expect(validRepository({...repository,...changed})).toBe(false);
    const f=fixture('');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...repository,id:7})));
    await expect(f.client.verify()).rejects.toThrow(/verify the exact video repository/);
    expect(f.state.getCredential).not.toHaveBeenCalled();
  });
  it('uses isolated homes, removes provider/API secrets, and saves rotated credentials encrypted before returning',async()=>{
    const f=fixture(`
      const a=JSON.parse(fs.readFileSync(authFile,'utf8'));a.tokens.refresh_token='rotated-video-token';fs.writeFileSync(authFile,JSON.stringify(a));
      fs.writeFileSync(out,JSON.stringify({input,args,home:process.env.HOME,authDir:process.env.CODEX_HOME,cwd:process.cwd(),api:process.env.OPENAI_API_KEY,state:process.env.STATE_API_TOKEN,github:process.env.GH_TOKEN,seed:process.env.VIDEO_CODEX_AUTH_JSON,permissions:fs.statSync(authFile).mode&0o777}));
    `);
    const result=await f.client.run('Return JSON','filename data',{type:'object'}) as any;
    expect(result.input).toContain('filename data');
    expect(result.args).toContain('features.shell_tool=false');
    expect(result.args).toContain('web_search="disabled"');
    expect(result.args).toContain('read-only');
    expect(result.args).not.toContain('--model');
    expect(result.api).toBeUndefined();expect(result.state).toBeUndefined();expect(result.github).toBeUndefined();expect(result.seed).toBeUndefined();
    expect(result.permissions).toBe(0o600);
    expect(result.home).not.toBe(process.env.HOME);
    expect(existsSync(result.home)).toBe(false);expect(existsSync(result.authDir)).toBe(false);
    expect(JSON.parse(f.saved()!).tokens.refresh_token).toBe('rotated-video-token');
    expect(f.state.putCredential).toHaveBeenCalledOnce();
    expect(f.state.putCredential.mock.calls[0][0]).toBe('video_codex_auth');
    expect(f.state.putCredential.mock.calls[0][1]).not.toContain('rotated-video-token');
  });
  it('attaches only isolated JPEG candidates for visual inspection',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'codex-image-test-'));temporary.push(dir);
    const path=join(dir,'candidate.jpg');writeFileSync(path,Buffer.from([255,216,255,217]));
    const f=fixture("const image=args[args.indexOf('--image')+1];fs.writeFileSync(out,JSON.stringify({image,bytes:[...fs.readFileSync(image)]}));");
    const result=await f.client.run('Pick a frame','video',{},'default',[path]) as any;
    expect(result.image).not.toBe(path);expect(result.bytes).toEqual([255,216,255,217]);
    expect(existsSync(result.image)).toBe(false);expect(existsSync(path)).toBe(true);
  });
  it('uses stored credentials instead of an old seed, including after a failed model call',async()=>{
    const f=fixture(`const a=JSON.parse(fs.readFileSync(authFile,'utf8'));if(a.tokens.refresh_token!=='stored-video-token')process.exit(3);a.tokens.refresh_token='refreshed-after-failure';fs.writeFileSync(authFile,JSON.stringify(a));process.exit(1);`,auth('stored-video-token'));
    await expect(f.client.run('','',{})).rejects.toThrow(/CLI failed/);
    expect(JSON.parse(f.saved()!).tokens.refresh_token).toBe('refreshed-after-failure');
  });
  it('persists authentication on spawn errors, malformed output and timeouts',async()=>{
    const missing=fixture('');
    await expect(new CodexClient({state:missing.state,encryptionKey:key,seedAuth:auth(),env:trusted,executable:join(missing.executable,'missing')}).run('','',{})).rejects.toThrow(/could not start/);
    expect(missing.state.putCredential).toHaveBeenCalledOnce();
    const malformed=fixture("fs.writeFileSync(out,'not JSON');");
    await expect(malformed.client.run('','',{})).rejects.toThrow(/structured JSON/);
    expect(malformed.state.putCredential).toHaveBeenCalledOnce();
    const timed=fixture('setInterval(()=>{},1000);');
    await expect(new CodexClient({state:timed.state,encryptionKey:key,seedAuth:auth(),env:trusted,executable:timed.executable,timeoutMs:150}).run('','',{})).rejects.toThrow(/timed out|interrupted/);
    expect(timed.state.putCredential).toHaveBeenCalledOnce();
  });
  it('treats failed credential persistence as fatal, including when generating captions',async()=>{
    const f=fixture("fs.writeFileSync(out,'{}');");
    f.state.putCredential.mockRejectedValueOnce(new Error('storage failed'));
    await expect(makeCaptions('Ordering coffee in Bosnian.mp4',{model:'Codex CLI',run:(sys,user)=>f.client.run(sys,user,{}),isFatalError:e=>e instanceof CodexCredentialError})).rejects.toThrow(/publishing was stopped/);
  });
  it('rejects an unconfirmed credential save',async()=>{
    const f=fixture("fs.writeFileSync(out,'{}');");
    f.state.putCredential.mockImplementationOnce(async()=>({ok:true}));
    await expect(f.client.run('','',{})).rejects.toThrow(CodexCredentialError);
  });
  it('allowlists environment variables instead of copying runner credentials',()=>{
    expect(codexEnvironment({PATH:'/bin',OPENAI_API_KEY:'secret',HOME:'/original',CODEX_HOME:'/original',BUFFER_API_KEY:'secret'},'/isolated','/auth')).toEqual({PATH:'/bin',HOME:'/isolated',TMPDIR:'/isolated',CODEX_HOME:'/auth'});
  });
  it('fails before starting Codex if storage encryption is misconfigured',async()=>{
    const f=fixture('process.exit(99);');
    await expect(new CodexClient({state:f.state,encryptionKey:'invalid',seedAuth:auth(),env:trusted,executable:f.executable}).run('','',{})).rejects.toThrow(CodexCredentialError);
    expect(f.state.putCredential).not.toHaveBeenCalled();
  });
});

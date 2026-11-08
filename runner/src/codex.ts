// Subscription-only Codex execution. Provider credentials stay in the parent process.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt } from './google';
import { registerSecret } from '../../src/shared/redact';
import type { StateClient } from './state-client';

const CREDENTIAL = 'video_codex_auth';
export class CodexCredentialError extends Error {}

/** A new sign-in dedicated to this pipeline; never use another pipeline or desktop session. */
export function managedAuth(text: string): string {
  try {
    if (Buffer.byteLength(text) > 12000) throw new Error();
    const auth = JSON.parse(text);
    if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || !auth.last_refresh) throw new Error();
    for (const key of ['access_token', 'refresh_token', 'id_token']) {
      const token = auth.tokens?.[key];
      if (typeof token !== 'string' || !token.trim()) throw new Error();
      registerSecret(token);
    }
    registerSecret(text);
    return text;
  } catch {
    throw new CodexCredentialError('A dedicated video-pipeline ChatGPT sign-in is required; API keys are refused');
  }
}

export function trustedCodexRunner(env: NodeJS.ProcessEnv) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'TifahEfendijaM/Video-Publishing-Pipeline'
      || env.GITHUB_REPOSITORY_ID !== '1407843658' || env.GITHUB_REPOSITORY_OWNER_ID !== '50710040'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new CodexCredentialError('Subscription Codex runs only in this repository’s main-branch workflow_dispatch jobs');
  }
  // Public visibility is explicitly authorized for this exact personal pipeline.
  if (!['true', 'false'].includes(env.VIDEO_CODEX_REPOSITORY_PRIVATE ?? '')) {
    throw new CodexCredentialError('Repository visibility is unknown; no account credentials were loaded');
  }
}

export function validRepository(value: unknown): boolean {
  const repo = value as {id?:unknown;full_name?:unknown;owner?:{id?:unknown};default_branch?:unknown;private?:unknown} | null;
  return !!repo && repo.id === 1407843658 && repo.full_name === 'TifahEfendijaM/Video-Publishing-Pipeline'
    && repo.owner?.id === 50710040 && repo.default_branch === 'main' && typeof repo.private === 'boolean';
}

export function codexEnvironment(env: NodeJS.ProcessEnv, home: string, authDir: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (env[name]) child[name] = env[name];
  return { ...child, HOME: home, TMPDIR: home, CODEX_HOME: authDir };
}

interface Options {
  state: Pick<StateClient, 'getCredential' | 'putCredential'>;
  encryptionKey: string;
  seedAuth?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  timeoutMs?: number;
}

export class CodexClient {
  constructor(private options: Options) {}

  private encrypted(auth: string): string {
    try { return encrypt(this.options.encryptionKey, auth); }
    catch { throw new CodexCredentialError('A valid 32-byte CREDENTIALS_ENCRYPTION_KEY is required before using Codex'); }
  }

  private async verifyRepository(): Promise<void> {
    const env = this.options.env ?? process.env;
    trustedCodexRunner(env);
    try {
      const response = await fetch('https://api.github.com/repos/TifahEfendijaM/Video-Publishing-Pipeline', {
        headers: {accept:'application/vnd.github+json', ...(env.GITHUB_TOKEN ? {authorization:`Bearer ${env.GITHUB_TOKEN}`} : {})},
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok || !validRepository(await response.json())) throw new Error();
    } catch {
      throw new CodexCredentialError('Could not verify the exact video repository, owner and default branch; Codex was stopped');
    }
  }

  private async auth(): Promise<string> {
    await this.verifyRepository();
    try {
      const stored = (await this.options.state.getCredential(CREDENTIAL)).credential;
      return managedAuth(stored ? decrypt(this.options.encryptionKey, stored.ciphertext) : this.options.seedAuth ?? '');
    } catch (e) {
      if (e instanceof CodexCredentialError) throw e;
      throw new CodexCredentialError('Could not load the video Codex sign-in from encrypted storage');
    }
  }

  async verify(): Promise<void> {
    // Validate storage encryption before allowing a call that could rotate the refresh token.
    this.encrypted(await this.auth());
  }

  async run(system: string, user: string, schema: object, model = 'default'): Promise<unknown> {
    const auth = await this.auth();
    this.encrypted(auth);
    const directory = mkdtempSync(join(tmpdir(), 'eb-video-codex-'));
    chmodSync(directory, 0o700);
    const home = join(directory, 'home'), authDir = join(directory, 'auth'), work = join(directory, 'work');
    try {
      for (const dir of [home, authDir, work]) mkdirSync(dir, { mode: 0o700 });
      const authFile = join(authDir, 'auth.json'), output = join(work, 'result.json'), contract = join(work, 'schema.json');
      writeFileSync(authFile, auth, { mode: 0o600 });
      writeFileSync(contract, JSON.stringify(schema), { mode: 0o600 });
      const args = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--cd', work, '--color', 'never',
        '-c', 'approval_policy="never"', '-c', 'cli_auth_credentials_store="file"', '-c', 'web_search="disabled"',
        '-c', 'forced_login_method="chatgpt"', '-c', 'features.remote_plugin=false',
        '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
        '--output-schema', contract, '--output-last-message', output];
      if (model && model !== 'default') args.push('--model', model);
      args.push('-');
      try {
        await new Promise<void>((resolve, reject) => {
          let child;
          try {
            child = spawn(this.options.executable ?? 'codex', args, {
              cwd: work, env: codexEnvironment(this.options.env ?? process.env, home, authDir),
              stdio: ['pipe', 'ignore', 'ignore'], timeout: this.options.timeoutMs ?? 300000, killSignal: 'SIGKILL',
            });
          } catch {
            reject(new Error('Codex CLI could not start; check the pinned CLI installation'));
            return;
          }
          child.on('error', () => reject(new Error('Codex CLI could not start; check the pinned CLI installation')));
          child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(signal ? 'Codex CLI timed out or was interrupted' : 'Codex CLI failed; check subscription availability and sign-in')));
          child.stdin.on('error', () => {});
          child.stdin.end(`${system}\n\nINPUT DATA:\n${user}`);
        });
      } finally {
        // Refresh can happen even on a failed/timed-out request. Persist before returning or falling back.
        try {
          await this.verifyRepository();
          const updated = managedAuth(readFileSync(authFile, 'utf8'));
          const ciphertext = encrypt(this.options.encryptionKey, updated);
          await this.options.state.putCredential(CREDENTIAL, ciphertext);
          const saved = (await this.options.state.getCredential(CREDENTIAL)).credential;
          if (saved?.ciphertext !== ciphertext) throw new Error();
        } catch {
          throw new CodexCredentialError('Could not preserve the refreshed video Codex sign-in; publishing was stopped. Sign in again before retrying');
        }
      }
      const result = readFileSync(output, 'utf8');
      if (Buffer.byteLength(result) > 100000) throw new Error('Codex returned an oversized result');
      try { return JSON.parse(result); }
      catch { throw new Error('Codex did not return valid structured JSON'); }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

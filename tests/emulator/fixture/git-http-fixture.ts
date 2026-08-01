/**
 * Hermetic git smart-HTTP fixture: a Node HTTP server fronting the real
 * `git http-backend` CGI so the product's push path is proved against the
 * actual wire protocol (info/refs advertisement, upload-pack, receive-pack)
 * with real credential, ref, and hook semantics -- no live git host.
 *
 * Auth is HTTP Basic exactly as GitHub speaks it for token pushes
 * (`x-access-token:<token>`); the fixture records every attempt so tests can
 * assert which tokens were offered on the wire and in what order.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

export interface AuthAttempt {
  pathname: string;
  service: string;
  username: string;
  token: string;
  accepted: boolean;
}

export interface RemoteRepo {
  name: string;
  /** Bare repository path on disk (server side). */
  barePath: string;
  /** Anonymous HTTP clone/push URL for this repo. */
  url: string;
  /** Tokens the server accepts for this repo (mutable per test). */
  acceptTokens: Set<string>;
}

export interface GitHttpFixture {
  baseUrl: string;
  authAttempts: AuthAttempt[];
  /** Create a bare repo seeded with one commit on `main`, served over HTTP. */
  createRemoteRepo(name: string, options: { acceptTokens: string[] }): Promise<RemoteRepo>;
  /** Install a pre-receive hook that rejects every push with the message. */
  installRejectingPreReceiveHook(repo: RemoteRepo, message: string): Promise<void>;
  /** Advance `main` on the server by one commit (filesystem path, not HTTP). */
  advanceRemoteMain(repo: RemoteRepo, fileName: string): Promise<string>;
  /** rev-parse a ref in the server-side bare repo ('' when missing). */
  revParse(repo: RemoteRepo, ref: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Token the fixture always accepts, used only to bootstrap working clones.
 * Tests exclude it (and git's anonymous first probe) from wire assertions so
 * only the service's own push credentials remain.
 */
export const CLONE_BOOTSTRAP_TOKEN = 'clone-bootstrap-token';

/** Env that makes child git deterministic: no global/system config, no credential helpers, no prompts. */
export function hermeticGitEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Neutralize any OS-level credential helper (osxkeychain, manager) so the
    // only credentials on the wire are the ones embedded in the remote URL.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'user.name',
    GIT_CONFIG_VALUE_1: 'Fixture Seed',
    GIT_CONFIG_KEY_2: 'user.email',
    GIT_CONFIG_VALUE_2: 'seed@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
  };
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8' });
  return stdout;
}

export async function startGitHttpFixture(): Promise<GitHttpFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws10-git-http-'));
  const reposRoot = path.join(root, 'repos');
  const homeDir = path.join(root, 'home');
  await mkdir(reposRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const env = hermeticGitEnv(homeDir);

  const repos = new Map<string, RemoteRepo>();
  const authAttempts: AuthAttempt[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const repoMatch = /^\/([^/]+\.git)(\/.*)$/.exec(url.pathname);
    const repo = repoMatch ? repos.get(repoMatch[1]!) : undefined;
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such repository\n');
      return;
    }

    const service =
      url.searchParams.get('service') ??
      (url.pathname.endsWith('/git-receive-pack')
        ? 'git-receive-pack'
        : url.pathname.endsWith('/git-upload-pack')
          ? 'git-upload-pack'
          : '');

    // HTTP Basic auth, GitHub token-push shape: x-access-token:<token>.
    const header = req.headers.authorization ?? '';
    const basicMatch = /^Basic (.+)$/.exec(header);
    const decoded = basicMatch ? Buffer.from(basicMatch[1]!, 'base64').toString('utf8') : '';
    const separator = decoded.indexOf(':');
    const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const token = separator >= 0 ? decoded.slice(separator + 1) : '';
    const accepted = username === 'x-access-token' && repo.acceptTokens.has(token);
    authAttempts.push({ pathname: url.pathname, service, username, token, accepted });
    if (!accepted) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="ws10-git-fixture"',
        'content-type': 'text/plain'
      });
      res.end('authentication required\n');
      return;
    }

    // Buffer the request body (decompressing gzip: git gzips small bodies)
    // so the CGI child gets an exact CONTENT_LENGTH.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if ((req.headers['content-encoding'] ?? '') === 'gzip') {
        body = gunzipSync(body);
      }
      const child = execFile(
        'git',
        ['http-backend'],
        {
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...env,
            GIT_PROJECT_ROOT: reposRoot,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method ?? 'GET',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.searchParams.toString(),
            CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: username,
            REMOTE_ADDR: '127.0.0.1'
          }
        },
        (error, stdout) => {
          if (error && stdout.length === 0) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('git http-backend failed\n');
            return;
          }
          // Split CGI headers from the payload.
          const headerEnd = stdout.indexOf('\r\n\r\n');
          const rawHeaders = stdout.subarray(0, headerEnd).toString('utf8');
          const payload = stdout.subarray(headerEnd + 4);
          let status = 200;
          const outHeaders: Record<string, string> = {};
          for (const line of rawHeaders.split('\r\n')) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const key = line.slice(0, idx).trim().toLowerCase();
            const value = line.slice(idx + 1).trim();
            if (key === 'status') status = Number.parseInt(value, 10) || 200;
            else outHeaders[key] = value;
          }
          res.writeHead(status, outHeaders);
          res.end(payload);
        }
      );
      child.stdin?.end(body);
    });
  });

  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let seedCounter = 0;

  return {
    baseUrl,
    authAttempts,
    async createRemoteRepo(name, options) {
      const bareName = `${name}.git`;
      const barePath = path.join(reposRoot, bareName);
      await git(['init', '--bare', '--initial-branch=main', barePath], reposRoot, env);
      // Authenticated pushes require receive-pack enabled for this repo.
      await git(['config', 'http.receivepack', 'true'], barePath, env);
      // Seed one commit on main through a scratch clone over the filesystem.
      const seed = path.join(root, `seed-${(seedCounter += 1)}`);
      await git(['clone', barePath, seed], root, env);
      await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
      await git(['add', 'README.md'], seed, env);
      await git(['commit', '-m', 'seed'], seed, env);
      await git(['push', 'origin', 'HEAD:refs/heads/main'], seed, env);
      const repo: RemoteRepo = {
        name,
        barePath,
        url: `${baseUrl}/${bareName}`,
        acceptTokens: new Set([...options.acceptTokens, CLONE_BOOTSTRAP_TOKEN])
      };
      repos.set(bareName, repo);
      return repo;
    },
    async installRejectingPreReceiveHook(repo, message) {
      const hookPath = path.join(repo.barePath, 'hooks', 'pre-receive');
      writeFileSync(hookPath, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
      await chmod(hookPath, 0o755);
    },
    async advanceRemoteMain(repo, fileName) {
      // Filesystem-path push: server-side advance, deliberately not HTTP.
      const scratch = path.join(root, `advance-${(seedCounter += 1)}`);
      await git(['clone', '--branch', 'main', repo.barePath, scratch], root, env);
      await writeFile(path.join(scratch, fileName), `${fileName}\n`);
      await git(['add', fileName], scratch, env);
      await git(['commit', '-m', `advance: ${fileName}`], scratch, env);
      await git(['push', 'origin', 'HEAD:refs/heads/main'], scratch, env);
      return (await git(['rev-parse', 'HEAD'], scratch, env)).trim();
    },
    async revParse(repo, ref) {
      try {
        return (await git(['rev-parse', ref], repo.barePath, env)).trim();
      } catch {
        return '';
      }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

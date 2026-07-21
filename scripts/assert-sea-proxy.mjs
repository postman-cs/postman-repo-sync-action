import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

const [binary, expectedAuthority, ...binaryArgs] = process.argv.slice(2);
if (!binary || !expectedAuthority) {
  throw new Error('usage: node scripts/assert-sea-proxy.mjs <binary> <host:port> [binary args...]');
}

const observed = [];
let child;
let stdout = '';
let stderr = '';

await new Promise((resolve, reject) => {
  let settled = false;
  const server = createServer((_request, response) => {
    response.writeHead(502);
    response.end();
  });
  const timer = setTimeout(() => {
    fail(new Error(`SEA did not proxy ${expectedAuthority}; observed: ${observed.join(', ') || 'none'}`));
  }, 10_000);

  function close(callback) {
    clearTimeout(timer);
    child?.kill('SIGKILL');
    server.close(callback);
  }

  function pass() {
    if (settled) return;
    settled = true;
    close(resolve);
  }

  function fail(error) {
    if (settled) return;
    settled = true;
    close(() => reject(error));
  }

  server.on('connect', (request, socket) => {
    const authority = request.url ?? '';
    observed.push(authority);
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    if (authority === expectedAuthority) pass();
  });
  server.on('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail(new Error('proxy smoke server did not expose a TCP port'));
      return;
    }

    const proxy = `http://127.0.0.1:${address.port}`;
    child = spawn(binary, binaryArgs, {
      env: {
        PATH: '/nonexistent',
        HOME: process.env.RUNNER_TEMP ?? '/tmp',
        TMPDIR: process.env.RUNNER_TEMP ?? '/tmp',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        POSTMAN_ACTIONS_TELEMETRY: 'off'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      if (settled) return;
      fail(
        new Error(
          `SEA exited before proxying ${expectedAuthority} (code=${code}, signal=${signal})\n${stdout}${stderr}`
        )
      );
    });
  });
});

console.log(`SEA proxy routing verified: ${expectedAuthority}`);

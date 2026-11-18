// Shared test helpers: boot the server in-process on an ephemeral port with a
// temp DB directory, and provide an HTTP client.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
}

let booted = null;
let booting = null;

// Starts the server in-process. The server's module sets up the DB at import
// time from WA_* env vars, which we set before import (cache-busted).
// Boots exactly once per process; concurrent calls share the same instance.
export async function startServer() {
  if (booted) return booted;
  if (booting) return booting;
  booting = (async () => {
    const dir = tmpdir();
    const port = 8900 + Math.floor(Math.random() * 500);
    process.env.WA_HOST = '127.0.0.1';
    process.env.WA_PORT = String(port);
    process.env.WA_DATA_DIR = dir;
    process.env.WA_HASH_SALT = 'test-salt';
    process.env.WA_SNIPPET_PATH = '/wa.js';
    process.env.WA_COLLECT_PATH = '/api/collect';

    const srvPath = path.resolve(import.meta.dirname, '..', 'src', 'server.js');
    const mod = await import(`file://${srvPath}?cachebust=${Date.now()}`);
    const server = mod.createServer();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

    booted = {
      port,
      dir,
      db: mod.__db,
      server,
      request,
      stop: () => {
        try {
          server.close();
        } catch {}
        booted = null;
      },
    };
    booting = null;
    return booted;
  })();
  return booting;
}

// Close the shared server so the test runner can exit cleanly.
export async function stopServer() {
  const b = await startServer();
  b.stop();
}

export async function request(method, url, body, headers = {}) {
  const { port } = await startServer();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: { 'content-type': 'application/json', ...headers },
        // One connection per request: the shared default agent keeps completed
        // sockets in a free pool with a keepAliveMsecs (1s) timeout whose
        // expiry races a later request in suites where sibling tests run for
        // >1s (long streaming exports), surfacing as a spurious client-side
        // ECONNRESET. Closing per request keeps the suites deterministic.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            text: () => buf.toString('utf8'),
            json: () => JSON.parse(buf.toString('utf8') || 'null'),
          });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Simulated glimpse of an event payload — mimics the browser snippet.
export function pageview(overrides = {}) {
  return {
    path: '/',
    referrer: '',
    title: '',
    sw: 1920,
    sh: 1080,
    lang: 'en',
    ...overrides,
  };
}

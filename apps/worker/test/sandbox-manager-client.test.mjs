import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { setInterval, clearInterval } from 'node:timers';
import { execFileSync } from 'node:child_process';
import { createSandboxManagerHttpClient } from '../dist/sandbox-manager-client.js';

function certificates() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-mtls-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  writeFileSync(join(dir, 'worker.ext'), 'subjectAltName=URI:spiffe://jarvis/worker\nextendedKeyUsage=clientAuth\n');
  writeFileSync(join(dir, 'wrong.ext'), 'subjectAltName=URI:spiffe://jarvis/not-worker\nextendedKeyUsage=clientAuth\n');
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=synthetic-test-ca', '-days', '1');
  for (const name of ['server', 'worker', 'wrong']) {
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', name === 'server' ? 'server.ext' : `${name}.ext`);
  }
  const read = (name) => readFileSync(join(dir, name));
  return { dir, ca: read('ca.crt'), serverCert: read('server.crt'), serverKey: read('server.key'), workerCert: read('worker.crt'), workerKey: read('worker.key'), wrongCa: read('wrong.crt'), wrongKey: read('wrong.key') };
}

test('sandbox-manager HTTPS client authenticates both TLS peers and sends the closed fixed contract', async (t) => {
  const cert = certificates(); t.after(() => rmSync(cert.dir, { recursive: true, force: true }));
  const calls = [];
  let createResponse = { sandboxId: '11111111-1111-4111-8111-111111111111', state: 'running' };
  const server = https.createServer({ key: cert.serverKey, cert: cert.serverCert, ca: cert.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    if (req.socket.getPeerCertificate().subjectaltname !== 'URI:spiffe://jarvis/worker') { req.socket.destroy(); return; }
    calls.push({ method: req.method, url: req.url, worker: req.socket.getPeerCertificate().subjectaltname });
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      if (req.url === '/v1/sandboxes' && req.method === 'POST') {
        calls.at(-1).body = body; calls.at(-1).key = req.headers['idempotency-key'];
        res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(createResponse));
      } else if (req.url === '/v1/sandboxes/resolve' && req.method === 'POST') {
        calls.at(-1).body = body; calls.at(-1).key = req.headers['idempotency-key'];
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sandboxId: '11111111-1111-4111-8111-111111111111' }));
      } else if (req.url === '/v1/sandboxes/11111111-1111-4111-8111-111111111111/cancel') {
        calls.at(-1).body = body; res.writeHead(204); res.end();
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const endpoint = new URL(`https://127.0.0.1:${server.address().port}`);
  const client = createSandboxManagerHttpClient({ endpoint, key: cert.workerKey, cert: cert.workerCert, ca: cert.ca, timeoutMs: 1000 });
  const spec = { taskId: 't', attemptId: 'a', snapshotId: 's', profileId: 'p', modelProfileId: 'm', deadline: '2030-01-01T00:00:00.000Z', leaseEpoch: 4 };
  assert.deepEqual(await client.create(spec, 't:a:4'), { sandboxId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(await client.findByIdempotencyKey(spec, 't:a:4'), '11111111-1111-4111-8111-111111111111');
  await client.cancel('11111111-1111-4111-8111-111111111111', 4);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [['POST', '/v1/sandboxes'], ['POST', '/v1/sandboxes/resolve'], ['POST', '/v1/sandboxes/11111111-1111-4111-8111-111111111111/cancel']]);
  assert.equal(calls[0].worker, 'URI:spiffe://jarvis/worker'); assert.deepEqual(calls[0].body, spec); assert.equal(calls[0].key, 't:a:4'); assert.deepEqual(calls[1].body, spec); assert.deepEqual(calls[2].body, { leaseEpoch: 4 });
  for (const invalid of [{}, { sandboxId: 'not-a-uuid', state: 'running' }, { sandboxId: '11111111-1111-4111-8111-111111111111', state: 'running', extra: 'untrusted' }, { sandboxId: 7, state: 'running' }, { sandboxId: '11111111-1111-4111-8111-111111111111' }, { sandboxId: '11111111-1111-4111-8111-111111111111', state: 7 }]) {
    createResponse = invalid;
    await assert.rejects(client.create(spec, 'bad-response'), /invalid response/);
  }
  const badCaClient = createSandboxManagerHttpClient({ endpoint, key: cert.workerKey, cert: cert.workerCert, ca: cert.wrongCa, timeoutMs: 1000 });
  await assert.rejects(badCaClient.create(spec, 'x'), /Sandbox manager request failed/);
  const badWorker = createSandboxManagerHttpClient({ endpoint, key: cert.wrongKey, cert: cert.wrongCa, ca: cert.ca, timeoutMs: 1000 });
  await assert.rejects(badWorker.create(spec, 'x'), /Sandbox manager request failed/);
  assert.throws(() => createSandboxManagerHttpClient({ endpoint: new URL('http://127.0.0.1'), key: cert.workerKey, cert: cert.workerCert, ca: cert.ca, timeoutMs: 1000 }), /HTTPS/);
  for (const malformed of ['https://user:pass@127.0.0.1/', 'https://127.0.0.1/path', 'https://127.0.0.1/?token=x', 'https://127.0.0.1/#fragment']) {
    assert.throws(() => createSandboxManagerHttpClient({ endpoint: new URL(malformed), key: cert.workerKey, cert: cert.workerCert, ca: cert.ca, timeoutMs: 1000 }), /endpoint/);
  }
  assert.throws(() => createSandboxManagerHttpClient({ endpoint, key: cert.workerKey, cert: cert.workerCert, ca: cert.ca, timeoutMs: 10001 }), /timeout/);
});

test('sandbox-manager deadline is absolute across trickling response bytes', async (t) => {
  const cert = certificates(); t.after(() => rmSync(cert.dir, { recursive: true, force: true }));
  const server = https.createServer({ key: cert.serverKey, cert: cert.serverCert, ca: cert.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    res.write('{');
    const interval = setInterval(() => res.write(' '), 15);
    res.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const client = createSandboxManagerHttpClient({ endpoint: new URL(`https://127.0.0.1:${server.address().port}`), key: cert.workerKey, cert: cert.workerCert, ca: cert.ca, timeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(client.create({ taskId: 't', attemptId: 'a', snapshotId: 's', profileId: 'p', modelProfileId: 'm', deadline: '2030-01-01T00:00:00.000Z', leaseEpoch: 1 }, 't:a:1'), /Sandbox manager request failed/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 80 && elapsed < 500, `absolute request deadline took ${elapsed}ms`);
});

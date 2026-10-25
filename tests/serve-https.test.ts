import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const available = spawnSync('python3', ['--version']).status === 0 && spawnSync('openssl', ['version']).status === 0;
const NAME = 'qr-air-test';
const PORT = 20000 + (process.pid % 20000);

/** Resolves the Bonjour name to loopback so the certificate is checked against `NAME.local`. */
const lookup: LookupFunction = (_host, options, callback) => {
  const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
  if (options.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
};

function get(path: string, ca?: Buffer): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get({ hostname: `${NAME}.local`, port: PORT, path, ca, lookup, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
      })
      .on('error', reject);
  });
}

describe.skipIf(!available)('scripts/serve-https.py', () => {
  const home = mkdtempSync(join(tmpdir(), 'qr-air-home-'));
  const site = mkdtempSync(join(tmpdir(), 'qr-air-site-'));
  let server: ReturnType<typeof spawn> | undefined;
  let ca: Buffer;

  beforeAll(async () => {
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>QR Air</title>');
    writeFileSync(join(site, 'z.wasm'), Buffer.from([0, 97, 115, 109]));
    const proc = spawn('python3', ['scripts/serve-https.py', site, '--port', String(PORT), '--name', NAME], {
      env: { ...process.env, HOME: home },
    });
    server = proc;
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
      const onData = (d: Buffer): void => {
        out += d.toString();
        if (out.includes('Ctrl+C')) {
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${out}`)));
    });
    ca = readFileSync(join(home, '.qr-air-transfer', 'qr-air-ca.pem'));
  }, 30_000);

  afterAll(() => {
    server?.kill();
    rmSync(home, { recursive: true, force: true });
    rmSync(site, { recursive: true, force: true });
  });

  it('serves the app over TLS valid for <name>.local under the local CA', async () => {
    const page = await get('/', ca);
    expect(page.status).toBe(200);
    expect(page.body).toContain('QR Air');
    expect((await get('/z.wasm', ca)).type).toBe('application/wasm');
  });

  it('offers the CA certificate for installing on a phone', async () => {
    const res = await get('/qr-air-ca.crt', ca);
    expect(res.status).toBe(200);
    expect(res.type).toBe('application/x-x509-ca-cert');
    expect(res.body).toContain('BEGIN CERTIFICATE');
  });

  it('is rejected by clients that do not trust the CA', async () => {
    await expect(get('/')).rejects.toThrow(/certificate/i);
  });

  it('keeps private keys out of the served folder', async () => {
    expect((await get('/../.qr-air-transfer/ca-key.pem', ca)).status).toBe(404);
    expect((await get('/ca-key.pem', ca)).status).toBe(404);
  });

  it('restricts the CA to .local names and private networks', () => {
    const ext = spawnSync('openssl', ['x509', '-noout', '-ext', 'nameConstraints'], { input: ca }).stdout.toString();
    expect(ext).toContain('DNS:local');
    expect(ext).toContain('IP:192.168.0.0/255.255.0.0');
  });
});

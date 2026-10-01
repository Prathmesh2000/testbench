import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test helper only: a throwaway CA with a server and a client certificate, made with openssl at test
// time so no private key is ever committed. Not exported from the package.

export interface TestPki {
  ca: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** The client key encrypted with the passphrase "pass". */
  clientKeyEncrypted: string;
}

export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'tb-pki-'));
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Testbench Test CA');
    for (const [name, cn] of [['server', 'localhost'], ['client', 'api-tester']] as const) {
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`);
      ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2');
    }
    ssl('pkey', '-in', 'client.key', '-aes256', '-passout', 'pass:pass', '-out', 'client.enc.key');
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    return {
      ca: read('ca.pem'),
      serverCert: read('server.pem'),
      serverKey: read('server.key'),
      clientCert: read('client.pem'),
      clientKey: read('client.key'),
      clientKeyEncrypted: read('client.enc.key'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

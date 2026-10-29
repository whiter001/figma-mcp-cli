import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function randomString(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE S256 challenge for the given verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** A fresh RFC 7636 code verifier (43-128 chars, unreserved alphabet). */
export function createCodeVerifier(): string {
  return randomString(48); // 64 chars
}

export interface ProtectResult {
  /** 'dpapi' on Windows, 'aes' elsewhere. */
  method: 'dpapi' | 'aes';
  data: string;
}

/**
 * Run a PowerShell snippet, feeding `stdin` to it and collecting stdout.
 *
 * `child_process.execFile` cannot provide stdin — PowerShell's
 * `[Console]::In.ReadToEnd()` would block forever waiting for EOF, so the
 * process is spawned manually and stdin is explicitly closed.
 */
function runPowerShell(script: string, stdin: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`PowerShell 退出码 ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });

    // Closing stdin is what lets `[Console]::In.ReadToEnd()` return.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

/**
 * Encrypt a secret for the current user.
 * - Windows: DPAPI (CurrentUser scope) via PowerShell — the blob can only be
 *   decrypted by the same Windows user on the same machine.
 * - Others: AES-256-GCM with a local random key file (chmod 600).
 */
export async function protectSecret(plaintext: string, keyMaterial: string): Promise<ProtectResult> {
  if (process.platform === 'win32') {
    const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$b64 = [Console]::In.ReadToEnd()',
      '$plain = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))',
      '$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)',
      '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([System.Convert]::ToBase64String($protected))',
    ].join('; ');
    const out = await runPowerShell(script, b64);
    return { method: 'dpapi', data: out };
  }

  // AES-256-GCM: [12-byte iv][16-byte tag][ciphertext]
  const iv = randomBytes(12);
  const { createCipheriv } = await import('node:crypto');
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { method: 'aes', data: Buffer.concat([iv, tag, enc]).toString('base64') };
}

export async function unprotectSecret(
  blob: ProtectResult | string,
  keyMaterial: string,
): Promise<string> {
  const result: ProtectResult = typeof blob === 'string' ? { method: 'aes', data: blob } : blob;

  if (result.method === 'dpapi') {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$b64 = [Console]::In.ReadToEnd()',
      '$bytes = [System.Convert]::FromBase64String($b64)',
      '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))',
    ].join('; ');
    return runPowerShell(script, result.data);
  }

  const raw = Buffer.from(result.data, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const { createDecipheriv } = await import('node:crypto');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function deriveKey(material: string): Buffer {
  return createHash('sha256').update(material, 'utf8').digest();
}

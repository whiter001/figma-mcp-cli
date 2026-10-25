import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { protectSecret, unprotectSecret } from '../util/crypto.js';

export interface StoredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
}

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at?: number;
  scope?: string;
  id_token?: string;
}

export interface Credentials {
  version: 1;
  server: string;
  client: StoredClient;
  token: StoredToken;
}

interface CredentialsFile {
  version: 1;
  method: 'dpapi' | 'aes';
  payload: string;
}

export function configDir(): string {
  const override = process.env.FIGMA_MCP_HOME;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.figma-mcp');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

function keyPath(): string {
  return join(configDir(), 'key');
}

/** Local AES key, only used on non-Windows platforms. */
function localKey(): string {
  const path = keyPath();
  if (existsSync(path)) return readFileSync(path, 'utf8');
  const key = randomBytes(32).toString('base64');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return key;
}

function ensureDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function saveCredentials(creds: Credentials): Promise<string> {
  ensureDir();
  const { method, data } = await protectSecret(JSON.stringify(creds), localKey());
  const file: CredentialsFile = { version: 1, method, payload: data };
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return path;
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  const path = credentialsPath();
  if (!existsSync(path)) return undefined;
  let file: CredentialsFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
  } catch {
    throw new Error(`凭据文件损坏: ${path}`);
  }
  const plaintext = await unprotectSecret({ method: file.method, data: file.payload }, localKey());
  return JSON.parse(plaintext) as Credentials;
}

export function clearCredentials(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

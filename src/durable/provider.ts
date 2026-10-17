import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, getSupportedThinkingLevels, type Credential, type CredentialStore, type AuthOperationOptions, type Provider, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import lockfile from 'proper-lockfile';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

/** Explicitly selected private account store. pi-auth shares the legacy proper-lockfile protocol. */
interface CredentialFile { version: 1; account: string; credentials: Record<string, Credential> }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validCredential(value: unknown): value is Credential {
  if (!record(value)) return false;
  if (value.type === 'api_key') return typeof value.key === 'string' && value.key.length > 0;
  return value.type === 'oauth' && typeof value.access === 'string' && typeof value.refresh === 'string' && typeof value.expires === 'number' && Number.isFinite(value.expires);
}
async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Private configuration must be an owned mode-0600 file');
    const content = await file.readFile('utf8');
    try { return JSON.parse(content) as unknown; } catch { throw new Error('Invalid private configuration JSON'); }
  } finally { await file.close(); }
}
async function canonicalFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Explicit absolute configuration path required');
  return join(await realpath(dirname(path)), basename(path));
}

export class ScopedCredentialStore implements CredentialStore {
  private closed = false;
  readonly path: string;
  readonly account: string;
  private readonly lockTimeoutMs: number;
  private readonly format: "pi-auth" | "native";
  private constructor(path: string, account: string, lockTimeoutMs: number, format: "pi-auth" | "native") {
    this.path = path; this.account = account; this.lockTimeoutMs = lockTimeoutMs; this.format = format;
  }
  static async open(path: string, account: string, lockTimeoutMs = 30_000, format: "pi-auth" | "native" = "pi-auth"): Promise<ScopedCredentialStore> {
    if (!account.trim() || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) throw new Error('Invalid credential scope');
    const store = new ScopedCredentialStore(await canonicalFile(path), account, lockTimeoutMs, format);
    await store.change(async () => undefined);
    return store;
  }
  close(): void { this.closed = true; }
  private assertOpen(options?: AuthOperationOptions): void {
    if (this.closed) throw new Error('Credential store closed');
    options?.signal?.throwIfAborted();
  }
  private async load(): Promise<CredentialFile> {
    this.assertOpen();
    const value = await privateJson(this.path);
    if (this.format === 'pi-auth') {
      if (!record(value)) throw new Error('Invalid Pi credential file');
      return { version: 1, account: this.account, credentials: value as Record<string, Credential> };
    }
    if (!record(value) || value.version !== 1 || value.account !== this.account || !record(value.credentials) || !Object.values(value.credentials).every(validCredential)) throw new Error('Invalid native credential file or account scope');
    return value as unknown as CredentialFile;
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.assertOpen(options);
    const data = await this.change(async data => data, options);
    const credential = Object.hasOwn(data.credentials, providerId) ? data.credentials[providerId] : undefined;
    if (credential !== undefined && !validCredential(credential)) throw new Error('Unsupported selected provider credential');
    return credential;
  }
  async list(options?: AuthOperationOptions) {
    this.assertOpen(options);
    return Object.entries((await this.change(async data => data, options)).credentials).filter(([, credential]) => validCredential(credential)).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  /** Pi-auth interoperates with legacy writers; a five-second heartbeat also protects
   * against legacy synchronous callers whose stale threshold is ten seconds.
   * Native-envelope locks instead require explicit abandoned-writer reconciliation. */
  private async change<T>(fn: (data: CredentialFile) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (this.format === 'pi-auth') {
      let compromised: Error | undefined;
      let release: (() => Promise<void>) | undefined;
      const deadline = Date.now() + this.lockTimeoutMs;
      while (!release) {
        this.assertOpen(options);
        try {
          release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: 30_000, update: 5_000,
            onCompromised: error => { compromised = error; } });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
          if (Date.now() >= deadline) throw new Error('Credential refresh lock unavailable; reconcile the prior writer before retrying');
          await delay(20, undefined, options?.signal ? { signal: options.signal } : {});
        }
      }
      try {
        this.assertOpen(options);
        const data = await this.load();
        // Buffer writes until the refresh callback completes and ownership is rechecked.
        const original = JSON.stringify(data);
        const result = await fn(data);
        if (compromised) throw new Error('Credential lock compromised; refresh requires reconciliation');
        this.assertOpen(options);
        if (JSON.stringify(data) !== original) await this.save(data);
        if (compromised) throw new Error('Credential lock compromised; refresh requires reconciliation');
        return result;
      } finally { try { await release(); } catch { /* Compromised locks no longer belong to us. */ } }
    }
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      this.assertOpen(options);
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('Credential refresh lock unavailable; reconcile the prior writer before retrying');
        await delay(20, undefined, options?.signal ? { signal: options.signal } : {});
      }
    }
    try { this.assertOpen(options); return await fn(await this.load()); }
    finally { await rm(lock, { recursive: true }); }
  }
  private async save(data: CredentialFile): Promise<void> {
    this.assertOpen();
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(this.format === 'pi-auth' ? data.credentials : data)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerId)) throw new Error('Invalid provider ID');
    return this.change(async data => {
      const previous = Object.hasOwn(data.credentials, providerId) ? data.credentials[providerId] : undefined;
      if (previous !== undefined && !validCredential(previous)) throw new Error('Unsupported selected provider credential');
      const next = await fn(previous);
      this.assertOpen(options);
      if (next !== undefined) {
        if (!validCredential(next)) throw new Error('Invalid credential');
        data.credentials[providerId] = next;
        if (this.format === 'native') await this.save(data);
      }
      return next ?? previous;
    }, options);
  }
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.change(async data => { delete data.credentials[providerId]; if (this.format === 'native') await this.save(data); }, options);
  }
}

export interface NativeProviderSettings { version: 1; account: string; provider: string; modelId: string; thinkingLevel: ModelThinkingLevel; modelIds?: string[] }
export async function createNativeProvider(options: { credentialPath: string; settingsPath: string; account: string; provider?: Provider; credentialFormat?: "pi-auth" | "native" }) {
  const settings = await privateJson(await canonicalFile(options.settingsPath));
  if (!record(settings) || settings.version !== 1 || settings.account !== options.account || typeof settings.provider !== 'string' || typeof settings.modelId !== 'string' || typeof settings.thinkingLevel !== 'string' || Object.keys(settings).some(k => !['version', 'account', 'provider', 'modelId', 'thinkingLevel', 'modelIds'].includes(k))) throw new Error('Invalid per-instance provider settings');
  let provider = options.provider ?? (settings.provider === 'openai' ? openaiProvider() : settings.provider === 'anthropic' ? anthropicProvider() : settings.provider === 'openai-codex' ? openaiCodexProvider() : undefined);
  if (!provider) throw new Error('Unsupported native provider');
  if (settings.provider !== provider.id) throw new Error('Provider is not explicitly registered');
  if (settings.modelIds !== undefined) {
    const ids = settings.modelIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) throw new Error('Invalid selected model list');
    const catalog = provider.getModels();
    const selected = ids.map(id => {
      const model = catalog.find(model => model.id === id);
      if (!model) throw new Error('Unknown selected provider model');
      return model;
    });
    if (!ids.includes(settings.modelId)) throw new Error('Active model is outside the selected model list');
    provider = { ...provider, getModels: () => selected, getAllModels: () => selected };
  }
  const credentials = await ScopedCredentialStore.open(options.credentialPath, options.account, 30_000, options.credentialFormat);
  try {
    if (!await credentials.read(provider.id)) throw new Error('Selected account has no stored provider credential');
    const models = createModels({ credentials, authContext: { env: async () => { throw new Error('Ambient provider credentials are disabled'); }, fileExists: async () => false } });
    models.setProvider(provider);
    const model = models.getModel(provider.id, settings.modelId);
    if (!model) throw new Error('Unknown provider model');
    if (!getSupportedThinkingLevels(model).includes(settings.thinkingLevel as ModelThinkingLevel)) throw new Error('Unsupported model thinking level');
    return { models, provider, model: { provider: provider.id, modelId: model.id }, thinkingLevel: settings.thinkingLevel as ModelThinkingLevel, close: () => credentials.close() };
  } catch (error) { credentials.close(); throw error; }
}

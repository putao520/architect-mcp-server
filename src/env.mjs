import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function loadProvider(providerName = 'deepseek') {
  const configPath = resolve(process.env.HOME, '.gsc', 'providers', `${providerName}.json`);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return null; }
}

export function buildSdkEnv(providerName) {
  const provider = loadProvider(providerName);
  if (!provider) throw new Error(`Provider "${providerName}" not found. Create ~/.gsc/providers/${providerName}.json`);

  const env = {
    ANTHROPIC_BASE_URL: provider.endpoint,
    ANTHROPIC_AUTH_TOKEN: (provider.accounts || []).filter(a => a.enabled !== false)[0]?.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
  };

  if (provider.env) for (const e of provider.env) env[e.name] = e.value;

  return env;
}

export function getAccounts(providerName = 'deepseek') {
  const provider = loadProvider(providerName);
  if (!provider) return [];
  return (provider.accounts || []).filter(a => a.enabled !== false);
}

export function getEndpoint(providerName = 'deepseek') {
  const provider = loadProvider(providerName);
  return provider?.endpoint || null;
}

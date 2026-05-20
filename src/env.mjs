import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function loadProvider(providerName = 'kocode') {
  const configPath = resolve(process.env.HOME, '.gsc', 'providers', `${providerName}.json`);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return null; }
}

export function loadEnv() {
  const provider = loadProvider(process.env.ARCHITECT_PROVIDER || 'kocode');
  const env = { ...process.env };

  // 清理主 CC 特有配置
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_CODE_FORCE_EFFORT;

  if (!provider) return env;

  env.ANTHROPIC_BASE_URL = provider.endpoint;
  const enabled = (provider.accounts || []).filter(a => a.enabled !== false);
  if (enabled.length > 0) {
    env.ANTHROPIC_AUTH_TOKEN = enabled[0].token;
  }
  if (provider.env) {
    for (const e of provider.env) {
      env[e.name] = e.value;
    }
  }

  return env;
}

export function getAccounts(providerName = 'kocode') {
  const provider = loadProvider(providerName);
  if (!provider) return [];
  return (provider.accounts || []).filter(a => a.enabled !== false);
}

export function getEndpoint(providerName = 'kocode') {
  const provider = loadProvider(providerName);
  return provider?.endpoint || null;
}

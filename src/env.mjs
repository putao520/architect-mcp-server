import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

export function loadEnv() {
  const envScript = process.env.ARCHITECT_ENV_SCRIPT || `${process.env.HOME}/kocode.sh`;
  const env = { ...process.env };

  // 清理主 CC 特有配置，避免子 CC 继承后 API 报错
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_CODE_FORCE_EFFORT;

  // 直接设置优先
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
    return env;
  }

  // 从 sh 脚本加载（用 execFileSync 避免 shell 注入）
  if (existsSync(envScript)) {
    try {
      const output = execFileSync('bash', ['-c', `source '${envScript}' 2>/dev/null && env`], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      for (const line of output.split('\n')) {
        const m = line.match(/^(ANTHROPIC_\w+|CLAUDE_\w+|ENABLE_\w+)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    } catch { /* fallback to process.env */ }
  }

  return env;
}

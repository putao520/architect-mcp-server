import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

export function loadEnv() {
  const envScript = process.env.ARCHITECT_ENV_SCRIPT || `${process.env.HOME}/kocode.sh`;
  const env = { ...process.env };

  // 清理主 CC 特有配置，避免子 CC 继承后 API 报错
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_CODE_FORCE_EFFORT;

  // 从 sh 脚本提取 export 行覆盖 ANTHROPIC_* / CLAUDE_* / ENABLE_*
  // 不 source 整个脚本（末尾有 claude 命令会阻塞/hang）
  if (existsSync(envScript)) {
    try {
      const output = execFileSync('bash', ['-c',
        `grep -E '^export (ANTHROPIC_|CLAUDE_|ENABLE_)' '${envScript}' | sed 's/^export //'`
      ], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
      for (const line of output.trim().split('\n')) {
        const m = line.match(/^(\w+)="?([^"]*)"?$/);
        if (m) env[m[1]] = m[2];
      }
    } catch { /* fallback to process.env */ }
  }

  return env;
}

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

export function runAngrScript(scriptName, params, timeout = 120000) {
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  const jsonParams = JSON.stringify(params);

  try {
    const result = execSync(
      `python3 "${scriptPath}" '${jsonParams.replace(/'/g, "'\\''")}'`,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return JSON.parse(result);
  } catch (e) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';

    if (stdout.trim()) {
      try {
        return JSON.parse(stdout);
      } catch {}
    }

    return {
      error: true,
      message: e.message?.slice(0, 500),
      stderr: stderr.slice(0, 1000),
    };
  }
}

export function runAngrScriptRaw(scriptName, params, timeout = 120000) {
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  const jsonParams = JSON.stringify(params);

  try {
    const result = execSync(
      `python3 "${scriptPath}" '${jsonParams.replace(/'/g, "'\\''")}'`,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return result;
  } catch (e) {
    return e.stderr?.toString() || e.message || 'Unknown error';
  }
}

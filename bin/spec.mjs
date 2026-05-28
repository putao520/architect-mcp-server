#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

async function main() {
  switch (command) {
    case 'validate': {
      const { validateAll } = await import('../src/spec/validate/index.mjs');
      const { parseSpecDir } = await import('../src/spec/parse/html-parser.mjs');
      const dir = commandArgs[0] || '.';
      const index = parseSpecDir(dir);
      const result = validateAll(index);
      printResult('Validate', result);
      break;
    }
    case 'links': {
      const { validateLinks } = await import('../src/spec/validate/links.mjs');
      const { parseSpecDir } = await import('../src/spec/parse/html-parser.mjs');
      const dir = commandArgs[0] || '.';
      const index = parseSpecDir(dir);
      const result = validateLinks(index);
      printResult('Links', result);
      break;
    }
    case 'status': {
      const status = await import('../src/spec/status/index.mjs');
      const dir = commandArgs[0] || '.';
      await status.run([dir, ...(commandArgs.slice(1))]);
      break;
    }
    case 'graph': {
      const graph = await import('../src/spec/graph/index.mjs');
      const dir = commandArgs[0] || '.';
      await graph.run([dir, ...(commandArgs.slice(1))]);
      break;
    }
    case 'init': {
      const { initSpec } = await import('../src/spec/transform/init.mjs');
      const dir = commandArgs[0] || '.';
      initSpec(dir);
      console.log(`SPEC initialized in ${dir}`);
      break;
    }
    case 'index': {
      const { writeIndexHtml } = await import('../src/spec/transform/index-builder.mjs');
      const dir = commandArgs[0] || '.';
      writeIndexHtml(dir);
      console.log(`00-INDEX.html generated in ${dir}`);
      break;
    }
    case 'audit': {
      const { runAudit } = await import('../src/spec/audit/index.mjs');
      const { parseSpecDir: psd } = await import('../src/spec/parse/html-parser.mjs');
      const auditDir = commandArgs[0] || '.';
      const auditMode = commandArgs[1] || 'maturity';
      const auditOpts = {};
      for (let i = 2; i < commandArgs.length; i++) {
        if (commandArgs[i] === '--source-dir' && commandArgs[i + 1]) { auditOpts.sourceDir = commandArgs[++i]; }
        else if (commandArgs[i] === '--domain' && commandArgs[i + 1]) { auditOpts.domain = commandArgs[++i]; }
        else if (commandArgs[i] === '--json') { auditOpts.format = 'json'; }
      }
      const result = runAudit(auditDir, auditMode, auditOpts);
      if (auditOpts.format === 'json' || result.format === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.log(result.text);
      }
      break;
    }
    case 'migrate': {
      const subCommand = commandArgs[0];
      const migrateArgs = commandArgs.slice(1);

      if (subCommand === 'run') {
        const { migrateBatch } = await import('../src/spec/migrate/agent.mjs');
        const mdDir = migrateArgs[0] || '.';
        const outputDir = migrateArgs[1] || mdDir;
        const { buildSdkEnv } = await import('../src/env.mjs');
        const env = buildSdkEnv('glm');
        const results = await migrateBatch(mdDir, outputDir, env);
        const { writeIndexHtml } = await import('../src/spec/transform/index-builder.mjs');
        writeIndexHtml(outputDir);
        const ok = results.filter(r => r.success && !r.skipped).length;
        const skip = results.filter(r => r.skipped).length;
        const fail = results.filter(r => !r.success).length;
        console.log(`\nDone: ${ok} OK, ${skip} skipped, ${fail} FAIL`);
        console.log(JSON.stringify(results, null, 2));
      } else if (subCommand === 'single') {
        const { migrateSingleFile } = await import('../src/spec/migrate/agent.mjs');
        const { buildSdkEnv } = await import('../src/env.mjs');
        const mdPath = migrateArgs[0];
        const specDir = migrateArgs[1] || '.';
        const outputDir = migrateArgs[2] || specDir;
        if (!mdPath) { console.error('Usage: spec migrate single <md> <spec-dir> [output-dir]'); process.exit(1); }
        const env = buildSdkEnv('glm');
        const result = await migrateSingleFile(mdPath, specDir, outputDir, env);
        console.log(JSON.stringify(result, null, 2));
      } else if (subCommand === 'verify') {
        const { verifyMigration } = await import('../src/spec/migrate/verify.mjs');
        const mdDir = migrateArgs[0] || '.';
        const htmlDir = migrateArgs[1] || '.';
        const result = verifyMigration(mdDir, htmlDir);
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error('Usage: spec migrate <run|single|verify> [args]');
        process.exit(1);
      }
      break;
    }
    case 'openapi': {
      const openapi = await import('../src/spec/openapi/index.mjs');
      await openapi.run(commandArgs);
      break;
    }
    case 'schema': {
      const schema = await import('../src/spec/schema/index.mjs');
      await schema.run(commandArgs);
      break;
    }
    default:
      console.log('spec-tools — HTML SPEC 2.0 management CLI');
      console.log('');
      console.log('Commands:');
      console.log('  validate <dir>           Validate SPEC completeness/consistency/format');
      console.log('  links <dir>              Check cross-references');
      console.log('  status <dir>             List REQ status');
      console.log('  graph <dir>              Build dependency/impact graph');
      console.log('  init <dir>               Initialize SPEC directory structure');
      console.log('  index <dir>              Generate 00-INDEX.html');
      console.log('  migrate plan <md-dir>    Plan migration (dependency order + split strategy)');
      console.log('  migrate run <md-dir> [out]   Batch MD→HTML (deterministic, zero LLM)');
      console.log('  migrate single <md> <dir>    Migrate single file');
      console.log('  migrate verify <md-dir> <html-dir>  Verify migration equivalence');
      console.log('  audit <dir> <mode> [options]    SPEC maturity/coverage/quality/CFG/DFS/entropy audit');
      console.log('    modes: maturity req_coverage test_quality cfg_chain dfs_connectivity architecture_entropy');
      console.log('    options: --source-dir <dir> --domain <name> --json');
      console.log('  openapi export <dir> [--json] [--output=file.yaml]   Export SPEC APIs to OpenAPI');
      console.log('  openapi import <spec.yaml> <output-dir>              Import OpenAPI to SPEC HTML');
      console.log('  openapi validate <dir|file> [--strict]               Validate API definitions');
      console.log('  schema export <dir> [output.json]                    Export entities to JSON Schema');
      console.log('  schema validate <dir> <entity> <data.json>           Validate data against schema');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

function printResult(name, { errors = [], warnings = [] }) {
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`${name}: All checks passed`);
  } else {
    if (errors.length > 0) {
      console.log(`${name}: ${errors.length} error(s)`);
      for (const e of errors) console.log(`  ERROR [${e.file}] ${e.message}`);
    }
    if (warnings.length > 0) {
      console.log(`${name}: ${warnings.length} warning(s)`);
      for (const w of warnings) console.log(`  WARN  [${w.file}] ${w.message}`);
    }
  }
}

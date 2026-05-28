import { z } from 'zod';
import { parseOpenApiSpec, extractOperations } from './parser.mjs';
import { specApisToOpenApi, openApiToSpecHtml, specDirToOpenApi, toYaml, toJson } from './converter.mjs';
import { validateSpecApi, validateSpecDirApis, validatePathParamConsistency } from './validator.mjs';

export function registerOpenApiTools(server) {
  server.tool(
    'spec_openapi',
    'SPEC ↔ OpenAPI 3.0 双向转换+验证。export=SPEC→OpenAPI | import=OpenAPI→SPEC | validate=约束验证',
    {
      action: z.enum(['export', 'import', 'validate']).describe('export=导出 | import=导入 | validate=验证'),
      dir: z.string().optional().describe('[export/validate] SPEC 目录路径'),
      output: z.string().optional().describe('[export] 输出文件路径'),
      format: z.enum(['yaml', 'json']).default('yaml').describe('[export] 输出格式'),
      title: z.string().optional().describe('[export] API 标题'),
      specFile: z.string().optional().describe('[import] OpenAPI YAML/JSON 文件路径'),
      outputDir: z.string().optional().describe('[import] 输出目录'),
      target: z.string().optional().describe('[validate] SPEC 目录或 OpenAPI 文件路径'),
      strict: z.boolean().default(false).describe('[validate] 严格路径参数一致性检查'),
    },
    async (args) => {
      const { action } = args;

      if (action === 'export') {
        const { writeFileSync } = await import('node:fs');
        const spec = await specDirToOpenApi(args.dir || '.', { title: args.title });
        const content = args.format === 'json' ? toJson(spec) : toYaml(spec);
        writeFileSync(args.output || 'openapi.yaml', content, 'utf8');
        const apiCount = Object.values(spec.paths).reduce((s, p) => s + Object.keys(p).length, 0);
        return { content: [{ type: 'text', text: `Exported ${apiCount} API operations to ${args.output || 'openapi.yaml'}` }] };
      }

      if (action === 'import') {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { spec, errors } = await parseOpenApiSpec(args.specFile);
        if (errors.length > 0) {
          return { content: [{ type: 'text', text: `Parse errors:\n${errors.map(e => e.message).join('\n')}` }] };
        }
        const html = openApiToSpecHtml(spec);
        const outDir = args.outputDir || '.';
        mkdirSync(outDir, { recursive: true });
        const outputPath = join(outDir, 'apis.html');
        writeFileSync(outputPath, html, 'utf8');
        const ops = extractOperations(spec);
        return { content: [{ type: 'text', text: `Imported ${ops.length} operations to ${outputPath}` }] };
      }

      if (action === 'validate') {
        const target = args.target || args.dir || '.';
        const { extname } = await import('node:path');

        if (extname(target) === '.yaml' || extname(target) === '.json') {
          const { errors, warnings } = await parseOpenApiSpec(target);
          return {
            content: [{
              type: 'text',
              text: errors.length > 0
                ? `OpenAPI validation FAILED:\n${errors.map(e => e.message).join('\n')}`
                : 'OpenAPI validation PASSED',
            }],
          };
        }

        const { parseSpecDir } = await import('../parse/html-parser.mjs');
        const index = parseSpecDir(target);
        const results = validateSpecDirApis(index);

        if (args.strict) {
          for (const doc of index.docs) {
            for (const api of doc.apis) {
              const pathErrors = validatePathParamConsistency(api);
              for (const e of pathErrors) {
                results.push({ file: doc.fileName, api: `${api.method} ${api.path}`, valid: false, errors: [e] });
              }
            }
          }
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'All SPEC API definitions valid' }] };
        }

        const report = results.map(r =>
          `${r.file}: ${r.api}\n  ${r.errors.map(e => `${e.field}: ${e.message}`).join('\n  ')}`,
        ).join('\n\n');
        return { content: [{ type: 'text', text: `Found ${results.length} issues:\n\n${report}` }] };
      }
    },
  );
}

export async function run(args) {
  const subcommand = args[0] || 'export';
  const dir = args[1] || '.';

  if (subcommand === 'export') {
    const format = args.includes('--json') ? 'json' : 'yaml';
    const output = args.find(a => a.startsWith('--output='))?.slice(9) || 'openapi.yaml';
    const spec = await specDirToOpenApi(dir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(output, format === 'json' ? toJson(spec) : toYaml(spec), 'utf8');
    const count = Object.values(spec.paths).reduce((s, p) => s + Object.keys(p).length, 0);
    console.log(`Exported ${count} API operations to ${output}`);
  } else if (subcommand === 'import') {
    const specFile = args[1];
    const outputDir = args[2] || '.';
    const { spec, errors } = await parseOpenApiSpec(specFile);
    if (errors.length > 0) {
      console.error('Parse errors:', errors.map(e => e.message).join('\n'));
      process.exit(1);
    }
    const html = openApiToSpecHtml(spec);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'apis.html'), html, 'utf8');
    console.log(`Imported ${extractOperations(spec).length} operations`);
  } else if (subcommand === 'validate') {
    const { parseSpecDir } = await import('../parse/html-parser.mjs');
    const index = parseSpecDir(dir);
    const results = validateSpecDirApis(index);
    if (results.length === 0) {
      console.log('All SPEC API definitions valid');
    } else {
      for (const r of results) {
        console.log(`${r.file}: ${r.api}`);
        for (const e of r.errors) console.log(`  ${e.field}: ${e.message}`);
      }
      process.exit(1);
    }
  }
}

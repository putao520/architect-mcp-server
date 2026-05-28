import { z } from 'zod';
import { entityToJsonSchema, jsonSchemaToEntity, entitiesToJsonSchemas } from './entity-schema.mjs';
import { validateEntityData, validateAgainstSchema } from './validator.mjs';

function collectEntities(index, entityFilter) {
  const all = index.allEntities || index.docs.flatMap(d => d.entities);
  return entityFilter ? all.filter(e => e.name === entityFilter) : all;
}

function findEntity(index, entityName) {
  const all = index.allEntities || index.docs.flatMap(d => d.entities);
  return all.find(e => e.name === entityName) || null;
}

function doExport(index, entityFilter) {
  const entities = collectEntities(index, entityFilter);
  return entityFilter
    ? entityToJsonSchema(entities[0])
    : entitiesToJsonSchemas(entities);
}

function doValidate(index, entityName, data) {
  const entity = findEntity(index, entityName);
  if (!entity) return { found: false };
  return { found: true, result: validateEntityData(entity, data) };
}

export function registerSchemaTools(server) {
  server.tool(
    'spec_schema',
    'SPEC ↔ JSON Schema 双向转换+数据验证。export=Entity→JSON Schema | import=JSON Schema→Entity HTML | validate=数据实例验证',
    {
      action: z.enum(['export', 'import', 'validate']).describe('export=导出 | import=导入 | validate=验证'),
      dir: z.string().optional().describe('[export/validate] SPEC 目录路径'),
      output: z.string().optional().describe('[export] 输出文件路径'),
      entity: z.string().optional().describe('[export] 过滤实体名 | [validate] 目标实体名'),
      schemaFile: z.string().optional().describe('[import] JSON Schema 文件路径'),
      outputDir: z.string().optional().describe('[import] 输出目录'),
      dataFile: z.string().optional().describe('[validate] JSON 数据文件路径'),
    },
    async (args) => {
      const { action } = args;

      if (action === 'export') {
        const { writeFileSync } = await import('node:fs');
        const { parseSpecDir } = await import('../parse/html-parser.mjs');
        const index = parseSpecDir(args.dir || '.');
        const result = doExport(index, args.entity || undefined);
        const count = args.entity ? 1 : (index.allEntities || index.docs.flatMap(d => d.entities)).length;
        const outPath = args.output || 'schemas.json';
        writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
        return { content: [{ type: 'text', text: `Exported ${count} entities to ${outPath}` }] };
      }

      if (action === 'import') {
        const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { join, basename } = await import('node:path');
        const raw = readFileSync(args.schemaFile, 'utf8');
        const schema = JSON.parse(raw);

        const entityDefs = [];
        if (schema.$defs) {
          for (const [name, def] of Object.entries(schema.$defs)) {
            entityDefs.push(jsonSchemaToEntity(def, name));
          }
        } else {
          const name = basename(args.schemaFile, '.json');
          entityDefs.push(jsonSchemaToEntity(schema, name));
        }

        const outDir = args.outputDir || '.';
        mkdirSync(outDir, { recursive: true });
        for (const entity of entityDefs) {
          const html = entityToHtml(entity);
          writeFileSync(join(outDir, `data-${entity.name.toLowerCase()}.html`), html, 'utf8');
        }
        return { content: [{ type: 'text', text: `Imported ${entityDefs.length} entities` }] };
      }

      if (action === 'validate') {
        const { readFileSync } = await import('node:fs');
        const { parseSpecDir } = await import('../parse/html-parser.mjs');
        const index = parseSpecDir(args.dir || '.');
        const data = JSON.parse(readFileSync(args.dataFile, 'utf8'));
        const { found, result } = doValidate(index, args.entity, data);

        if (!found) {
          return { content: [{ type: 'text', text: `Entity "${args.entity}" not found in SPEC` }] };
        }
        if (result.valid) {
          return { content: [{ type: 'text', text: `Data valid against ${args.entity}` }] };
        }
        const report = result.errors.map(e => `${e.field}: ${e.message}`).join('\n');
        return { content: [{ type: 'text', text: `Validation FAILED:\n${report}` }] };
      }
    },
  );
}

function entityToHtml(entity) {
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="UTF-8">',
    `<title>Entity: ${entity.name}</title>`,
    '</head><body>',
    `<section data-entity="${entity.name}">`,
    `  <h2>${entity.title || entity.name}</h2>`,
    '  <table data-entity-table>',
    '    <tr><th>字段</th><th>类型</th><th>必填</th><th>约束</th></tr>',
  ];

  for (const f of entity.fields) {
    lines.push(
      `    <tr data-field="${f.name}" data-type="${f.type}" data-required="${f.required}"${f.constraints ? ` data-constraints="${f.constraints}"` : ''}>`,
      `      <td>${f.name}</td><td>${f.type}</td><td>${f.required ? '是' : '否'}</td><td>${f.constraints || ''}</td>`,
      '    </tr>',
    );
  }

  lines.push('  </table>');
  lines.push('</section>');
  lines.push('</body></html>');
  return lines.join('\n');
}

export async function run(args) {
  const subcommand = args[0] || 'export';
  const dir = args[1] || '.';

  if (subcommand === 'export') {
    const output = args[2] || 'schemas.json';
    const { writeFileSync } = await import('node:fs');
    const { parseSpecDir } = await import('../parse/html-parser.mjs');
    const index = parseSpecDir(dir);
    const result = doExport(index);
    const count = (index.allEntities || index.docs.flatMap(d => d.entities)).length;
    writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');
    console.log(`Exported ${count} entities to ${output}`);
  } else if (subcommand === 'validate') {
    const entityName = args[2];
    const dataFile = args[3];
    if (!entityName || !dataFile) {
      console.log('Usage: spec schema validate <dir> <entity-name> <data-file>');
      process.exit(1);
    }
    const { readFileSync } = await import('node:fs');
    const { parseSpecDir } = await import('../parse/html-parser.mjs');
    const index = parseSpecDir(dir);
    const data = JSON.parse(readFileSync(dataFile, 'utf8'));
    const { found, result } = doValidate(index, entityName, data);
    if (!found) {
      console.error(`Entity "${entityName}" not found`);
      process.exit(1);
    }
    if (result.valid) {
      console.log(`Data valid against ${entityName}`);
    } else {
      for (const e of result.errors) console.log(`  ${e.field}: ${e.message}`);
      process.exit(1);
    }
  }
}

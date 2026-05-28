import { pathToId } from '../utils/normalize.mjs';
import { parseSpecDir } from '../parse/html-parser.mjs';
import { specTypeToJsonSchema, jsonSchemaToSpecType } from '../schema/type-system.mjs';
import { entityToJsonSchema } from '../schema/entity-schema.mjs';
import { escapeHtml } from '../utils/html.mjs';
import YAML from 'js-yaml';

export function specApisToOpenApi(apis, options = {}) {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: options.title || 'SPEC API Documentation',
      version: options.version || '1.0.0',
      description: options.description || '',
    },
    paths: {},
  };

  if (options.servers) spec.servers = options.servers;

  const schemas = {};
  for (const entity of (options.entities || [])) {
    const entitySchema = entityToJsonSchema(entity);
    schemas[entity.name] = {
      type: 'object',
      properties: entitySchema.properties,
      required: entitySchema.required || undefined,
      additionalProperties: false,
    };
    if (schemas[entity.name].required === undefined) delete schemas[entity.name].required;
  }
  if (Object.keys(schemas).length > 0) {
    spec.components = { schemas };
  }

  for (const api of apis) {
    const path = normalizePath(api.path);
    if (!spec.paths[path]) spec.paths[path] = {};

    spec.paths[path][api.method.toLowerCase()] = {
      operationId: api.id || `${api.method.toLowerCase()}-${pathToId(api.path)}`,
      summary: api.title || '',
      parameters: mapSpecParamsToOpenApi(api.params, path),
      responses: mapSpecResponseToOpenApi(api.response, schemas),
    };

    if (api.tags?.length) {
      spec.paths[path][api.method.toLowerCase()].tags = api.tags;
    }
  }

  return spec;
}

export function openApiToSpecApis(spec) {
  const apis = [];
  if (!spec.paths) return apis;

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) continue;

      const api = {
        id: operation.operationId || `api-${method}-${pathToId(path)}`,
        method: method.toUpperCase(),
        path,
        title: operation.summary || '',
        params: mapOpenApiParamsToSpec(operation.parameters),
        response: mapOpenApiResponseToSpec(operation.responses),
      };

      apis.push(api);
    }
  }

  return apis;
}

export function openApiToSpecHtml(spec) {
  const apis = openApiToSpecApis(spec);
  const lines = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="zh-CN"><head><meta charset="UTF-8">');
  lines.push('<title>API Specification</title>');
  lines.push('</head><body>');
  lines.push('<section data-api-index>');

  for (const api of apis) {
    lines.push(`  <section id="${esc(api.id)}" data-api="${esc(api.method)} ${esc(api.path)}">`);
    lines.push(`    <h3>${esc(api.method)} ${esc(api.path)}</h3>`);
    if (api.title) lines.push(`    <p>${esc(api.title)}</p>`);

    if (api.params.length > 0) {
      lines.push('    <table data-api-params>');
      lines.push('      <tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr>');
      for (const p of api.params) {
        lines.push(`      <tr data-param="${esc(p.name)}" data-type="${esc(p.type || 'string')}" data-required="${p.required}">`);
        lines.push(`        <td>${esc(p.name)}</td><td>${esc(p.type || 'string')}</td>`);
        lines.push(`        <td>${p.required ? '是' : '否'}</td><td>${esc(p.description || '')}</td>`);
        lines.push('      </tr>');
      }
      lines.push('    </table>');
    }

    lines.push('  </section>');
  }

  lines.push('</section>');
  lines.push('</body></html>');
  return lines.join('\n');
}

export async function specDirToOpenApi(specDir, options = {}) {
  const index = options._index || parseSpecDir(specDir);
  const allApis = index.allApis || index.docs.flatMap(d => d.apis);
  const allEntities = index.allEntities || index.docs.flatMap(d => d.entities);
  return specApisToOpenApi(allApis, { ...options, entities: allEntities });
}

export function toYaml(spec) {
  return YAML.dump(spec, { lineWidth: -1, noRefs: true });
}

export function toJson(spec, indent = 2) {
  return JSON.stringify(spec, null, indent);
}

function normalizePath(path) {
  let result = path;
  if (!result.startsWith('/')) result = '/' + result;
  result = result.replace(/:([^/]+)/g, '{$1}');
  return result;
}

function mapSpecParamsToOpenApi(params, path) {
  if (!params || params.length === 0) return [];
  const pathVars = new Set([...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]));

  return params.map(p => {
    const param = {
      name: p.name,
      in: pathVars.has(p.name) ? 'path' : 'query',
      required: pathVars.has(p.name) || p.required === true,
      schema: inferSchema(p.type),
    };
    if (p.description) param.description = p.description;
    return param;
  });
}

function mapSpecResponseToOpenApi(response, schemas) {
  if (!response) return { '200': { description: 'Success' } };

  const responses = {};
  if (response.statusCode) {
    responses[String(response.statusCode)] = {
      description: response.description || 'Success',
    };
  } else {
    const schema = resolveResponseSchema(response, schemas);
    responses['200'] = {
      description: response.description || 'Success',
      content: { 'application/json': { schema } },
    };
  }
  return responses;
}

function resolveResponseSchema(response, schemas) {
  if (response.entityRef && schemas && schemas[response.entityRef]) {
    return { $ref: `#/components/schemas/${response.entityRef}` };
  }
  if (response['@type'] === 'ApiResponse' && response.entity && schemas && schemas[response.entity]) {
    return {
      type: 'object',
      properties: {
        data: { $ref: `#/components/schemas/${response.entity}` },
      },
    };
  }
  return response;
}

function mapOpenApiParamsToSpec(params) {
  if (!params || !Array.isArray(params)) return [];
  return params.map(p => ({
    name: p.name || '',
    type: schemaToSpecType(p.schema),
    required: p.required || false,
    description: p.description || '',
  }));
}

function mapOpenApiResponseToSpec(responses) {
  if (!responses) return null;
  const success = responses['200'] || responses['201'];
  if (!success) return null;
  return success.content?.['application/json']?.schema || { description: success.description };
}

function inferSchema(type) {
  return specTypeToJsonSchema(type);
}

function schemaToSpecType(schema) {
  return jsonSchemaToSpecType(schema);
}

const esc = escapeHtml;

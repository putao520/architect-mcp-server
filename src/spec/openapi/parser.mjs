import SwaggerParser from '@apidevtools/swagger-parser';
import { readFileSync } from 'node:fs';

export async function parseOpenApiSpec(filePath) {
  try {
    const spec = await SwaggerParser.validate(filePath);
    return { spec, errors: [], warnings: [] };
  } catch (err) {
    const spec = await safeParse(filePath);
    return { spec, errors: [{ message: err.message }], warnings: [] };
  }
}

export async function validateOpenApiSpec(apiObject) {
  try {
    const spec = await SwaggerParser.validate(apiObject);
    return { valid: true, spec, errors: [], warnings: [] };
  } catch (err) {
    return { valid: false, spec: null, errors: parseSwaggerErrors(err), warnings: [] };
  }
}

export function extractOperations(spec) {
  const operations = [];
  if (!spec.paths) return operations;

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'].includes(method)) {
        operations.push({
          method: method.toUpperCase(),
          path,
          operationId: operation.operationId || `${method}-${pathToOperationId(path)}`,
          summary: operation.summary || '',
          description: operation.description || '',
          parameters: mapOpenApiParams(operation.parameters),
          requestBody: mapRequestBody(operation.requestBody),
          responses: mapResponses(operation.responses),
          tags: operation.tags || [],
        });
      }
    }
  }
  return operations;
}

async function safeParse(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const { default: YAML } = await import('js-yaml');
    const parsed = YAML.load(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseSwaggerErrors(err) {
  if (err.details) {
    return err.details.map(d => ({
      message: d.message || d,
      path: d.path ? d.path.join('.') : '',
    }));
  }
  return [{ message: err.message, path: '' }];
}

function pathToOperationId(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function mapOpenApiParams(params) {
  if (!params || !Array.isArray(params)) return [];
  return params.map(p => ({
    name: p.name,
    in: p.in || 'query',
    required: p.required || false,
    description: p.description || '',
    schema: p.schema || { type: 'string' },
  }));
}

function mapRequestBody(body) {
  if (!body || !body.content) return null;
  const jsonContent = body.content['application/json'];
  if (!jsonContent) return null;
  return {
    required: body.required || false,
    description: body.description || '',
    schema: jsonContent.schema || null,
  };
}

function mapResponses(responses) {
  if (!responses) return {};
  const result = {};
  for (const [code, resp] of Object.entries(responses)) {
    const jsonContent = resp.content?.['application/json'];
    result[code] = {
      description: resp.description || '',
      schema: jsonContent?.schema || null,
    };
  }
  return result;
}

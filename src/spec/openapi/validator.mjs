import { z } from 'zod';

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']);
const ApiPath = z.string().regex(/^\//);
const StatusCode = z.string().regex(/^\d{3}$/);
const MimeType = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/);
const STANDARD_METHODS = new Set(HttpMethod.options);

const SpecApiSchema = z.object({
  id: z.string().min(1),
  method: HttpMethod,
  path: ApiPath,
  title: z.string().optional(),
  params: z.array(z.object({
    name: z.string().min(1),
    type: z.string().optional(),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })).optional(),
}).passthrough();

export function validateSpecApi(api) {
  const result = SpecApiSchema.safeParse(api);
  if (result.success) return { valid: true, errors: [] };

  const errors = result.error.issues.map(issue => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
  return { valid: false, errors };
}

export function validateSpecDirApis(index) {
  const results = [];
  for (const doc of index.docs) {
    for (const api of doc.apis) {
      if (!STANDARD_METHODS.has(api.method?.toUpperCase())) continue;
      const validation = validateSpecApi(api);
      if (!validation.valid) {
        results.push({
          file: doc.fileName,
          api: `${api.method} ${api.path}`,
          valid: false,
          errors: validation.errors,
        });
      }
    }
  }
  return results;
}

export function validatePathParamConsistency(api) {
  const errors = [];
  if (!api.path || !api.params) return errors;

  const pathParams = new Set();
  const paramNames = new Set();
  for (const match of api.path.matchAll(/\{(\w+)\}/g)) {
    pathParams.add(match[1]);
  }
  for (const p of api.params) {
    paramNames.add(p.name);
  }

  for (const pp of pathParams) {
    if (!paramNames.has(pp)) {
      errors.push({ field: 'params', message: `Path parameter {${pp}} not declared in params` });
    }
  }
  for (const name of paramNames) {
    const param = api.params.find(p => p.name === name);
    if (pathParams.has(name) && param && param.in !== 'path' && !param.type?.includes('path')) {
      errors.push({ field: `params.${name}`, message: `Parameter exists in path {${name}} but not marked as path param` });
    }
  }

  return errors;
}

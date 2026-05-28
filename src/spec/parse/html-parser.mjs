import { readFileSync, existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parseHTML } from 'linkedom';
import { globSync } from 'glob';
import * as E from './extractors.mjs';

export function parseSpecFile(filePath, specDir) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  const { document } = parseHTML(raw);

  return {
    filePath,
    raw,
    fileName: basename(filePath, '.html'),
    meta: E.extractMeta(document),
    jsonld: E.extractJsonLd(document),
    reqs: E.extractReqs(document),
    entities: E.extractEntities(document),
    apis: E.extractApis(document),
    tests: E.extractTests(document),
    stateMachines: E.extractStateMachines(document),
    sections: E.extractSections(document),
    xrefs: E.extractXrefs(document),
    dependencies: E.extractDependencies(document),
    artifacts: E.extractArtifacts(document),
    subfileInfo: E.extractSubfileInfo(document, filePath, specDir),
    apiGroups: E.extractApiGroups(document),
    entityDomains: E.extractEntityDomains(document),
    algorithms: E.extractAlgorithms(document),
    pipelines: E.extractPipelines(document),
    integrations: E.extractIntegrations(document),
    timings: E.extractTimings(document),
    nfrs: E.extractNfrs(document),
  };
}

export function parseSpecDir(dirPath) {
  const files = globSync('**/*.html', { cwd: dirPath, ignore: ['node_modules/**'] });
  const docs = files.map(f => parseSpecFile(join(dirPath, f), dirPath)).filter(Boolean);
  return E.buildIndex(docs, dirPath);
}

export { E as extractors };

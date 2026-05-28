import { stripHtmlExt, normalizeLinkHref } from '../utils/normalize.mjs';

export function buildDependencyGraph(index) {
  const nodes = [];
  const edges = [];

  for (const doc of index.docs) {
    nodes.push({ id: doc.fileName, label: doc.fileName, file: doc.fileName });
  }

  for (const doc of index.docs) {
    for (const dep of doc.dependencies) {
      const target = stripHtmlExt(dep.href);
      edges.push({ source: doc.fileName, target });
    }
  }

  return { nodes, edges };
}

export function toMermaid(graph) {
  const lines = ['graph LR'];
  for (const node of graph.nodes) {
    lines.push(`  ${node.id}[${node.label}]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${edge.source} --> ${edge.target}`);
  }
  return lines.join('\n');
}

export function detectCycles(graph) {
  const adj = new Map();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    if (adj.has(e.source)) adj.get(e.source).push(e.target);
  }

  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, path) {
    visited.add(node);
    stack.add(node);
    for (const next of adj.get(node) || []) {
      if (!visited.has(next)) {
        dfs(next, [...path, next]);
      } else if (stack.has(next)) {
        const cycleStart = path.indexOf(next);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart));
        }
      }
    }
    stack.delete(node);
  }

  for (const n of graph.nodes) {
    if (!visited.has(n.id)) dfs(n.id, [n.id]);
  }

  return cycles;
}

export function buildImpactGraph(index) {
  const forward = new Map();
  const reverse = new Map();

  for (const doc of index.docs) {
    forward.set(doc.fileName, []);
  }

  for (const doc of index.docs) {
    for (const xref of doc.xrefs) {
      const targetFile = resolveFile(xref.href, doc.fileName);
      if (!targetFile) continue;

      if (!forward.has(targetFile)) forward.set(targetFile, []);
      forward.get(targetFile).push({ from: doc.fileName, id: xref.sourceId, type: xref.type });

      if (!reverse.has(doc.fileName)) reverse.set(doc.fileName, []);
      reverse.get(doc.fileName).push({ to: targetFile, id: xref.href.split('#')[1] || '', type: xref.type });
    }
  }

  return { forward, reverse };
}

export function impactChain(impactGraph, elementId, direction = 'reverse') {
  const graph = direction === 'reverse' ? impactGraph.reverse : impactGraph.forward;
  const visited = new Set();
  const chain = [];

  function walk(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const deps = graph.get(id) || [];
    for (const dep of deps) {
      const target = dep.to || dep.from;
      chain.push({ element: target, type: dep.type, id: dep.id });
      walk(target);
    }
  }

  walk(elementId);
  return chain;
}

function resolveFile(href, sourceFile) {
  if (!href) return null;
  let file = href.split('#')[0];
  if (!file) return sourceFile;
  file = normalizeLinkHref(file);
  if (!file) return sourceFile;
  return file;
}

export async function run(args) {
  const dir = args[0] || '.';
  const subcommand = args[1] || 'dep';
  const target = args[2];

  const { parseSpecDir } = await import('../parse/html-parser.mjs');
  const index = parseSpecDir(dir);

  if (subcommand === 'dep') {
    const graph = buildDependencyGraph(index);
    const cycles = detectCycles(graph);
    console.log(toMermaid(graph));
    if (cycles.length > 0) {
      console.log(`\nCYCLES DETECTED: ${cycles.length}`);
      for (const c of cycles) console.log(`  ${c.join(' → ')}`);
    }
  } else if (subcommand === 'impact') {
    const ig = buildImpactGraph(index);
    if (target) {
      const chain = impactChain(ig, target);
      console.log(`Impact chain for ${target}:`);
      for (const c of chain) console.log(`  ${c.element} (${c.type}: ${c.id})`);
    } else {
      console.log('Usage: spec graph impact <element-id>');
    }
  }
}

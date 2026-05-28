import { normalizeReqRef } from '../utils/schemas.mjs';

/**
 * DFS Connectivity Audit — graph analysis of SPEC cross-references.
 *
 * Builds a directed graph from all SPEC elements and xrefs, then runs:
 *   1. Connected components (undirected BFS/DFS)
 *   2. Orphan nodes (0 in-degree, 0 out-degree)
 *   3. Dangling refs (xrefs to non-existent targets)
 *   4. Cycles (Tarjan-style directed cycle detection)
 *
 * Pure computation, no external dependencies.
 */

/**
 * @param {object} index - parseSpecDir output
 * @returns {{ nodes: number, edges: number, components: object[], orphans: string[], danglingRefs: object[], cycles: string[][] }}
 */
export function auditDfsConnectivity(index) {
  const { docs } = index;

  // --- build node set ----------------------------------------------------------
  const nodeSet = new Set();
  const originalNodes = new Set();

  for (const doc of docs) {
    if (doc.reqs) {
      for (const r of doc.reqs) {
        nodeSet.add(r.id);
        originalNodes.add(r.id);
      }
    }
    if (doc.entities) {
      for (const e of doc.entities) {
        nodeSet.add(e.name);
        originalNodes.add(e.name);
      }
    }
    if (doc.apis) {
      for (const a of doc.apis) {
        const key = `${a.method} ${a.path}`;
        nodeSet.add(key);
        originalNodes.add(key);
      }
    }
    if (doc.tests) {
      for (const t of doc.tests) {
        nodeSet.add(t.testId);
        originalNodes.add(t.testId);
      }
    }
    if (doc.stateMachines) {
      for (const sm of doc.stateMachines) {
        nodeSet.add(sm.name);
        originalNodes.add(sm.name);
      }
    }
  }

  // --- build directed edge list ------------------------------------------------
  // adjacency: source → Set<target>
  const adj = new Map();
  // reverse adjacency: target → Set<source>
  const radj = new Map();
  // all edges as [from, to, type]
  const allEdges = [];

  function addEdge(from, to, type) {
    if (!from || !to) return;
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from).add(to);
    if (!radj.has(to)) radj.set(to, new Set());
    radj.get(to).add(from);
    allEdges.push({ from, to, type });
    // ensure both endpoints are in the node set
    nodeSet.add(from);
    nodeSet.add(to);
  }

  for (const doc of docs) {
    // xref edges
    if (doc.xrefs) {
      for (const xr of doc.xrefs) {
        if (xr.sourceId && xr.xrefId) {
          addEdge(xr.sourceId, xr.xrefId, xr.type || 'xref');
        } else if (xr.sourceId && xr.href) {
          addEdge(xr.sourceId, xr.href, xr.type || 'xref');
        }
      }
    }

    // test → REQ edges via reqRef
    if (doc.tests) {
      for (const t of doc.tests) {
        const refs = normalizeReqRef(t.reqRef);
        for (const ref of refs) {
          addEdge(t.testId, ref, 'reqRef');
        }
      }
    }

    // dependency links from state machine transitions
    if (doc.stateMachines) {
      for (const sm of doc.stateMachines) {
        if (sm.definition && sm.definition.transitions) {
          for (const tr of sm.definition.transitions) {
            if (tr.from && tr.to) {
              const fromNode = `${sm.name}:${tr.from}`;
              const toNode = `${sm.name}:${tr.to}`;
              nodeSet.add(fromNode);
              nodeSet.add(toNode);
              addEdge(fromNode, toNode, 'transition');
            }
          }
        }
      }
    }
  }

  // --- dangling refs -----------------------------------------------------------
  const danglingRefs = [];

  for (const edge of allEdges) {
    if (!originalNodes.has(edge.to)) {
      danglingRefs.push({ from: edge.from, to: edge.to, type: edge.type });
    }
  }

  // --- orphan nodes ------------------------------------------------------------
  const orphans = [];
  for (const node of nodeSet) {
    const outDeg = adj.has(node) ? adj.get(node).size : 0;
    const inDeg = radj.has(node) ? radj.get(node).size : 0;
    if (outDeg === 0 && inDeg === 0) {
      orphans.push(node);
    }
  }
  orphans.sort();

  // --- connected components (undirected) ---------------------------------------
  const visited = new Set();
  const components = [];
  let compId = 0;

  for (const node of nodeSet) {
    if (visited.has(node)) continue;
    // BFS
    const queue = [node];
    visited.add(node);
    const compNodes = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      compNodes.push(cur);
      // neighbors via outgoing edges
      if (adj.has(cur)) {
        for (const nb of adj.get(cur)) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      // neighbors via incoming edges (undirected)
      if (radj.has(cur)) {
        for (const nb of radj.get(cur)) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
    }
    compNodes.sort();
    components.push({ id: compId++, size: compNodes.length, nodes: compNodes });
  }

  // sort components by size descending
  components.sort((a, b) => b.size - a.size);

  // --- cycle detection (DFS on directed graph) ---------------------------------
  // Johnson's algorithm simplified — find all elementary cycles
  const cycles = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const node of nodeSet) {
    color.set(node, WHITE);
  }

  const path = [];
  const pathSet = new Set();

  function dfsCycles(node) {
    color.set(node, GRAY);
    path.push(node);
    pathSet.add(node);

    const neighbors = adj.has(node) ? [...adj.get(node)] : [];
    for (const nb of neighbors) {
      if (!nodeSet.has(nb)) continue; // skip non-existent targets
      if (color.get(nb) === GRAY && pathSet.has(nb)) {
        // found a cycle — extract from nb to current
        const startIdx = path.indexOf(nb);
        if (startIdx !== -1) {
          const cycle = path.slice(startIdx);
          // only record unique cycles (normalize: smallest rotation first)
          const normalized = normalizeCycle(cycle);
          if (!cycleExists(normalized, cycles)) {
            cycles.push(normalized);
          }
        }
      } else if (color.get(nb) === WHITE) {
        dfsCycles(nb);
      }
    }

    path.pop();
    pathSet.delete(node);
    color.set(node, BLACK);
  }

  // Run DFS from each unvisited node to find all cycles
  for (const node of [...nodeSet].sort()) {
    // Reset colors for fresh traversal from each start node
    for (const n of nodeSet) {
      color.set(n, WHITE);
    }
    path.length = 0;
    pathSet.clear();
    dfsCycles(node);
  }

  return {
    nodes: nodeSet.size,
    edges: allEdges.length,
    components,
    orphans,
    danglingRefs,
    cycles,
  };
}

// --- cycle helpers -------------------------------------------------------------

function normalizeCycle(cycle) {
  // Rotate so the lexicographically smallest element is first
  if (cycle.length === 0) return cycle;
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

function cycleExists(normalized, existing) {
  const key = normalized.join('|');
  for (const ex of existing) {
    if (ex.join('|') === key) return true;
  }
  return false;
}

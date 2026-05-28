import { z } from 'zod';

export const ReqIdSchema = z.string().regex(/^REQ-[A-Z]+(-[A-Z]+)*-\d+$/);

export const TestIdSchema = z.string().regex(/^TEST-[A-Z]+(-[A-Z]+)*-\d+$/);

export const HtmlIdSchema = z.string().regex(/^[a-zA-Z一-鿿][a-zA-Z0-9一-鿿._-]*$/);

export function validateReqId(id) {
  const result = ReqIdSchema.safeParse(id);
  if (!result.success) return { valid: false, domain: null, number: null };
  const domainMatch = id.match(/^REQ-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  return {
    valid: true,
    domain: domainMatch ? domainMatch[1] : null,
    number: domainMatch ? parseInt(domainMatch[2], 10) : null,
  };
}

export function extractReqId(text) {
  if (!text) return null;
  if (text.startsWith('REQ-')) {
    const end = text.search(/[^A-Z0-9-]/);
    const candidate = end < 0 ? text : text.slice(0, end);
    return ReqIdSchema.safeParse(candidate).success ? candidate : null;
  }
  const start = text.indexOf('REQ-');
  if (start < 0) return null;
  const slice = text.slice(start);
  const end = slice.search(/[^A-Z0-9-]/);
  const candidate = end < 0 ? slice : slice.slice(0, end);
  return ReqIdSchema.safeParse(candidate).success ? candidate : null;
}

export function inferDomain(reqId) {
  if (!reqId) return '';
  const m = reqId.match(/^REQ-([A-Z]+(?:-[A-Z]+)?)-/);
  return m ? m[1].toLowerCase() : '';
}

export function extractReqIdsFromText(text) {
  const results = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf('REQ-', searchFrom);
    if (idx < 0) break;
    const slice = text.slice(idx);
    const end = slice.search(/[^A-Z0-9-]/);
    const candidate = end < 0 ? slice : slice.slice(0, end);
    if (ReqIdSchema.safeParse(candidate).success) {
      results.push(candidate);
    }
    searchFrom = idx + Math.max(candidate.length, 1);
  }
  return results;
}

export function parseReqId(id) {
  if (!id) return null;
  const m = id.match(/^REQ-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function parseTestId(id) {
  if (!id) return null;
  const m = id.match(/^TEST-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function normalizeReqRef(reqRef) {
  if (!reqRef) return [];
  return Array.isArray(reqRef) ? reqRef : [reqRef];
}

export const AlgorithmIdSchema = z.string().regex(/^ALG-[A-Z]+(-[A-Z]+)*-\d+$/);
export const PipelineIdSchema = z.string().regex(/^PIPE-[A-Z]+(-[A-Z]+)*-\d+$/);
export const IntegrationIdSchema = z.string().regex(/^INT-[A-Z]+(-[A-Z]+)*-\d+$/);
export const TimingIdSchema = z.string().regex(/^TMG-[A-Z]+(-[A-Z]+)*-\d+$/);
export const NfrIdSchema = z.string().regex(/^NFR-[A-Z]+(-[A-Z]+)*-\d+$/);

export function parseAlgorithmId(id) {
  if (!id) return null;
  const m = id.match(/^ALG-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function parsePipelineId(id) {
  if (!id) return null;
  const m = id.match(/^PIPE-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function parseIntegrationId(id) {
  if (!id) return null;
  const m = id.match(/^INT-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function parseTimingId(id) {
  if (!id) return null;
  const m = id.match(/^TMG-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

export function parseNfrId(id) {
  if (!id) return null;
  const m = id.match(/^NFR-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) return null;
  return { id, domain: m[1], number: parseInt(m[2], 10) };
}

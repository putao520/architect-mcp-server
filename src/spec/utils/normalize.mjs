export function stripHtmlExt(ref) {
  if (!ref) return ref;
  if (!ref.includes('/')) return ref.endsWith('.html') ? ref.slice(0, -5) : ref;
  const lastSlash = ref.lastIndexOf('/');
  const dir = ref.slice(0, lastSlash + 1);
  const file = ref.slice(lastSlash + 1);
  return dir + (file.endsWith('.html') ? file.slice(0, -5) : file);
}

export function normalizeSpecRef(ref) {
  let result = ref;
  while (result.startsWith('../')) result = result.slice(3);
  while (result.startsWith('./')) result = result.slice(2);
  return stripHtmlExt(result);
}

export function resolveFileName(ref, fileMap) {
  const normalized = stripHtmlExt(ref.replace(/^\.\//, ''));
  if (fileMap.has(normalized)) return normalized;
  const baseName = normalized.includes('/') ? normalized.split('/').pop() : normalized;
  if (fileMap.has(baseName)) return baseName;
  return normalized;
}

export function normalizeLinkHref(href) {
  return normalizeSpecRef(href);
}

export function slugify(text, maxLength = 40) {
  const result = text.toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '');
  return maxLength > 0 && result.length > maxLength ? result.slice(0, maxLength) : result;
}

export function slugifySection(text, sectionNum) {
  const cleaned = text.replace(/^§?\d+(\.\d+)?\s*/, '').trim();
  const slug = slugify(cleaned);
  return slug || `section-${sectionNum}`;
}

export function pathToId(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function extractSectionNumber(text) {
  const m = text.match(/§?(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

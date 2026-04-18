// src/parse.ts — 纯 JSON 解析函数，无外部依赖，方便测试
// Robust JSON parser (4-layer strategy)

export function parseJSONResponse(content: string): any | null {
  // Layer 1: ```json ... ``` code block (greedy)
  const codeBlock = content.match(/```(?:json)?\s*\n([\s\S]*)```/);
  if (codeBlock) {
    const parsed = tryParseJSON(codeBlock[1].trim());
    if (parsed) return parsed;
  }

  // Layer 2+3: Balanced brackets — order depends on which appears first at depth 0
  const firstBrace = content.indexOf('{');
  const firstBracket = content.indexOf('[');

  // Try the bracket that appears first in the content
  const tryBracesFirst = firstBrace >= 0 && (firstBracket < 0 || firstBrace <= firstBracket);
  const tryBracketsFirst = firstBracket >= 0 && (firstBrace < 0 || firstBracket <= firstBrace);

  if (tryBracesFirst) {
    const braces = extractBalanced(content, '{', '}');
    if (braces) {
      const parsed = tryParseJSON(braces);
      if (parsed) return parsed;
    }
  }

  if (tryBracketsFirst) {
    const brackets = extractBalanced(content, '[', ']');
    if (brackets) {
      const parsed = tryParseJSON(brackets);
      if (parsed) return parsed;
    }
  }

  // Fallback: try the other bracket type
  if (!tryBracesFirst) {
    const braces = extractBalanced(content, '{', '}');
    if (braces) {
      const parsed = tryParseJSON(braces);
      if (parsed) return parsed;
    }
  }

  if (!tryBracketsFirst) {
    const brackets = extractBalanced(content, '[', ']');
    if (brackets) {
      const parsed = tryParseJSON(brackets);
      if (parsed) return parsed;
    }
  }

  // Layer 4: Try whole content
  return tryParseJSON(content.trim());
}

export function tryParseJSON(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {}
  // Try with trailing comma removal
  try {
    return JSON.parse(removeTrailingCommas(text));
  } catch {}
  return null;
}

export function removeTrailingCommas(text: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { result += ch; escape = false; continue; }
    if (ch === '\\' && inString) { result += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (!inString && ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) continue;
    }
    result += ch;
  }
  return result;
}

/** 提取第一个配对的括号内容，正确处理字符串内的括号 */
export function extractBalanced(text: string, open: string, close: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue; // 字符串内不计数
    if (ch === open) { if (depth === 0) start = i; depth++; }
    else if (ch === close) {
      depth--;
      if (depth === 0 && start >= 0) return text.substring(start, i + 1);
    }
  }
  return null;
}

// ── 从 patch 中提取变更行范围 ──────────────────────────

export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export function parseHunkRanges(patch: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let match;
  while ((match = hunkRegex.exec(patch)) !== null) {
    ranges.push({
      oldStart: 0, oldLines: 0,
      newStart: parseInt(match[1], 10),
      newLines: match[2] ? parseInt(match[2], 10) : 1,
    });
  }
  return ranges;
}

/** 检查行号是否在 patch 的变更范围内 */
export function isLineInPatch(line: number, patch: string): boolean {
  const ranges = parseHunkRanges(patch);
  for (const r of ranges) {
    if (line >= r.newStart && line < r.newStart + r.newLines) return true;
  }
  return false;
}

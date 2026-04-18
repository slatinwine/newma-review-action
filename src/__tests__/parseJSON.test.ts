// src/__tests__/parseJSON.test.ts
import { parseJSONResponse, tryParseJSON, removeTrailingCommas, extractBalanced, isLineInPatch, parseHunkRanges } from '../parse.js';

describe('removeTrailingCommas', () => {
  it('移除对象末尾逗号', () => {
    expect(removeTrailingCommas('{"a":1,}')).toBe('{"a":1}');
  });

  it('移除数组末尾逗号', () => {
    expect(removeTrailingCommas('[1,2,3,]')).toBe('[1,2,3]');
  });

  it('不移除字符串内的逗号', () => {
    expect(removeTrailingCommas('{"a":"hello,world",}')).toBe('{"a":"hello,world"}');
  });

  it('处理转义引号', () => {
    expect(removeTrailingCommas('{"a":"say \\"hi\\"",}')).toBe('{"a":"say \\"hi\\""}');
  });

  it('多层嵌套', () => {
    const input = '{"a":[1,2,], "b":{"c":3,},}';
    const output = removeTrailingCommas(input);
    expect(JSON.parse(output)).toEqual({ a: [1, 2], b: { c: 3 } });
  });
});

describe('extractBalanced', () => {
  it('提取简单花括号', () => {
    expect(extractBalanced('abc { "key": 1 } def', '{', '}')).toBe('{ "key": 1 }');
  });

  it('提取嵌套花括号', () => {
    const input = 'before { "a": { "b": 2 } } after';
    expect(extractBalanced(input, '{', '}')).toBe('{ "a": { "b": 2 } }');
  });

  it('忽略字符串内的括号', () => {
    const input = '{"text": "use {brackets}", "code": "if (x) {}"}';
    expect(extractBalanced(input, '{', '}')).toBe(input);
  });

  it('字符串内含花括号不干扰匹配', () => {
    const input = 'prefix {"msg": "a {b} c"} suffix';
    expect(extractBalanced(input, '{', '}')).toBe('{"msg": "a {b} c"}');
  });

  it('字符串内含方括号', () => {
    const input = 'prefix {"arr": "[1,2]"} suffix';
    expect(extractBalanced(input, '[', ']')).toBe(null); // 不是 [] 开头
    expect(extractBalanced(input, '{', '}')).toBe('{"arr": "[1,2]"}');
  });

  it('没有配对时返回 null', () => {
    expect(extractBalanced('no brackets here', '{', '}')).toBeNull();
  });

  it('不配对时返回 null', () => {
    expect(extractBalanced('{unclosed', '{', '}')).toBeNull();
  });

  it('转义引号不影响', () => {
    const input = '{"text": "say \\"hello\\" and {go}"}';
    expect(extractBalanced(input, '{', '}')).toBe(input);
  });
});

describe('tryParseJSON', () => {
  it('正常 JSON', () => {
    expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('trailing comma 修复后可解析', () => {
    expect(tryParseJSON('{"a":1,}')).toEqual({ a: 1 });
  });

  it('无效 JSON 返回 null', () => {
    expect(tryParseJSON('not json')).toBeNull();
  });
});

describe('parseJSONResponse', () => {
  it('正常 JSON', () => {
    const result = parseJSONResponse('{"reviews": []}');
    expect(result).toEqual({ reviews: [] });
  });

  it('```json code block', () => {
    const input = '```json\n{"reviews": [{"line": 10, "severity": "warning"}]}\n```';
    const result = parseJSONResponse(input);
    expect(result.reviews).toHaveLength(1);
  });

  it('带文字包裹的 JSON — balanced {}', () => {
    const input = 'Here is the review:\n{"reviews": []}\nDone.';
    const result = parseJSONResponse(input);
    expect(result).toEqual({ reviews: [] });
  });

  it('直接返回数组 — balanced []', () => {
    const input = 'The result:\n[{"line": 5}]\nEnd';
    const result = parseJSONResponse(input);
    // 最外层是 [，优先匹配 []，返回完整数组
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].line).toBe(5);
  });

  it('空响应返回 null', () => {
    expect(parseJSONResponse('')).toBeNull();
  });

  it('HTML 错误页返回 null', () => {
    expect(parseJSONResponse('<html><body>502 Bad Gateway</body></html>')).toBeNull();
  });

  it('截断 JSON 尝试修复', () => {
    const input = '{"reviews": [{"line": 10, "severity": "error", "body": "missing check"}';
    // 截断的 JSON 无法修复 — 返回 null
    expect(parseJSONResponse(input)).toBeNull();
  });

  it('trailing commas 自动修复', () => {
    const input = '{"reviews": [{"line": 10, "severity": "error",},],}';
    const result = parseJSONResponse(input);
    expect(result.reviews).toHaveLength(1);
  });

  it('字符串内含括号的边界情况', () => {
    const input = '{"reviews": [{"body": "use {brackets} carefully", "line": 42}]}';
    const result = parseJSONResponse(input);
    expect(result.reviews[0].body).toBe('use {brackets} carefully');
  });
});

describe('isLineInPatch', () => {
  it('识别 hunk 内的行', () => {
    const patch = '@@ -1,3 +1,4 @@\n line1\n+added\n line3';
    expect(isLineInPatch(1, patch)).toBe(true);
    expect(isLineInPatch(4, patch)).toBe(true);
    expect(isLineInPatch(5, patch)).toBe(false);
  });

  it('多 hunk', () => {
    const patch = '@@ -1,2 +1,2 @@\n a\n b\n@@ -10,2 +10,3 @@\n c\n d\n e';
    expect(isLineInPatch(1, patch)).toBe(true);
    expect(isLineInPatch(11, patch)).toBe(true);
    expect(isLineInPatch(5, patch)).toBe(false);
  });
});

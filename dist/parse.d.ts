export declare function parseJSONResponse(content: string): any | null;
export declare function tryParseJSON(text: string): any | null;
export declare function removeTrailingCommas(text: string): string;
/** 提取第一个配对的括号内容，正确处理字符串内的括号 */
export declare function extractBalanced(text: string, open: string, close: string): string | null;
export interface HunkRange {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}
export declare function parseHunkRanges(patch: string): HunkRange[];
/** 检查行号是否在 patch 的变更范围内 */
export declare function isLineInPatch(line: number, patch: string): boolean;

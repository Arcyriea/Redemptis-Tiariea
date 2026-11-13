export interface SourcePosition {
    /** Zero-based offset measured in JavaScript UTF-16 code units. */
    offset: number;
    /** One-based line number. */
    line: number;
    /** One-based column measured in UTF-16 code units. */
    column: number;
}

export interface SourceSpan {
    /** Half-open source range [start, end). */
    start: SourcePosition;
    end: SourcePosition;
}

export interface LuaStringNode {
    kind: 'string';
    value: string;
    span: SourceSpan;
}

export interface LuaNumberNode {
    kind: 'number';
    value: number;
    span: SourceSpan;
}

export interface LuaBooleanNode {
    kind: 'boolean';
    value: boolean;
    span: SourceSpan;
}

export interface LuaTableNode {
    kind: 'table';
    entries: LuaTableEntry[];
    span: SourceSpan;
}

export type LuaDataNode = LuaStringNode | LuaNumberNode | LuaBooleanNode | LuaTableNode;

export interface LuaArrayEntry {
    kind: 'array';
    value: LuaDataNode;
    span: SourceSpan;
}

export interface LuaFieldEntry {
    kind: 'field';
    key: string;
    keySpan: SourceSpan;
    value: LuaDataNode;
    span: SourceSpan;
}

export type LuaTableEntry = LuaArrayEntry | LuaFieldEntry;

export type LuaParseDiagnosticCode =
    | 'invalid-input'
    | 'source-size-limit'
    | 'token-limit'
    | 'nesting-limit'
    | 'ast-node-limit'
    | 'syntax-error'
    | 'unsupported-syntax'
    | 'unsupported-long-bracket-comment'
    | 'unsupported-long-bracket-string'
    | 'invalid-string'
    | 'invalid-number'
    | 'duplicate-key';

export interface LuaParseDiagnostic {
    code: LuaParseDiagnosticCode;
    message: string;
    sourceName: string;
    span: SourceSpan;
}

export type LuaParseResult =
    | { ok: true; ast: LuaTableNode; sourceName: string }
    | { ok: false; diagnostics: [LuaParseDiagnostic] };

export interface ParseLuaDataOptions {
    sourceName?: string;
}

export function parseLuaData(source: string, options?: ParseLuaDataOptions): LuaParseResult;

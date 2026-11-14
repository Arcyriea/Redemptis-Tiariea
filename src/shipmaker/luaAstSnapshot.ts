import type {
    LuaDataNode,
    LuaTableEntry,
    SourceSpan
} from './luaDataParser.mjs';

export class LuaAstSnapshotError extends Error {
    constructor(readonly span: SourceSpan) {
        super('Lua AST contains a cycle and cannot be snapshotted.');
        this.name = 'LuaAstSnapshotError';
    }
}

function cloneSpan(span: SourceSpan): SourceSpan {
    return {
        start: { ...span.start },
        end: { ...span.end }
    };
}

function cloneEntry(entry: LuaTableEntry, active: WeakSet<object>): LuaTableEntry {
    if (entry.kind === 'array') {
        return {
            kind: 'array',
            value: cloneNode(entry.value, active),
            span: cloneSpan(entry.span)
        };
    }
    return {
        kind: 'field',
        key: entry.key,
        keySpan: cloneSpan(entry.keySpan),
        value: cloneNode(entry.value, active),
        span: cloneSpan(entry.span)
    };
}

/** Clone a parser AST, including every entry and source span. */
function cloneNode<T extends LuaDataNode>(node: T, active: WeakSet<object>): T {
    if (active.has(node)) throw new LuaAstSnapshotError(node.span);
    active.add(node);
    switch (node.kind) {
        case 'string':
            active.delete(node);
            return { kind: 'string', value: node.value, span: cloneSpan(node.span) } as T;
        case 'number':
            active.delete(node);
            return { kind: 'number', value: node.value, span: cloneSpan(node.span) } as T;
        case 'boolean':
            active.delete(node);
            return { kind: 'boolean', value: node.value, span: cloneSpan(node.span) } as T;
        case 'table':
            try {
                return {
                    kind: 'table',
                    entries: node.entries.map((entry) => cloneEntry(entry, active)),
                    span: cloneSpan(node.span)
                } as T;
            } finally {
                active.delete(node);
            }
    }
}

export function cloneLuaDataAst<T extends LuaDataNode>(node: T): T {
    return cloneNode(node, new WeakSet());
}

/** Deep-freeze a cloned AST after it has been revalidated. */
export function deepFreezeLuaDataAst<T extends LuaDataNode>(node: T): Readonly<T> {
    if (node.kind === 'table') {
        for (const entry of node.entries) {
            if (entry.kind === 'array') {
                deepFreezeLuaDataAst(entry.value);
                Object.freeze(entry.span.start);
                Object.freeze(entry.span.end);
                Object.freeze(entry.span);
            } else {
                deepFreezeLuaDataAst(entry.value);
                Object.freeze(entry.keySpan.start);
                Object.freeze(entry.keySpan.end);
                Object.freeze(entry.keySpan);
                Object.freeze(entry.span.start);
                Object.freeze(entry.span.end);
                Object.freeze(entry.span);
            }
            Object.freeze(entry);
        }
        Object.freeze(node.entries);
    }
    Object.freeze(node.span.start);
    Object.freeze(node.span.end);
    Object.freeze(node.span);
    return Object.freeze(node);
}


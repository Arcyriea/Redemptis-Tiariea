import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLuaData } from '../src/shipmaker/luaDataParser.mjs';
import type { LuaDataNode, LuaTableNode } from '../src/shipmaker/luaDataParser.mjs';

function parseOk(source: string): LuaTableNode {
    const result = parseLuaData(source);
    if (result.ok) return result.ast;
    assert.fail(result.diagnostics[0]?.message ?? 'Expected parser success.');
}

function parseError(source: string, code: string) {
    const result = parseLuaData(source, { sourceName: 'fixture.lua' });
    if (result.ok) assert.fail('Expected parser failure.');
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, code);
    assert.equal(result.diagnostics[0].sourceName, 'fixture.lua');
    return result.diagnostics[0];
}

function field(table: LuaTableNode, key: string): LuaDataNode {
    const entry = table.entries.find((candidate) => candidate.kind === 'field' && candidate.key === key);
    assert.ok(entry && entry.kind === 'field', `Expected field ${key}.`);
    return entry.value;
}

test('parses nested keyed and positional tables, comments, decimals, and trailing separators', () => {
    const ast = parseOk(`-- weapon-shaped generic data
return {
  id = "weapon.demo",
  operation = { cooldown = 0.25, energyCost = 2 },
  geometry = {
    muzzles = {
      { position = { x = 0, y = -12 }, directionDeg = 0 },
    },
  },
  restrictions = {},
}`);

    assert.equal(ast.kind, 'table');
    assert.deepEqual(ast.entries.map((entry) => entry.kind === 'field' ? entry.key : '<array>'), [
        'id', 'operation', 'geometry', 'restrictions'
    ]);
    assert.deepEqual(field(ast, 'id'), {
        kind: 'string', value: 'weapon.demo', span: field(ast, 'id').span
    });
    const operation = field(ast, 'operation');
    assert.equal(operation.kind, 'table');
    if (operation.kind !== 'table') throw new Error('Expected operation table.');
    assert.equal(field(operation, 'cooldown').kind, 'number');
    const restrictions = field(ast, 'restrictions');
    assert.deepEqual(restrictions.kind === 'table' ? restrictions.entries : null, []);
});

test('parses quoted keys, supported escapes, mixed table entries, and semicolon separators', () => {
    const ast = parseOk(`return {
  ["special-id"] = 'line one\\nline two',
  values = { 1, -2.5e1; enabled = true, false },
}`);
    const specialId = field(ast, 'special-id');
    assert.equal(specialId.kind, 'string');
    if (specialId.kind === 'string') {
        assert.equal(specialId.value, 'line one\nline two');
    }
    const values = field(ast, 'values');
    assert.equal(values.kind, 'table');
    if (values.kind !== 'table') throw new Error('Expected values table.');
    assert.deepEqual(values.entries.map((entry) => entry.kind), ['array', 'array', 'field', 'array']);
    assert.equal(field(values, 'enabled').kind, 'boolean');
});

test('preserves arbitrary nested future collision-like data without interpreting its fields', () => {
    const ast = parseOk(`return {
  collision = {
    profile = "profile.shared",
    shapes = {
      { kind = "shape-a", points = { { x = -1, y = 0 }, { x = 1, y = 0 } } },
      { kind = "shape-b", radius = 12 },
    },
    partAssociations = { { shape = 1, part = "hull-core" } },
  },
}`);
    const collision = field(ast, 'collision');
    assert.equal(collision.kind, 'table');
    if (collision.kind !== 'table') throw new Error('Expected generic nested table.');
    assert.deepEqual(collision.entries.map((entry) => entry.kind === 'field' ? entry.key : '<array>'), [
        'profile', 'shapes', 'partAssociations'
    ]);
});

test('supports keyword-like data only through quoted keys and accepts escaped quotes', () => {
    const ast = parseOk(`return { ["end"] = "quote: \\" and \\'" }`);
    assert.equal(field(ast, 'end').kind, 'string');
});

test('preserves source spans as half-open UTF-16 offsets with one-based line and column', () => {
    const ast = parseOk('return {\n  name = "ship"\n}');
    const name = field(ast, 'name');
    assert.equal(name.span.start.line, 2);
    assert.equal(name.span.start.column, 10);
    assert.equal(name.span.end.offset, 'return {\n  name = "ship"'.length);
    assert.equal(ast.span.start.offset, 7);
});

test('requires a single top-level returned table and rejects trailing statements', () => {
    parseError('local x = {}; return {}', 'unsupported-syntax');
    parseError('return {}; os.execute("x")', 'unsupported-syntax');
    parseError('return "not a table"', 'syntax-error');
});

test('rejects calls, identifiers as values, expressions, nil, numeric keys, and reserved bare keys', () => {
    parseError('return { operation = buildOperation() }', 'unsupported-syntax');
    parseError('return { value = externalValue }', 'unsupported-syntax');
    parseError('return { speed = 1 + 2 }', 'unsupported-syntax');
    parseError('return { nil }', 'unsupported-syntax');
    parseError('return { [1] = "x" }', 'unsupported-syntax');
    parseError('return { end = 1 }', 'unsupported-syntax');
    parseError('return { goto = 1 }', 'unsupported-syntax');
});

test('rejects long-bracket comments and strings with explicit diagnostics', () => {
    parseError('--[[ long comment ]]\nreturn {}', 'unsupported-long-bracket-comment');
    parseError('--[=[ long comment ]=]\nreturn {}', 'unsupported-long-bracket-comment');
    parseError('return { value = [[long string]] }', 'unsupported-long-bracket-string');
    parseError('return { value = [=[long string]=] }', 'unsupported-long-bracket-string');
});

test('rejects duplicate keys after decoding and treats bare and quoted keys identically', () => {
    const duplicate = parseError('return { id = 1, ["id"] = 2 }', 'duplicate-key');
    assert.equal(duplicate.span.start.offset, 'return { id = 1, '.length);
    parseError('return { ["a\\n"] = 1, ["a\\n"] = 2 }', 'duplicate-key');
});

test('rejects repeated separators, missing separators, malformed strings, and invalid escapes', () => {
    parseError('return { 1,, 2 }', 'syntax-error');
    parseError('return { 1 2 }', 'syntax-error');
    parseError('return { value = "unterminated }', 'invalid-string');
    parseError('return { value = "bad\\q" }', 'invalid-string');
    parseError(`return { value = "bad${String.fromCharCode(0x7f)}text" }`, 'invalid-string');
});

test('rejects invalid and non-finite decimal numeric literals', () => {
    parseError('return { value = 1e }', 'invalid-number');
    parseError('return { value = 1e999 }', 'invalid-number');
    parseError('return { value = 0x10 }', 'invalid-number');
    parseError('return { value = +1 }', 'unsupported-syntax');
});

test('rejects input beyond the configured source-size limit', () => {
    const source = `return { value = "${'x'.repeat(1_048_576)}" }`;
    const diagnostic = parseError(source, 'source-size-limit');
    assert.equal(diagnostic.span.start.offset, 1_048_576);
});

test('rejects excessive table nesting at the first over-limit opener', () => {
    const source = `return ${'{'.repeat(129)}${'}'.repeat(129)}`;
    const diagnostic = parseError(source, 'nesting-limit');
    assert.equal(diagnostic.span.start.offset, 7 + 128);
});

test('rejects token and AST-node counts above their independent limits', () => {
    const tokenLimitSource = `return {${Array.from({ length: 50_001 }, (_, index) => String(index)).join(',')}}`;
    assert.equal(parseError(tokenLimitSource, 'token-limit').span.start.offset > 0, true);

    const nodeLimitSource = `return {${Array.from({ length: 25_000 }, () => '0').join(',')}}`;
    assert.equal(parseError(nodeLimitSource, 'ast-node-limit').span.start.offset > 0, true);
});

test('reports malformed structure at the offending token or end of input', () => {
    const missingSeparator = parseError('return { id = 1 other = 2 }', 'syntax-error');
    assert.equal(missingSeparator.span.start.column, 17);
    const unterminatedTable = parseError('return { id = 1', 'syntax-error');
    assert.equal(unterminatedTable.span.start.offset, 'return { id = 1'.length);
});

test('rejects non-string source values without throwing', () => {
    const result = parseLuaData(null as unknown as string, { sourceName: 'non-string' });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.diagnostics[0].code, 'invalid-input');
        assert.equal(result.diagnostics[0].sourceName, 'non-string');
    }
});

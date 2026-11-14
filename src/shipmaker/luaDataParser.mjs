const MAX_SOURCE_CODE_UNITS = 1_048_576;
const MAX_NESTING_DEPTH = 128;
const MAX_TOKENS = 100_000;
const MAX_AST_NODES = 50_000;

// Lua 5.2/5.3 keywords; only true/false are accepted as value literals.
const RESERVED_WORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while'
]);

const LONG_BRACKET_COMMENT_START = /--\[(=*)\[/y;
const LONG_BRACKET_STRING_START = /\[(=*)\[/y;
const DECIMAL_NUMBER = /-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;

function matchAt(regex, source, offset) {
    regex.lastIndex = offset;
    return regex.exec(source);
}

class ParseFault extends Error {
    constructor(diagnostic) {
        super(diagnostic.message);
        this.diagnostic = diagnostic;
    }
}

function createLineStarts(source) {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\r') {
            if (source[index + 1] === '\n') index++;
            starts.push(index + 1);
        } else if (source[index] === '\n') {
            starts.push(index + 1);
        }
    }
    return starts;
}

function positionAt(offset, lineStarts) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle;
    }
    return { offset, line: low + 1, column: offset - lineStarts[low] + 1 };
}

function makeSpan(lineStarts, startOffset, endOffset) {
    return {
        start: positionAt(startOffset, lineStarts),
        end: positionAt(endOffset, lineStarts)
    };
}

function fail(code, message, span) {
    throw new ParseFault({ code, message, span });
}

class Tokenizer {
    constructor(source, lineStarts) {
        this.source = source;
        this.lineStarts = lineStarts;
        this.offset = 0;
        this.line = 1;
        this.column = 1;
        this.tokens = 0;
    }

    tokenize() {
        const tokens = [];
        while (true) {
            this.skipTrivia();
            if (this.offset >= this.source.length) {
                tokens.push({ type: 'eof', value: '', start: this.offset, end: this.offset });
                return tokens;
            }

            const token = this.readToken();
            this.tokens++;
            if (this.tokens > MAX_TOKENS) {
                fail('token-limit', `Lua data exceeds the ${MAX_TOKENS} token limit.`, makeSpan(this.lineStarts, token.start, token.end));
            }
            tokens.push(token);
        }
    }

    skipTrivia() {
        while (this.offset < this.source.length) {
            const character = this.source[this.offset];
            if (character === ' ' || character === '\t' || character === '\v' || character === '\f' || character === '\r' || character === '\n') {
                this.advance();
                continue;
            }

            if (this.source.startsWith('--', this.offset)) {
                const longComment = matchAt(LONG_BRACKET_COMMENT_START, this.source, this.offset);
                if (longComment) {
                    const start = this.offset;
                    const end = start + longComment[0].length;
                    fail('unsupported-long-bracket-comment', 'Long-bracket comments are not supported; use a line comment beginning with --.', makeSpan(this.lineStarts, start, end));
                }
                while (this.offset < this.source.length && this.source[this.offset] !== '\r' && this.source[this.offset] !== '\n') {
                    this.advance();
                }
                continue;
            }

            return;
        }
    }

    readToken() {
        const start = this.offset;
        const character = this.source[this.offset];

        if (character === '[') {
            const longString = matchAt(LONG_BRACKET_STRING_START, this.source, this.offset);
            if (longString) {
                const end = start + longString[0].length;
                fail('unsupported-long-bracket-string', 'Long-bracket strings are not supported; use a quoted string.', makeSpan(this.lineStarts, start, end));
            }
        }

        if (character === '"' || character === "'") return this.readString(character);

        if ((character >= '0' && character <= '9')
            || (character === '.' && this.isDigit(this.source[this.offset + 1]))
            || (character === '-' && this.isNumberStart(this.offset + 1))) {
            return this.readNumber();
        }

        if (this.isIdentifierStart(character)) {
            this.advance();
            while (this.isIdentifierPart(this.source[this.offset])) this.advance();
            return { type: 'identifier', value: this.source.slice(start, this.offset), start, end: this.offset };
        }

        if ('{}[]=,;'.includes(character)) {
            this.advance();
            return { type: 'punctuation', value: character, start, end: this.offset };
        }

        this.advance();
        fail('unsupported-syntax', `Unsupported token ${JSON.stringify(character)}.`, makeSpan(this.lineStarts, start, this.offset));
    }

    readString(quote) {
        const start = this.offset;
        this.advance();
        let value = '';

        while (this.offset < this.source.length) {
            const character = this.source[this.offset];
            if (character === quote) {
                this.advance();
                return { type: 'string', value, start, end: this.offset };
            }
            const codeUnit = character.charCodeAt(0);
            if (character === '\r' || character === '\n' || codeUnit < 0x20 || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
                fail('invalid-string', 'Quoted strings cannot contain raw line breaks or control characters.', makeSpan(this.lineStarts, start, this.offset + 1));
            }
            if (character !== '\\') {
                value += character;
                this.advance();
                continue;
            }

            const escapeStart = this.offset;
            this.advance();
            if (this.offset >= this.source.length) {
                fail('invalid-string', 'String ends with an incomplete escape sequence.', makeSpan(this.lineStarts, escapeStart, this.offset));
            }
            const escaped = this.source[this.offset];
            const escapes = {
                '\\': '\\',
                "'": "'",
                '"': '"',
                n: '\n',
                r: '\r',
                t: '\t'
            };
            if (!Object.hasOwn(escapes, escaped)) {
                this.advance();
                fail('invalid-string', `Unsupported string escape \\${escaped}.`, makeSpan(this.lineStarts, escapeStart, this.offset));
            }
            value += escapes[escaped];
            this.advance();
        }

        fail('invalid-string', 'Unterminated quoted string.', makeSpan(this.lineStarts, start, this.offset));
    }

    readNumber() {
        const start = this.offset;
        const match = matchAt(DECIMAL_NUMBER, this.source, start);
        if (!match) {
            this.advance();
            fail('invalid-number', 'Invalid decimal number literal.', makeSpan(this.lineStarts, start, this.offset));
        }

        const raw = match[0];
        for (let index = 0; index < raw.length; index++) this.advance();
        const next = this.source[this.offset];
        if (next === '.' || this.isIdentifierStart(next)) {
            while (this.offset < this.source.length && /[A-Za-z0-9_.]/.test(this.source[this.offset])) this.advance();
            fail('invalid-number', `Invalid decimal number literal ${JSON.stringify(this.source.slice(start, this.offset))}.`, makeSpan(this.lineStarts, start, this.offset));
        }

        const value = Number(raw);
        if (!Number.isFinite(value)) {
            fail('invalid-number', 'Numeric literals must convert to a finite JavaScript number.', makeSpan(this.lineStarts, start, this.offset));
        }
        return { type: 'number', value, start, end: this.offset };
    }

    isNumberStart(offset) {
        const character = this.source[offset];
        return this.isDigit(character) || (character === '.' && this.isDigit(this.source[offset + 1]));
    }

    isDigit(character) {
        return character !== undefined && character >= '0' && character <= '9';
    }

    isIdentifierStart(character) {
        return character !== undefined && ((character >= 'A' && character <= 'Z')
            || (character >= 'a' && character <= 'z') || character === '_');
    }

    isIdentifierPart(character) {
        return this.isIdentifierStart(character) || this.isDigit(character);
    }

    advance() {
        const character = this.source[this.offset];
        this.offset++;
        if (character === '\r') {
            if (this.source[this.offset] === '\n') this.offset++;
            this.line++;
            this.column = 1;
        } else if (character === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
    }
}

class Parser {
    constructor(source, tokens, lineStarts) {
        this.source = source;
        this.lineStarts = lineStarts;
        this.tokens = tokens;
        this.index = 0;
        this.astNodes = 0;
    }

    parse() {
        const returnToken = this.current();
        if (returnToken.type !== 'identifier' || returnToken.value !== 'return') {
            fail('unsupported-syntax', 'A Lua data file must begin with one return statement.', makeSpan(this.lineStarts, returnToken.start, returnToken.end));
        }
        this.index++;

        const root = this.parseTable(1);
        const trailing = this.current();
        if (trailing.type !== 'eof') {
            fail('unsupported-syntax', `Unexpected content after the returned table: ${this.describe(trailing)}.`, makeSpan(this.lineStarts, trailing.start, trailing.end));
        }
        return root;
    }

    parseValue(depth) {
        const token = this.current();
        if (token.type === 'string' || token.type === 'number') {
            this.index++;
            return this.makeNode({
                kind: token.type,
                value: token.value,
                span: makeSpan(this.lineStarts, token.start, token.end)
            }, token.start, token.end);
        }
        if (token.type === 'punctuation' && token.value === '{') return this.parseTable(depth + 1);
        if (token.type === 'identifier') {
            if (token.value === 'true' || token.value === 'false') {
                this.index++;
                return this.makeNode({
                    kind: 'boolean',
                    value: token.value === 'true',
                    span: makeSpan(this.lineStarts, token.start, token.end)
                }, token.start, token.end);
            }
            if (token.value === 'nil') {
                fail('unsupported-syntax', 'The nil literal is not supported; omit optional fields instead.', makeSpan(this.lineStarts, token.start, token.end));
            }
            fail('unsupported-syntax', `Identifier ${JSON.stringify(token.value)} is not a data literal.`, makeSpan(this.lineStarts, token.start, token.end));
        }
        if (token.type === 'eof') {
            fail('syntax-error', 'Expected a data value but reached end of input.', makeSpan(this.lineStarts, token.start, token.end));
        }
        fail('syntax-error', `Expected a data value, found ${this.describe(token)}.`, makeSpan(this.lineStarts, token.start, token.end));
    }

    parseTable(depth) {
        const open = this.expectPunctuation('{');
        if (depth > MAX_NESTING_DEPTH) {
            fail('nesting-limit', `Lua data exceeds the ${MAX_NESTING_DEPTH} table nesting limit.`, makeSpan(this.lineStarts, open.start, open.end));
        }

        const entries = [];
        const keys = new Set();
        while (!this.isPunctuation('}')) {
            if (this.current().type === 'eof') {
                fail('syntax-error', 'Unterminated table; expected }.', makeSpan(this.lineStarts, open.start, open.end));
            }

            const entryStart = this.current().start;
            const field = this.tryParseKeyedField();
            let entry;
            if (field) {
                if (keys.has(field.key)) {
                    fail('duplicate-key', `Duplicate table key ${JSON.stringify(field.key)}.`, makeSpan(this.lineStarts, field.keyStart, field.keyEnd));
                }
                keys.add(field.key);
                const value = this.parseValue(depth);
                entry = this.makeEntry({
                    kind: 'field',
                    key: field.key,
                    keySpan: makeSpan(this.lineStarts, field.keyStart, field.keyEnd),
                    value,
                    span: makeSpan(this.lineStarts, entryStart, value.span.end.offset)
                }, entryStart, value.span.end.offset);
            } else {
                const value = this.parseValue(depth);
                entry = this.makeEntry({
                    kind: 'array',
                    value,
                    span: makeSpan(this.lineStarts, entryStart, value.span.end.offset)
                }, entryStart, value.span.end.offset);
            }
            entries.push(entry);

            if (this.isPunctuation(',') || this.isPunctuation(';')) {
                this.index++;
                if (this.isPunctuation('}')) break;
                continue;
            }
            if (!this.isPunctuation('}')) {
                const separator = this.current();
                fail('syntax-error', `Expected , ; or } after table entry, found ${this.describe(separator)}.`, makeSpan(this.lineStarts, separator.start, separator.end));
            }
        }

        const close = this.expectPunctuation('}');
        return this.makeNode({
            kind: 'table',
            entries,
            span: makeSpan(this.lineStarts, open.start, close.end)
        }, open.start, close.end);
    }

    tryParseKeyedField() {
        const token = this.current();
        if (token.type === 'identifier' && !RESERVED_WORDS.has(token.value)
            && this.peek().type === 'punctuation' && this.peek().value === '=') {
            this.index += 2;
            return { key: token.value, keyStart: token.start, keyEnd: token.end };
        }

        if (token.type === 'punctuation' && token.value === '[') {
            const key = this.peek();
            const close = this.tokens[this.index + 2];
            const assign = this.tokens[this.index + 3];
            if (key?.type === 'string' && close?.value === ']' && assign?.value === '=') {
                this.index += 4;
                return { key: key.value, keyStart: token.start, keyEnd: close.end };
            }
            fail('unsupported-syntax', 'Bracketed table keys must use a quoted string, for example ["key"].', makeSpan(this.lineStarts, token.start, token.end));
        }
        return null;
    }

    makeNode(node, start, end) {
        this.countNode(start, end);
        return node;
    }

    makeEntry(entry, start, end) {
        this.countNode(start, end);
        return entry;
    }

    countNode(start, end) {
        this.astNodes++;
        if (this.astNodes > MAX_AST_NODES) {
            fail('ast-node-limit', `Lua data exceeds the ${MAX_AST_NODES} AST node limit.`, makeSpan(this.lineStarts, start, end));
        }
    }

    expectPunctuation(value) {
        const token = this.current();
        if (token.type !== 'punctuation' || token.value !== value) {
            fail('syntax-error', `Expected ${value}, found ${this.describe(token)}.`, makeSpan(this.lineStarts, token.start, token.end));
        }
        this.index++;
        return token;
    }

    isPunctuation(value) {
        const token = this.current();
        return token.type === 'punctuation' && token.value === value;
    }

    current() {
        return this.tokens[this.index];
    }

    peek() {
        return this.tokens[this.index + 1];
    }

    describe(token) {
        return token.type === 'eof' ? 'end of input' : JSON.stringify(token.value);
    }
}

/**
 * Parse one restricted, data-only Lua file into a generic source-located AST.
 * This function never executes Lua and performs no domain-schema validation.
 *
 * @param {string} source
 * @param {{ sourceName?: string }} [options]
 * @returns {import('./luaDataParser.d.mts').LuaParseResult}
 */
export function parseLuaData(source, options = {}) {
    const sourceName = options.sourceName ?? '<input>';
    if (typeof source !== 'string') {
        return {
            ok: false,
            diagnostics: [{
                code: 'invalid-input',
                message: 'Lua data source must be a string.',
                sourceName,
                span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } }
            }]
        };
    }
    if (source.length > MAX_SOURCE_CODE_UNITS) {
        const offset = MAX_SOURCE_CODE_UNITS;
        const prefixLineStarts = createLineStarts(source.slice(0, offset + 1));
        return {
            ok: false,
            diagnostics: [{
                code: 'source-size-limit',
                message: `Lua data exceeds the ${MAX_SOURCE_CODE_UNITS} UTF-16 code unit source limit.`,
                sourceName,
                span: { start: positionAt(offset, prefixLineStarts), end: positionAt(offset + 1, prefixLineStarts) }
            }]
        };
    }

    try {
        const lineStarts = createLineStarts(source);
        const tokens = new Tokenizer(source, lineStarts).tokenize();
        const ast = new Parser(source, tokens, lineStarts).parse();
        return { ok: true, ast, sourceName };
    } catch (error) {
        if (!(error instanceof ParseFault)) throw error;
        return {
            ok: false,
            diagnostics: [{ ...error.diagnostic, sourceName }]
        };
    }
}

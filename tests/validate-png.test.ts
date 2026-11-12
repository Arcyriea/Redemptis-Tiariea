import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import {
    assertPngAggregateLimits,
    assertPngAggregateDecodedLimits,
    PNG_LIMITS,
    validatePng
} from '../scripts/validate-png.mjs';

const ASSET = { logicalPath: 'assets/Planets/test.png' };
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
    const typeBytes = Buffer.from(type, 'ascii');
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    typeBytes.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
    return output;
}

function header(width = 1, height = 1) {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = 8;
    data[9] = 6;
    return chunk('IHDR', data);
}

function png({
    width = 1,
    height = 1,
    raw,
    idatParts,
    beforeIdat = [],
    afterIdat = [],
    trailing = Buffer.alloc(0)
}: {
    width?: number;
    height?: number;
    raw?: Buffer;
    idatParts?: Buffer[];
    beforeIdat?: Buffer[];
    afterIdat?: Buffer[];
    trailing?: Buffer;
} = {}) {
    const compressed = deflateSync(raw ?? Buffer.alloc((width * 4 + 1) * height));
    const parts = idatParts ?? [compressed];
    return Buffer.concat([
        SIGNATURE,
        header(width, height),
        ...beforeIdat,
        ...parts.map((part) => chunk('IDAT', part)),
        ...afterIdat,
        chunk('IEND', Buffer.alloc(0)),
        trailing
    ]);
}

function corruptChunkCrc(bytes: Buffer, targetType: string) {
    const output = Buffer.from(bytes);
    let offset = SIGNATURE.length;
    while (offset + 12 <= output.length) {
        const length = output.readUInt32BE(offset);
        const type = output.toString('ascii', offset + 4, offset + 8);
        if (type === targetType) {
            output[offset + 8 + length] ^= 0xff;
            return output;
        }
        offset += 12 + length;
    }
    throw new Error(`Missing test chunk ${targetType}`);
}

test('accepts multiple consecutive IDAT chunks as one zlib stream', async () => {
    const raw = Buffer.from([0, 1, 2, 3, 4]);
    const compressed = deflateSync(raw);
    const split = Math.floor(compressed.length / 2);
    const bytes = png({ raw, idatParts: [compressed.subarray(0, split), compressed.subarray(split)] });
    assert.equal((await validatePng(bytes, ASSET)).scanlineBytes, 5);
});

test('accepts optional valid PLTE chunks for color type 6', async () => {
    await assert.doesNotReject(validatePng(png({ beforeIdat: [chunk('PLTE', Buffer.from([0, 1, 2]))] }), ASSET));
    await assert.doesNotReject(validatePng(png({ beforeIdat: [chunk('PLTE', Buffer.alloc(768))] }), ASSET));
    await assert.doesNotReject(validatePng(png(), ASSET));
});

test('rejects invalid PLTE size, multiplicity, and placement', async () => {
    for (const palette of [Buffer.alloc(0), Buffer.alloc(2), Buffer.alloc(771)]) {
        await assert.rejects(validatePng(png({ beforeIdat: [chunk('PLTE', palette)] }), ASSET), /malformed or misplaced PLTE/);
    }
    await assert.rejects(
        validatePng(png({ beforeIdat: [chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3))] }), ASSET),
        /malformed or misplaced PLTE/
    );
    await assert.rejects(
        validatePng(png({ afterIdat: [chunk('PLTE', Buffer.alloc(3))] }), ASSET),
        /malformed or misplaced PLTE/
    );
});

test('rejects invalid chunk order, truncation, and unsupported critical chunks', async () => {
    await assert.rejects(
        validatePng(Buffer.concat([SIGNATURE, chunk('tEXt', Buffer.from('before header')), header()]), ASSET),
        /does not begin with IHDR/
    );
    await assert.rejects(
        validatePng(png({ afterIdat: [chunk('tEXt', Buffer.from('breaks IDAT run')), chunk('IDAT', deflateSync(Buffer.alloc(5)))] }), ASSET),
        /non-contiguous IDAT/
    );
    await assert.rejects(validatePng(png().subarray(0, png().length - 2), ASSET), /truncated PNG chunk/);
    await assert.rejects(
        validatePng(png({ beforeIdat: [chunk('ABCD', Buffer.alloc(0))] }), ASSET),
        /unsupported critical PNG chunk ABCD/
    );
});

test('checks CRCs in IHDR, PLTE, IDAT, and IEND chunks', async () => {
    const bytes = png({ beforeIdat: [chunk('PLTE', Buffer.from([1, 2, 3]))] });
    for (const type of ['IHDR', 'PLTE', 'IDAT', 'IEND']) {
        await assert.rejects(validatePng(corruptChunkCrc(bytes, type), ASSET), new RegExp(`invalid CRC for PNG chunk ${type}`));
    }
});

test('rejects truncated zlib streams, unused compressed bytes, and trailing data', async () => {
    const raw = Buffer.alloc(5);
    const compressed = deflateSync(raw);
    await assert.rejects(validatePng(png({ raw, idatParts: [compressed.subarray(0, compressed.length - 1)] }), ASSET), /could not be safely decompressed/);
    await assert.rejects(validatePng(png({ raw, idatParts: [Buffer.concat([compressed, Buffer.from([1, 2, 3])])] }), ASSET), /unused bytes/);
    await assert.rejects(validatePng(png({ trailing: Buffer.from([0]) }), ASSET), /trailing bytes after IEND/);
});

test('enforces dimensions, compressed-file size, and exact inflated scanline length', async () => {
    await assert.rejects(validatePng(png({ width: 0 }), ASSET), /dimensions outside/);
    await assert.rejects(validatePng(png({ width: PNG_LIMITS.maxWidth + 1 }), ASSET), /dimensions outside/);
    await assert.rejects(validatePng(png({ height: PNG_LIMITS.maxHeight + 1 }), ASSET), /dimensions outside/);

    const oversizedAncillary = chunk('tEXt', Buffer.alloc(PNG_LIMITS.maxFileBytes));
    await assert.rejects(validatePng(Buffer.concat([SIGNATURE, header(), oversizedAncillary]), ASSET), /PNG file-size limit/);

    await assert.rejects(
        validatePng(png({ raw: Buffer.alloc(4) }), ASSET),
        /scanline bytes; expected 5/
    );
});

test('counts ancillary PNG chunks toward aggregate full-file-size limit', async () => {
    const baselineBytes = png();
    const withAncillaryChunk = png({ beforeIdat: [chunk('tEXt', Buffer.alloc(64))] });
    const baselineMetrics = await validatePng(baselineBytes, ASSET);
    const expandedMetrics = await validatePng(withAncillaryChunk, ASSET);
    assert.equal(baselineMetrics.compressedBytes, expandedMetrics.compressedBytes);
    assert.equal(expandedMetrics.fileBytes, withAncillaryChunk.length);
    assert.ok(expandedMetrics.fileBytes > baselineMetrics.fileBytes);

    const limits = {
        maxAggregateFileBytes: baselineMetrics.fileBytes + 1,
        maxAggregateDecodedPixelBytes: 0,
        maxAggregateScanlineBytes: 0
    };
    assert.doesNotThrow(() => assertPngAggregateLimits(
        baselineMetrics.fileBytes,
        0,
        0,
        'test PNG set',
        limits
    ));
    assert.throws(
        () => assertPngAggregateLimits(expandedMetrics.fileBytes, 0, 0, 'test PNG set', limits),
        /aggregate PNG file-size limit/
    );
});

test('accepts scanline filter bytes 0 through 4 and rejects filter 5', async () => {
    for (let filter = 0; filter <= 4; filter += 1) {
        assert.equal((await validatePng(png({ raw: Buffer.from([filter, 0, 0, 0, 0]) }), ASSET)).scanlineBytes, 5);
    }
    await assert.rejects(validatePng(png({ raw: Buffer.from([5, 0, 0, 0, 0]) }), ASSET), /unsupported scanline filter 5/);
});

test('accepts a maximum-dimension RGBA8 PNG at the approved pixel and scanline limits', async () => {
    const bytes = png({ width: 4096, height: 4096 });
    const metrics = await validatePng(bytes, ASSET);
    assert.equal(metrics.decodedPixelBytes, PNG_LIMITS.maxDecodedPixelBytes);
    assert.equal(metrics.scanlineBytes, PNG_LIMITS.maxInflatedScanlineBytes);
});

test('applies independent aggregate decoded-pixel and inflated-scanline limits', () => {
    const limits = {
        maxAggregateDecodedPixelBytes: 100,
        maxAggregateScanlineBytes: 120
    };
    assert.throws(
        () => assertPngAggregateDecodedLimits(101, 110, 'test aggregate', limits),
        /aggregate decoded pixel limit/
    );
    assert.throws(
        () => assertPngAggregateDecodedLimits(100, 121, 'test aggregate', limits),
        /aggregate inflated scanline limit/
    );
    assert.doesNotThrow(() => assertPngAggregateDecodedLimits(100, 120, 'test aggregate', limits));
});

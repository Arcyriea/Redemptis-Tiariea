import { Readable } from 'node:stream';
import { createInflate } from 'node:zlib';

export const PNG_LIMITS = Object.freeze({
    maxWidth: 4096,
    maxHeight: 4096,
    maxFileBytes: 8 * 1024 * 1024,
    maxAggregateFileBytes: 32 * 1024 * 1024,
    maxDecodedPixelBytes: 64 * 1024 * 1024,
    maxInflatedScanlineBytes: 64 * 1024 * 1024 + 4096,
    maxAggregateDecodedPixelBytes: 256 * 1024 * 1024,
    maxAggregateScanlineBytes: 257 * 1024 * 1024
});

export function assertPngAggregateDecodedLimits(decodedPixelBytes, inflatedScanlineBytes, label, limits = PNG_LIMITS) {
    if (decodedPixelBytes > limits.maxAggregateDecodedPixelBytes) {
        throw new Error(`${label} exceeds the ${limits.maxAggregateDecodedPixelBytes}-byte aggregate decoded pixel limit`);
    }
    if (inflatedScanlineBytes > limits.maxAggregateScanlineBytes) {
        throw new Error(`${label} exceeds the ${limits.maxAggregateScanlineBytes}-byte aggregate inflated scanline limit`);
    }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC_TABLE.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    CRC_TABLE[index] = crc >>> 0;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function fail(asset, message) {
    throw new Error(`Fatal: PNG asset ${asset.logicalPath} ${message}`);
}

async function inflatePngChunks(chunks, expectedOutputBytes, compressedBytes, asset) {
    const inflater = createInflate();
    Readable.from(chunks).pipe(inflater);
    const outputChunks = [];
    let outputBytes = 0;
    try {
        for await (const output of inflater) {
            outputBytes += output.length;
            if (outputBytes > expectedOutputBytes) {
                inflater.destroy();
                fail(asset, `inflated scanline data exceeds its ${expectedOutputBytes}-byte limit`);
            }
            outputChunks.push(output);
        }
    } catch (error) {
        if (error.message.startsWith(`Fatal: PNG asset ${asset.logicalPath}`)) {
            throw error;
        }
        fail(asset, `could not be safely decompressed: ${error.message}`);
    }

    if (!inflater.readableEnded) {
        fail(asset, 'compressed IDAT stream did not terminate cleanly');
    }
    if (inflater.bytesWritten !== compressedBytes) {
        fail(asset, 'contains unused bytes after the compressed IDAT stream');
    }
    return Buffer.concat(outputChunks, outputBytes);
}

export async function validatePng(bytes, asset) {
    if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length + 25) {
        fail(asset, 'is shorter than the minimum PNG structure');
    }
    if (bytes.length > PNG_LIMITS.maxFileBytes) {
        fail(asset, `exceeds the ${PNG_LIMITS.maxFileBytes}-byte compressed file limit`);
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        fail(asset, 'has an invalid PNG signature');
    }

    let offset = PNG_SIGNATURE.length;
    let width;
    let height;
    let sawHeader = false;
    let sawIdat = false;
    let idatEnded = false;
    let sawPalette = false;
    let sawEnd = false;
    const idatChunks = [];
    let compressedBytes = 0;

    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) {
            fail(asset, 'contains a truncated PNG chunk');
        }
        const length = bytes.readUInt32BE(offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const chunkEnd = dataEnd + 4;
        if (chunkEnd > bytes.length) {
            fail(asset, 'contains a PNG chunk outside the file bounds');
        }
        const type = bytes.toString('ascii', typeStart, typeStart + 4);
        if (!/^[A-Za-z]{4}$/.test(type) || (type.charCodeAt(2) & 0x20) !== 0) {
            fail(asset, `contains an invalid PNG chunk type "${type}"`);
        }
        const chunkBytes = bytes.subarray(typeStart, dataEnd);
        if (crc32(chunkBytes) !== bytes.readUInt32BE(dataEnd)) {
            fail(asset, `has an invalid CRC for PNG chunk ${type}`);
        }
        const data = bytes.subarray(dataStart, dataEnd);

        if (!sawHeader && type !== 'IHDR') {
            fail(asset, 'does not begin with IHDR');
        }
        if (type === 'IHDR') {
            if (sawHeader || length !== 13) {
                fail(asset, 'has a duplicate or malformed IHDR chunk');
            }
            sawHeader = true;
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            const bitDepth = data[8];
            const colorType = data[9];
            const compressionMethod = data[10];
            const filterMethod = data[11];
            const interlaceMethod = data[12];
            if (width === 0 || height === 0
                || width > PNG_LIMITS.maxWidth || height > PNG_LIMITS.maxHeight) {
                fail(asset, `has dimensions outside the ${PNG_LIMITS.maxWidth}x${PNG_LIMITS.maxHeight} limit`);
            }
            if (bitDepth !== 8 || colorType !== 6) {
                fail(asset, `uses unsupported PNG profile (expected color type 6, bit depth 8; got ${colorType}/${bitDepth})`);
            }
            if (compressionMethod !== 0 || filterMethod !== 0 || interlaceMethod !== 0) {
                fail(asset, 'uses unsupported PNG compression, filter, or interlace profile (only method 0 and non-interlaced images are supported)');
            }
        } else if (type === 'IDAT') {
            if (idatEnded) {
                fail(asset, 'has non-contiguous IDAT chunks');
            }
            sawIdat = true;
            compressedBytes += length;
            if (compressedBytes > PNG_LIMITS.maxFileBytes) {
                fail(asset, `exceeds the ${PNG_LIMITS.maxFileBytes}-byte compressed IDAT limit`);
            }
            idatChunks.push(data);
        } else if (type === 'IEND') {
            if (length !== 0 || !sawIdat || sawEnd) {
                fail(asset, 'has a malformed or misplaced IEND chunk');
            }
            sawEnd = true;
        } else if (type === 'PLTE') {
            if (sawPalette || sawIdat || length < 3 || length > 768 || length % 3 !== 0) {
                fail(asset, 'has a malformed or misplaced PLTE chunk');
            }
            sawPalette = true;
        } else {
            if (sawIdat) {
                idatEnded = true;
            }
            const isCritical = (type.charCodeAt(0) & 0x20) === 0;
            if (isCritical && type !== 'PLTE') {
                fail(asset, `contains unsupported critical PNG chunk ${type}`);
            }
        }

        offset = chunkEnd;
        if (sawEnd) {
            if (offset !== bytes.length) {
                fail(asset, 'contains trailing bytes after IEND');
            }
            break;
        }
    }
    if (!sawHeader || !sawIdat || !sawEnd) {
        fail(asset, 'is missing IHDR, IDAT, or IEND');
    }

    const rowBytes = width * 4;
    const decodedPixelBytes = rowBytes * height;
    const scanlineBytes = (rowBytes + 1) * height;
    if (decodedPixelBytes > PNG_LIMITS.maxDecodedPixelBytes) {
        fail(asset, `exceeds the ${PNG_LIMITS.maxDecodedPixelBytes}-byte per-image decoded pixel limit`);
    }
    if (scanlineBytes > PNG_LIMITS.maxInflatedScanlineBytes) {
        fail(asset, `exceeds the ${PNG_LIMITS.maxInflatedScanlineBytes}-byte per-image inflated scanline limit`);
    }
    const scanlines = await inflatePngChunks(idatChunks, scanlineBytes, compressedBytes, asset);
    if (scanlines.length !== scanlineBytes) {
        fail(asset, `decoded to ${scanlines.length} scanline bytes; expected ${scanlineBytes}`);
    }
    for (let row = 0; row < height; row += 1) {
        const filter = scanlines[row * (rowBytes + 1)];
        if (filter > 4) {
            fail(asset, `uses unsupported scanline filter ${filter} on row ${row}`);
        }
    }

    return {
        width,
        height,
        compressedBytes,
        decodedPixelBytes,
        scanlineBytes
    };
}

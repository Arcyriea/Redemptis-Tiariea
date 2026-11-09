import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import saxes from 'saxes';
import { fileURLToPath } from 'node:url';
import { readAssetRegistry, resolveAssetSource, PROJECT_ROOT } from './asset-registry.mjs';
import { assertPngAggregateDecodedLimits, PNG_LIMITS, validatePng } from './validate-png.mjs';

const HEADER_SIZE = 64;
const INDEX_HEADER_SIZE = 28;
const RECORD_SIZE = 72;
const DIGEST_SIZE = 32;
const FORMAT_VERSION = 0x0100;
const HEADER_FLAGS = 0x0003;
const UINT32_MAX = 0xffffffffn;
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CONTENT_TYPE_CODES = Object.freeze({ SVG: 0, PNG: 1 });
const MAX_AGGREGATE_PNG_BYTES = PNG_LIMITS.maxAggregateFileBytes;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest();
}

function sha256Hex(bytes) {
    return sha256(bytes).toString('hex');
}

function ensureUint32(value, label) {
    if (value < 0n || value > UINT32_MAX) {
        throw new Error(`${label} exceeds the v1 uint32 range`);
    }
}

function ensureUint64(value, label) {
    if (value < 0n || value > 0xffffffffffffffffn) {
        throw new Error(`${label} exceeds the v1 uint64 range`);
    }
}

function ensureSafeNumber(value, label) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${label} cannot be represented safely by this runtime`);
    }
    return Number(value);
}

function decodeSvg(bytes, asset) {
    if (bytes.length === 0) {
        throw new Error(`Fatal: asset ${asset.logicalPath} is a zero-byte file`);
    }
    if (BigInt(bytes.length) > UINT32_MAX) {
        throw new Error(`Fatal: asset ${asset.logicalPath} exceeds the v1 maximum size of ${UINT32_MAX} bytes`);
    }

    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        throw new Error(`Fatal: asset ${asset.logicalPath} is not valid UTF-8 XML: ${error.message}`);
    }

    let rootName = null;
    let parseError = null;
    const parser = new saxes.SaxesParser({ xmlns: true });
    parser.on('error', (error) => {
        parseError = error;
    });
    parser.on('opentag', (node) => {
        if (rootName === null) {
            rootName = node.local ?? node.name.split(':').at(-1);
            if (node.uri && node.uri !== SVG_NAMESPACE) {
                parseError = new Error(`unexpected root namespace "${node.uri}"`);
            }
        }
    });

    try {
        parser.write(text).close();
    } catch (error) {
        parseError ??= error;
    }

    if (parseError) {
        throw new Error(`Fatal: asset ${asset.logicalPath} is not a well-formed SVG document: ${parseError.message}`);
    }
    if (!rootName || !/^(?:[a-zA-Z_][\w.-]*:)?svg$/.test(rootName)) {
        throw new Error(`Fatal: asset ${asset.logicalPath} does not have an SVG document root`);
    }
}

function encodeAssetId(assetId) {
    const encoded = Buffer.from(assetId, 'utf8');
    ensureUint32(BigInt(encoded.length), `Asset ID "${assetId}" byte length`);
    return encoded;
}

function createBundle(bundleId, bundleFile, assets) {
    if (assets.length === 0) {
        throw new Error(`Fatal: no assets were packaged for bundle "${bundleId}". Cannot generate incomplete bundle.`);
    }

    const orderedAssets = [...assets].sort((left, right) => (
        left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
    ));
    const ids = new Set();
    const idBytes = orderedAssets.map(({ assetId }) => {
        if (ids.has(assetId)) {
            throw new Error(`Fatal: duplicate asset ID "${assetId}" detected. Asset IDs must be unique.`);
        }
        ids.add(assetId);
        return encodeAssetId(assetId);
    });

    const stringTableSize = idBytes.reduce((size, id) => size + BigInt(id.length), 0n);
    ensureUint32(stringTableSize, 'String table size');

    const recordTableSize = BigInt(orderedAssets.length) * BigInt(RECORD_SIZE);
    ensureUint32(BigInt(orderedAssets.length), 'Entry count');
    const stringTableOffset = BigInt(INDEX_HEADER_SIZE) + recordTableSize;
    const indexSize = BigInt(INDEX_HEADER_SIZE) + recordTableSize + stringTableSize + BigInt(DIGEST_SIZE);
    const payloadOffset = BigInt(HEADER_SIZE) + indexSize;
    const payloadSize = orderedAssets.reduce((size, asset) => size + BigInt(asset.bytes.length), 0n);
    ensureUint64(indexSize, 'Index size');
    ensureUint64(payloadOffset, 'Payload offset');
    ensureUint64(payloadOffset + payloadSize, 'Final bundle size');

    const indexBuffer = Buffer.alloc(ensureSafeNumber(indexSize, 'Index size'));
    indexBuffer.write('INDX', 0, 'ascii');
    indexBuffer.writeUInt32LE(orderedAssets.length, 4);
    indexBuffer.writeUInt16LE(RECORD_SIZE, 8);
    indexBuffer.writeUInt16LE(0, 10);
    indexBuffer.writeBigUInt64LE(stringTableOffset, 12);
    indexBuffer.writeBigUInt64LE(stringTableSize, 20);

    let nextStringOffset = 0n;
    let nextPayloadOffset = 0n;
    let stringCursor = ensureSafeNumber(stringTableOffset, 'String table offset');
    let payloadCursor = 0;

    orderedAssets.forEach((asset, index) => {
        const recordStart = INDEX_HEADER_SIZE + index * RECORD_SIZE;
        const id = idBytes[index];
        const payloadSize = BigInt(asset.bytes.length);
        ensureUint64(nextPayloadOffset, 'Payload-relative offset');
        ensureUint64(payloadSize, 'Stored size');
        ensureUint64(payloadSize, 'Original size');

        indexBuffer.writeUInt32LE(Number(nextStringOffset), recordStart);
        indexBuffer.writeUInt32LE(id.length, recordStart + 4);
        indexBuffer.writeBigUInt64LE(nextPayloadOffset, recordStart + 8);
        indexBuffer.writeBigUInt64LE(payloadSize, recordStart + 16);
        indexBuffer.writeBigUInt64LE(payloadSize, recordStart + 24);
        indexBuffer.writeUInt16LE(CONTENT_TYPE_CODES[asset.contentType], recordStart + 32);
        indexBuffer.writeUInt16LE(0, recordStart + 34);
        indexBuffer.writeUInt32LE(0, recordStart + 36);
        sha256(asset.bytes).copy(indexBuffer, recordStart + 40);
        id.copy(indexBuffer, stringCursor);
        stringCursor += id.length;
        payloadCursor += asset.bytes.length;
        nextStringOffset += BigInt(id.length);
        nextPayloadOffset += payloadSize;
    });

    const indexDigestOffset = indexBuffer.length - DIGEST_SIZE;
    sha256(indexBuffer.subarray(0, indexDigestOffset)).copy(indexBuffer, indexDigestOffset);

    const output = Buffer.alloc(ensureSafeNumber(payloadOffset + payloadSize, 'Bundle size'));
    output.write('RTAB', 0, 'ascii');
    output.writeUInt16LE(FORMAT_VERSION, 4);
    output.writeUInt16LE(HEADER_FLAGS, 6);
    output.writeBigUInt64LE(payloadOffset, 8);
    output.writeBigUInt64LE(BigInt(HEADER_SIZE), 16);
    output.writeBigUInt64LE(indexSize, 24);
    indexBuffer.copy(output, HEADER_SIZE);
    let outputPayloadCursor = ensureSafeNumber(payloadOffset, 'Payload offset');
    orderedAssets.forEach((asset) => {
        asset.bytes.copy(output, outputPayloadCursor);
        outputPayloadCursor += asset.bytes.length;
    });

    return {
        bytes: output,
        bundleId,
        bundleFile,
        bundleSha256: sha256Hex(output),
        assetIds: orderedAssets.map((asset) => asset.assetId)
    };
}

function buildManifestSchema() {
    return {
        $schema: JSON_SCHEMA_DIALECT,
        title: 'RTAB asset manifest',
        type: 'object',
        additionalProperties: false,
        required: ['manifestSchemaVersion', 'assets', 'bundles'],
        properties: {
            manifestSchemaVersion: { const: '1.1' },
            assets: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'],
                    properties: {
                        assetId: { type: 'string', minLength: 1 },
                        logicalPath: { type: 'string', pattern: '^assets/.+\\.(svg|png)$' },
                        textureKey: { type: 'string', minLength: 1 },
                        aliases: { type: 'array', items: { type: 'string' } },
                        contentType: { enum: ['SVG', 'PNG'] },
                        sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                        bundleId: { type: 'string', minLength: 1 }
                    }
                }
            },
            bundles: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'],
                    properties: {
                        bundleId: { type: 'string', minLength: 1 },
                        bundleFile: { type: 'string', pattern: '^/assets/.+\\.bin$' },
                        formatVersion: { const: '1.0' },
                        assetCount: { type: 'integer', minimum: 1 },
                        bundleSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
                    }
                }
            }
        }
    };
}

function stringifyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function safeBundlePath(projectRoot, bundleFile) {
    const publicRoot = path.resolve(projectRoot, 'public');
    const outputPath = path.resolve(publicRoot, `.${bundleFile}`);
    if (!outputPath.startsWith(`${publicRoot}${path.sep}`)) {
        throw new Error(`Bundle path escapes public root: ${bundleFile}`);
    }
    return outputPath;
}

async function readCommittedOutput(filePath, label, encoding) {
    let info;
    try {
        info = await lstat(filePath);
    } catch (error) {
        throw new Error(`${label} is unavailable at ${filePath}: ${error.message}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    if (bytes.length !== info.size) {
        throw new Error(`${label} changed while being read: ${filePath}`);
    }
    return encoding ? bytes.toString(encoding) : bytes;
}

function normalizeCategoryName(name) {
    if (!/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(name)) {
        throw new Error(`Unsafe asset category directory name "${name}"; category names must be ASCII letters, digits, spaces, underscores, or hyphens`);
    }
    return name.toLowerCase().split(/[ _-]+/).filter(Boolean).join('-');
}

async function readSafeDirectory(directory) {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error(`Asset source entry is not a real directory: ${directory}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const info = await lstat(entryPath);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
            throw new Error(`Asset source entry must be a regular file or directory, not a link or special file: ${entryPath}`);
        }
    }
    return entries;
}

async function discoverCategoryAssets(projectRoot, registry) {
    const privateRoot = path.join(projectRoot, 'private');
    const assetsRoot = path.join(projectRoot, 'private', 'assets');
    const privateInfo = await lstat(privateRoot);
    if (privateInfo.isSymbolicLink() || !privateInfo.isDirectory()) {
        throw new Error(`Private source root is not a real directory: ${privateRoot}`);
    }
    const rootEntries = await readSafeDirectory(assetsRoot);
    const registeredByPath = new Map(registry.assets.map((asset) => [asset.logicalPath, asset]));
    const registeredByLowerPath = new Map(registry.assets.map((asset) => [asset.logicalPath.toLowerCase(), asset.logicalPath]));
    const normalizedCategories = new Map();
    const discoveredByPath = new Map();
    const categories = [];

    for (const entry of rootEntries) {
        if (!entry.isDirectory()) {
            throw new Error(`Asset files must be inside a top-level category directory: ${path.join(assetsRoot, entry.name)}`);
        }
        const bundleId = normalizeCategoryName(entry.name);
        const priorCategory = normalizedCategories.get(bundleId);
        if (priorCategory) {
            throw new Error(`Asset category names "${priorCategory}" and "${entry.name}" collide after normalization to "${bundleId}"`);
        }
        normalizedCategories.set(bundleId, entry.name);

        const category = { name: entry.name, bundleId, assets: [] };
        async function walk(directory, relativeDirectory) {
            for (const child of await readSafeDirectory(directory)) {
                const childRelative = `${relativeDirectory}/${child.name}`;
                const childPath = path.join(directory, child.name);
                if (child.isDirectory()) {
                    await walk(childPath, childRelative);
                    continue;
                }

                const logicalPath = `assets/${entry.name}${childRelative}`;
                const registered = registeredByPath.get(logicalPath);
                if (!registered) {
                    const caseVariant = registeredByLowerPath.get(logicalPath.toLowerCase());
                    if (caseVariant) {
                        throw new Error(`Asset source path casing differs from registry: expected "${caseVariant}", found "${logicalPath}"`);
                    }
                    throw new Error(`Unregistered asset source file: ${logicalPath}`);
                }
                discoveredByPath.set(logicalPath, registered);
                category.assets.push(registered);
            }
        }
        await walk(path.join(assetsRoot, entry.name), '');
        if (category.assets.length > 0) {
            categories.push(category);
        }
    }

    for (const asset of registry.assets) {
        const relative = asset.logicalPath.slice('assets/'.length);
        if (!relative.includes('/')) {
            throw new Error(`Registered asset must be inside a top-level category directory: ${asset.logicalPath}`);
        }
        if (!discoveredByPath.has(asset.logicalPath)) {
            throw new Error(`Fatal: could not find canonical source for asset ${asset.assetId}: ${asset.logicalPath}`);
        }
    }
    return { assetsRoot, categories };
}

async function loadValidatedInputs(projectRoot, registry) {
    const validatedAssets = [];
    let aggregatePngBytes = 0;
    let aggregatePngPixelBytes = 0;
    let aggregatePngScanlineBytes = 0;
    for (const asset of registry.assets) {
        if (!Object.hasOwn(CONTENT_TYPE_CODES, asset.contentType)) {
            throw new Error(`Fatal: unsupported content type ${asset.contentType} for asset ${asset.assetId}`);
        }
        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        let fileStat;
        try {
            fileStat = await lstat(sourcePath, { bigint: true });
        } catch (error) {
            throw new Error(`Fatal: could not find canonical source for asset ${asset.assetId}: ${asset.logicalPath} (${error.message})`);
        }
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
            throw new Error(`Fatal: canonical source for asset ${asset.assetId} is not a file: ${asset.logicalPath}`);
        }
        if (fileStat.size === 0n) {
            throw new Error(`Fatal: asset ${asset.logicalPath} is a zero-byte file`);
        }
        const maxFileSize = asset.contentType === 'PNG' ? BigInt(PNG_LIMITS.maxFileBytes) : UINT32_MAX;
        if (fileStat.size > maxFileSize) {
            throw new Error(`Fatal: asset ${asset.logicalPath} exceeds the maximum size for ${asset.contentType} (${maxFileSize} bytes)`);
        }
        const bytes = await readFile(sourcePath);
        if (BigInt(bytes.length) !== fileStat.size) {
            throw new Error(`Fatal: canonical source changed while reading asset ${asset.logicalPath}`);
        }
        let pngMetrics = null;
        if (asset.contentType === 'SVG') {
            decodeSvg(bytes, asset);
        } else {
            aggregatePngBytes += bytes.length;
            if (aggregatePngBytes > MAX_AGGREGATE_PNG_BYTES) {
                throw new Error(`Fatal: aggregate PNG source size exceeds ${MAX_AGGREGATE_PNG_BYTES} bytes`);
            }
            pngMetrics = await validatePng(bytes, asset);
            aggregatePngPixelBytes += pngMetrics.decodedPixelBytes;
            aggregatePngScanlineBytes += pngMetrics.scanlineBytes;
            assertPngAggregateDecodedLimits(
                aggregatePngPixelBytes,
                aggregatePngScanlineBytes,
                'Fatal: aggregate PNG assets'
            );
        }
        validatedAssets.push({
            ...asset,
            bytes,
            sourceSha256: sha256Hex(bytes),
            pngMetrics
        });
    }
    return validatedAssets;
}

export async function createAssetPackageOutputs({ projectRoot = PROJECT_ROOT } = {}) {
    const registry = await readAssetRegistry(projectRoot);
    const { categories } = await discoverCategoryAssets(projectRoot, registry);
    const validatedAssets = await loadValidatedInputs(projectRoot, registry);
    const outputFiles = new Map();
    const manifestAssets = [];
    const manifestBundles = [];

    for (const category of categories) {
        const bundleId = category.bundleId;
        const bundleFile = `/assets/${bundleId}.bin`;
        const members = category.assets.map((asset) => (
            validatedAssets.find((validated) => validated.assetId === asset.assetId)
        ));
        const bundleResult = createBundle(bundleId, bundleFile, members);
        outputFiles.set(safeBundlePath(projectRoot, bundleFile), bundleResult.bytes);
        manifestBundles.push({
            bundleId,
            bundleFile,
            formatVersion: '1.0',
            assetCount: members.length,
            bundleSha256: bundleResult.bundleSha256
        });
        for (const asset of members) {
            manifestAssets.push({
                assetId: asset.assetId,
                logicalPath: asset.logicalPath,
                textureKey: asset.textureKey,
                aliases: asset.aliases,
                contentType: asset.contentType,
                sourceSha256: asset.sourceSha256,
                bundleId: category.bundleId
            });
        }
    }

    const manifest = {
        manifestSchemaVersion: '1.1',
        assets: manifestAssets.sort((left, right) => left.assetId.localeCompare(right.assetId)),
        bundles: manifestBundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId))
    };
    const assetRoot = path.join(projectRoot, 'public', 'assets');
    outputFiles.set(path.join(assetRoot, 'asset-manifest.json'), stringifyJson(manifest));
    outputFiles.set(path.join(assetRoot, 'asset-manifest-schema.json'), stringifyJson(buildManifestSchema()));

    validateManifest(manifest, registry);
    for (const bundle of manifest.bundles) {
        const bundleBytes = outputFiles.get(safeBundlePath(projectRoot, bundle.bundleFile));
        if (!bundleBytes) {
            throw new Error(`Generated RTAB bundle "${bundle.bundleId}" is missing from staged output`);
        }
        assertDigest(sha256(bundleBytes), Buffer.from(bundle.bundleSha256, 'hex'), `Generated bundle "${bundle.bundleId}"`);
        const expectedAssets = manifest.assets
            .filter((asset) => asset.bundleId === bundle.bundleId)
            .map((asset) => ({ assetId: asset.assetId, contentType: asset.contentType, logicalPath: asset.logicalPath }))
            .sort((left, right) => (
                left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
            ));
        await validateRtabBundle(bundleBytes, bundle, expectedAssets);
    }

    return { registry, manifest, outputFiles };
}

function assertHexDigest(value, label) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`Invalid ${label} SHA-256 digest`);
    }
}

function assertDigest(actual, expected, label) {
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error(`${label} SHA-256 mismatch`);
    }
}

function readUInt64(buffer, offset, label) {
    const value = buffer.readBigUInt64LE(offset);
    ensureUint64(value, label);
    return value;
}

export async function validateRtabBundle(bytes, bundle, expectedAssets) {
    if (!Buffer.isBuffer(bytes) || bytes.length < HEADER_SIZE) {
        throw new Error(`RTAB bundle "${bundle.bundleId}" is shorter than its ${HEADER_SIZE}-byte header`);
    }
    if (bytes.toString('ascii', 0, 4) !== 'RTAB') {
        throw new Error(`RTAB bundle "${bundle.bundleId}" has invalid magic`);
    }
    const version = bytes.readUInt16LE(4);
    if (version !== FORMAT_VERSION) {
        throw new Error(`Unsupported RTAB version 0x${version.toString(16).padStart(4, '0')}. Supported version: 1.0 (0x0100).`);
    }
    if (bytes.readUInt16LE(6) !== HEADER_FLAGS) {
        throw new Error('Unsupported RTAB header flags');
    }
    if (!bytes.subarray(32, HEADER_SIZE).every((byte) => byte === 0)) {
        throw new Error('RTAB reserved header bytes must be zero');
    }

    const payloadOffsetBig = readUInt64(bytes, 8, 'Payload offset');
    const indexOffsetBig = readUInt64(bytes, 16, 'Index offset');
    const indexSizeBig = readUInt64(bytes, 24, 'Index size');
    if (indexOffsetBig !== BigInt(HEADER_SIZE)) {
        throw new Error('RTAB index offset must be exactly 64');
    }
    if (indexSizeBig < BigInt(INDEX_HEADER_SIZE + RECORD_SIZE + DIGEST_SIZE)) {
        throw new Error('RTAB index is too small to contain an asset record');
    }
    if (indexOffsetBig + indexSizeBig !== payloadOffsetBig) {
        throw new Error('RTAB payload offset must immediately follow the complete index');
    }
    if (payloadOffsetBig >= BigInt(bytes.length)) {
        throw new Error('RTAB payload section is empty or outside the file');
    }
    if (indexOffsetBig + indexSizeBig > BigInt(bytes.length)) {
        throw new Error('RTAB index range exceeds file size');
    }

    const indexOffset = ensureSafeNumber(indexOffsetBig, 'Index offset');
    const indexSize = ensureSafeNumber(indexSizeBig, 'Index size');
    const payloadOffset = ensureSafeNumber(payloadOffsetBig, 'Payload offset');
    const index = bytes.subarray(indexOffset, indexOffset + indexSize);
    if (index.toString('ascii', 0, 4) !== 'INDX') {
        throw new Error('RTAB index has invalid magic');
    }
    const entryCount = index.readUInt32LE(4);
    if (entryCount === 0) {
        throw new Error('RTAB bundle cannot contain zero assets');
    }
    if (index.readUInt16LE(8) !== RECORD_SIZE) {
        throw new Error(`Unsupported RTAB record size ${index.readUInt16LE(8)}; expected ${RECORD_SIZE}`);
    }
    if (index.readUInt16LE(10) !== 0) {
        throw new Error('Unsupported RTAB index flags');
    }

    const stringTableOffsetBig = readUInt64(index, 12, 'String-table offset');
    const stringTableSizeBig = readUInt64(index, 20, 'String-table size');
    const expectedStringOffset = BigInt(INDEX_HEADER_SIZE) + BigInt(entryCount) * BigInt(RECORD_SIZE);
    if (stringTableOffsetBig !== expectedStringOffset) {
        throw new Error('RTAB string table must immediately follow the record table');
    }
    ensureUint32(stringTableSizeBig, 'String-table size');
    const expectedIndexSize = expectedStringOffset + stringTableSizeBig + BigInt(DIGEST_SIZE);
    if (expectedIndexSize !== indexSizeBig) {
        throw new Error('RTAB index size does not match its header, records, string table, and digest');
    }

    const digestOffset = index.length - DIGEST_SIZE;
    assertDigest(
        sha256(index.subarray(0, digestOffset)),
        index.subarray(digestOffset),
        'RTAB index'
    );

    const stringTableOffset = ensureSafeNumber(stringTableOffsetBig, 'String-table offset');
    const stringTableSize = ensureSafeNumber(stringTableSizeBig, 'String-table size');
    const stringTable = index.subarray(stringTableOffset, stringTableOffset + stringTableSize);
    const payload = bytes.subarray(payloadOffset);
    const records = [];
    const ids = new Set();
    let expectedStringOffsetCursor = 0n;
    let expectedPayloadOffset = 0n;
    let previousId = null;
    let aggregatePngBytes = 0;
    let aggregatePngPixelBytes = 0;
    let aggregatePngScanlineBytes = 0;

    for (let recordIndex = 0; recordIndex < entryCount; recordIndex += 1) {
        const recordOffset = INDEX_HEADER_SIZE + recordIndex * RECORD_SIZE;
        const idOffset = BigInt(index.readUInt32LE(recordOffset));
        const idLength = BigInt(index.readUInt32LE(recordOffset + 4));
        const assetPayloadOffset = readUInt64(index, recordOffset + 8, 'Record payload offset');
        const storedSize = readUInt64(index, recordOffset + 16, 'Record stored size');
        const originalSize = readUInt64(index, recordOffset + 24, 'Record original size');
        const contentType = index.readUInt16LE(recordOffset + 32);
        const compressionMethod = index.readUInt16LE(recordOffset + 34);
        const entryFlags = index.readUInt32LE(recordOffset + 36);

        ensureUint32(idLength, 'Asset ID byte length');
        if (idOffset !== expectedStringOffsetCursor || idOffset + idLength > stringTableSizeBig) {
            throw new Error('RTAB asset ID string ranges must be contiguous and within the string table');
        }
        const contentTypeName = Object.entries(CONTENT_TYPE_CODES)
            .find(([, code]) => code === contentType)?.[0];
        if (!contentTypeName) {
            throw new Error(`Unsupported RTAB content type ${contentType}`);
        }
        if (compressionMethod !== 0) {
            throw new Error(`Unsupported compression method: ${compressionMethod}. Supported methods: 0=NONE`);
        }
        if (entryFlags !== 0) {
            throw new Error('RTAB record flags must be zero');
        }
        if (storedSize === 0n || storedSize !== originalSize || storedSize > UINT32_MAX) {
            throw new Error('RTAB payload size is invalid');
        }
        if (assetPayloadOffset !== expectedPayloadOffset) {
            throw new Error('RTAB payload records must be contiguous and ordered');
        }
        if (assetPayloadOffset + storedSize > BigInt(payload.length)) {
            throw new Error('RTAB payload range exceeds the payload section');
        }

        const idStart = ensureSafeNumber(idOffset, 'Asset ID offset');
        const idEnd = ensureSafeNumber(idOffset + idLength, 'Asset ID end');
        let assetId;
        try {
            assetId = new TextDecoder('utf-8', { fatal: true }).decode(stringTable.subarray(idStart, idEnd));
        } catch (error) {
            throw new Error(`RTAB asset ID is not valid UTF-8: ${error.message}`);
        }
        if (!assetId || ids.has(assetId)) {
            throw new Error(`RTAB contains an empty or duplicate asset ID "${assetId}"`);
        }
        if (previousId !== null && previousId >= assetId) {
            throw new Error('RTAB asset records must be sorted by asset ID');
        }
        ids.add(assetId);
        previousId = assetId;

        const payloadStart = ensureSafeNumber(assetPayloadOffset, 'Record payload offset');
        const payloadEnd = ensureSafeNumber(assetPayloadOffset + storedSize, 'Record payload end');
        const assetPayload = payload.subarray(payloadStart, payloadEnd);
        const expectedPayloadHash = index.subarray(recordOffset + 40, recordOffset + 72);
        assertDigest(sha256(assetPayload), expectedPayloadHash, `Payload for "${assetId}"`);
        const expectedAsset = expectedAssets.find((asset) => asset.assetId === assetId);
        if (!expectedAsset) {
            throw new Error(`RTAB asset "${assetId}" has no matching manifest metadata`);
        }
        if (expectedAsset.contentType !== contentTypeName) {
            throw new Error(`RTAB content type for "${assetId}" does not match manifest content type "${expectedAsset.contentType}"`);
        }
        let decodedPixelBytes = 0;
        let scanlineBytes = 0;
        if (contentTypeName === 'SVG') {
            decodeSvg(assetPayload, expectedAsset);
        } else {
            const pngMetrics = await validatePng(assetPayload, expectedAsset);
            decodedPixelBytes = pngMetrics.decodedPixelBytes;
            scanlineBytes = pngMetrics.scanlineBytes;
            aggregatePngBytes += assetPayload.length;
            aggregatePngPixelBytes += pngMetrics.decodedPixelBytes;
            aggregatePngScanlineBytes += pngMetrics.scanlineBytes;
            if (aggregatePngBytes > MAX_AGGREGATE_PNG_BYTES) {
                throw new Error(`RTAB bundle "${bundle.bundleId}" exceeds the aggregate PNG source size limit`);
            }
            assertPngAggregateDecodedLimits(
                aggregatePngPixelBytes,
                aggregatePngScanlineBytes,
                `RTAB bundle "${bundle.bundleId}"`
            );
        }
        records.push({
            assetId,
            bytes: assetPayload,
            contentType: contentTypeName,
            decodedPixelBytes,
            scanlineBytes
        });
        expectedStringOffsetCursor += idLength;
        expectedPayloadOffset += storedSize;
    }

    if (expectedStringOffsetCursor !== stringTableSizeBig) {
        throw new Error('RTAB string table contains unreferenced bytes');
    }
    if (expectedPayloadOffset !== BigInt(payload.length)) {
        throw new Error('RTAB payload section contains gaps or unindexed trailing bytes');
    }
    if (records.length !== expectedAssets.length
        || records.some((record, indexInRecords) => record.assetId !== expectedAssets[indexInRecords].assetId)) {
        throw new Error(`RTAB bundle "${bundle.bundleId}" asset IDs do not match its manifest`);
    }

    return records;
}

function assertOnlyKeys(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !expectedKeys.includes(key))) {
        throw new Error(`${label} contains unsupported properties`);
    }
}

function validateManifest(manifest, registry) {
    if (!manifest || manifest.manifestSchemaVersion !== '1.1'
        || !Array.isArray(manifest.assets) || !Array.isArray(manifest.bundles)) {
        throw new Error('RTAB asset manifest has an invalid shape or manifestSchemaVersion');
    }
    assertOnlyKeys(manifest, ['manifestSchemaVersion', 'assets', 'bundles'], 'RTAB asset manifest');

    const expectedBundleByAssetId = new Map();
    const expectedBundles = new Map();
    for (const asset of registry.assets) {
        const categoryName = asset.logicalPath.split('/')[1];
        const bundleId = normalizeCategoryName(categoryName);
        const bundleFile = `/assets/${bundleId}.bin`;
        expectedBundleByAssetId.set(asset.assetId, bundleId);
        expectedBundles.set(bundleId, {
            bundleId,
            bundleFile,
            assets: [...(expectedBundles.get(bundleId)?.assets ?? []), asset]
        });
    }
    if (manifest.assets.length !== registry.assets.length) {
        throw new Error('RTAB asset manifest does not contain exactly the registered assets');
    }

    const manifestAssetsById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
    if (manifestAssetsById.size !== manifest.assets.length) {
        throw new Error('RTAB asset manifest contains duplicate asset IDs');
    }
    for (const expected of registry.assets) {
        const actual = manifestAssetsById.get(expected.assetId);
        assertOnlyKeys(
            actual,
            ['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'],
            `RTAB manifest asset "${expected.assetId}"`
        );
        if (!actual || actual.logicalPath !== expected.logicalPath
            || actual.textureKey !== expected.textureKey
            || actual.contentType !== expected.contentType
            || actual.bundleId !== expectedBundleByAssetId.get(expected.assetId)
            || JSON.stringify(actual.aliases) !== JSON.stringify(expected.aliases)) {
            throw new Error(`RTAB manifest metadata does not match registry asset "${expected.assetId}"`);
        }
        assertHexDigest(actual.sourceSha256, `source for "${expected.assetId}"`);
    }

    if (manifest.bundles.length !== expectedBundles.size) {
        throw new Error('RTAB manifest does not contain exactly the non-empty source categories');
    }
    const manifestBundlesById = new Map(manifest.bundles.map((bundle) => [bundle.bundleId, bundle]));
    if (manifestBundlesById.size !== manifest.bundles.length) {
        throw new Error('RTAB asset manifest contains duplicate bundle IDs');
    }
    for (const [bundleId, expected] of expectedBundles) {
        const actual = manifest.bundles.find((bundle) => bundle.bundleId === bundleId);
        assertOnlyKeys(
            actual,
            ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'],
            `RTAB manifest bundle "${bundleId}"`
        );
        if (!actual || actual.bundleFile !== expected.bundleFile
            || actual.formatVersion !== '1.0'
            || actual.assetCount !== expected.assets.length) {
            throw new Error(`RTAB manifest bundle metadata does not match derived category "${bundleId}"`);
        }
        assertHexDigest(actual.bundleSha256, `bundle "${bundleId}"`);
    }
}

export async function validateCommittedAssetOutputs({ projectRoot = PROJECT_ROOT } = {}) {
    const registry = await readAssetRegistry(projectRoot);
    const assetsRoot = path.join(projectRoot, 'public', 'assets');
    let manifest;
    let schema;
    try {
        [manifest, schema] = await Promise.all([
            readCommittedOutput(path.join(assetsRoot, 'asset-manifest.json'), 'RTAB manifest', 'utf8').then(JSON.parse),
            readCommittedOutput(path.join(assetsRoot, 'asset-manifest-schema.json'), 'RTAB schema', 'utf8').then(JSON.parse)
        ]);
    } catch (error) {
        throw new Error(`Could not read committed RTAB manifest/schema: ${error.message}`);
    }
    validateManifest(manifest, registry);
    if (JSON.stringify(schema) !== JSON.stringify(buildManifestSchema())) {
        throw new Error('RTAB asset manifest schema does not match the 1.1 manifest schema');
    }

    const validatedBundles = [];
    let aggregatePngBytes = 0;
    let aggregatePngPixelBytes = 0;
    let aggregatePngScanlineBytes = 0;
    for (const bundle of manifest.bundles) {
        const bundlePath = safeBundlePath(projectRoot, bundle.bundleFile);
        let bytes;
        try {
            bytes = await readCommittedOutput(bundlePath, `RTAB bundle "${bundle.bundleId}"`);
        } catch (error) {
            throw new Error(`Required RTAB bundle "${bundle.bundleId}" is unavailable at ${bundle.bundleFile}: ${error.message}`);
        }
        assertDigest(sha256(bytes), Buffer.from(bundle.bundleSha256, 'hex'), `Bundle "${bundle.bundleId}"`);
        const expectedAssets = manifest.assets
            .filter((asset) => asset.bundleId === bundle.bundleId)
            .map((asset) => ({
                assetId: asset.assetId,
                contentType: asset.contentType,
                logicalPath: asset.logicalPath
            }))
            .sort((left, right) => (
                left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
            ));
        const records = await validateRtabBundle(bytes, bundle, expectedAssets);
        for (const record of records) {
            if (record.contentType === 'PNG') {
                aggregatePngBytes += record.bytes.length;
                aggregatePngPixelBytes += record.decodedPixelBytes;
                aggregatePngScanlineBytes += record.scanlineBytes;
            }
        }
        if (aggregatePngBytes > MAX_AGGREGATE_PNG_BYTES) {
            throw new Error(`Committed RTAB outputs exceed the aggregate PNG source size limit`);
        }
        assertPngAggregateDecodedLimits(
            aggregatePngPixelBytes,
            aggregatePngScanlineBytes,
            'Committed RTAB outputs'
        );
        validatedBundles.push(bundle.bundleId);
    }
    return { manifest, validatedBundles };
}

export function getManifestSchema() {
    return buildManifestSchema();
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    import('./prepare-assets.mjs')
        .then(({ prepareAssets }) => prepareAssets())
        .catch((error) => {
            console.error(`Failed to prepare RTAB assets: ${error.message}`);
            process.exitCode = 1;
        });
}

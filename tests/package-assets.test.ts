import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { cp, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publicSvgTextures } from '../src/generated/publicSvgManifest';
import {
    readAssetRegistry,
    resolveAssetSource,
    validateAssetRegistry
} from '../scripts/asset-registry.mjs';
import {
    createAssetPackageOutputs,
    getManifestSchema,
    validateCommittedAssetOutputs,
    validateRtabBundle
} from '../scripts/package-assets.mjs';
import { assertPngAggregateLimits, PNG_LIMITS, validatePng } from '../scripts/validate-png.mjs';
import { prepareAssets } from '../scripts/prepare-assets.mjs';
import { approvePlanetAssets } from '../scripts/approve-planet-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
const PLANET_ASSETS = [
    {
        assetId: 'rt.planet-map.map-111',
        fileName: 'Map-111.png',
        logicalPath: 'assets/Planets/Map-111.png',
        textureKey: 'planetMap111',
        sourceSha256: '83d39b7a7603f574f47cee57c4d9b12b0b468b469fece0ffe7765d921f067ea1'
    },
    {
        assetId: 'rt.planet-map.map-122',
        fileName: 'Map-122.png',
        logicalPath: 'assets/Planets/Map-122.png',
        textureKey: 'planetMap122',
        sourceSha256: '35f8af626f4d7162a2926ef3dad6cdec36610cfd6f3acac86a1547d764081f7e'
    },
    {
        assetId: 'rt.planet-map.map-692',
        fileName: 'Map-692.png',
        logicalPath: 'assets/Planets/Map-692.png',
        textureKey: 'planetMap692',
        sourceSha256: '43652c4465b35a1e3ae4bf99bbb75308359179c9d1b3fd8711d38c806b1472a8'
    }
];
const HISTORICAL_SCHEMA_1_2_BUNDLE_HASHES: Record<string, string> = {
    components: 'c765204592f66b0431a41b7c20a3f4ff58559757883aa39f0a81ad864a1928df',
    planets: '6d1b1206f74f207f7d8af01ab3a9d0b768d0f9021fe456753f894bb04a411814',
    ships: '5a88e030dfbd0cecc8d2b51acf7e80dce2bdb36862838ba0ea113d84707fd65b',
    'turrets-platforms': '943e47cfed1ff6e28bc4bca70efe0f42c9d1403b8e2a17c24643f8a61c9e126e'
};

type RegistryAsset = {
    assetId: string;
    logicalPath: string;
    textureKey: string;
    aliases: string[];
    contentType: 'SVG' | 'PNG';
};

type Registry = {
    registrySchemaVersion: string;
    assets: RegistryAsset[];
};

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

function pngChunk(type: string, data: Buffer) {
    const typeBytes = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBytes.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    return chunk;
}

function addPngTextChunk(bytes: Buffer) {
    const chunks: Buffer[] = [];
    let offset = 8;
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const end = offset + length + 12;
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        if (type === 'IEND') {
            chunks.push(pngChunk('tEXt', Buffer.from('Comment\0changed')));
        }
        chunks.push(bytes.subarray(offset, end));
        offset = end;
    }
    return Buffer.concat([bytes.subarray(0, 8), ...chunks]);
}

function rebuildBundleWithPayload(bundle: Buffer, assetId: string, replacement: Buffer) {
    const headerSize = 64;
    const indexHeaderSize = 28;
    const recordSize = 72;
    const digestSize = 32;
    const indexOffset = Number(bundle.readBigUInt64LE(16));
    const indexSize = Number(bundle.readBigUInt64LE(24));
    const payloadOffset = Number(bundle.readBigUInt64LE(8));
    const index = bundle.subarray(indexOffset, indexOffset + indexSize);
    const entryCount = index.readUInt32LE(4);
    const stringTableOffset = Number(index.readBigUInt64LE(12));
    const stringTableSize = Number(index.readBigUInt64LE(20));
    const stringTable = index.subarray(stringTableOffset, stringTableOffset + stringTableSize);
    const entries = [];
    for (let i = 0; i < entryCount; i += 1) {
        const recordOffset = indexHeaderSize + i * recordSize;
        const idOffset = index.readUInt32LE(recordOffset);
        const idLength = index.readUInt32LE(recordOffset + 4);
        const id = stringTable.subarray(idOffset, idOffset + idLength).toString('utf8');
        const relativeOffset = Number(index.readBigUInt64LE(recordOffset + 8));
        const size = Number(index.readBigUInt64LE(recordOffset + 16));
        entries.push({
            id,
            contentType: index.readUInt16LE(recordOffset + 32),
            compressionMethod: index.readUInt16LE(recordOffset + 34),
            flags: index.readUInt32LE(recordOffset + 36),
            bytes: id === assetId
                ? replacement
                : bundle.subarray(payloadOffset + relativeOffset, payloadOffset + relativeOffset + size)
        });
    }

    const ids = entries.map((entry) => Buffer.from(entry.id, 'utf8'));
    const nextStringOffset = indexHeaderSize + entries.length * recordSize;
    const nextStringSize = ids.reduce((size, id) => size + id.length, 0);
    const nextIndexSize = nextStringOffset + nextStringSize + digestSize;
    const nextPayloadOffset = headerSize + nextIndexSize;
    const nextPayloadSize = entries.reduce((size, entry) => size + entry.bytes.length, 0);
    const nextIndex = Buffer.alloc(nextIndexSize);
    nextIndex.write('INDX', 0, 'ascii');
    nextIndex.writeUInt32LE(entries.length, 4);
    nextIndex.writeUInt16LE(recordSize, 8);
    nextIndex.writeBigUInt64LE(BigInt(nextStringOffset), 12);
    nextIndex.writeBigUInt64LE(BigInt(nextStringSize), 20);
    let stringCursor = nextStringOffset;
    let stringRecordOffset = 0;
    let payloadCursor = 0;
    entries.forEach((entry, i) => {
        const recordOffset = indexHeaderSize + i * recordSize;
        const id = ids[i];
        nextIndex.writeUInt32LE(stringRecordOffset, recordOffset);
        nextIndex.writeUInt32LE(id.length, recordOffset + 4);
        nextIndex.writeBigUInt64LE(BigInt(payloadCursor), recordOffset + 8);
        nextIndex.writeBigUInt64LE(BigInt(entry.bytes.length), recordOffset + 16);
        nextIndex.writeBigUInt64LE(BigInt(entry.bytes.length), recordOffset + 24);
        nextIndex.writeUInt16LE(entry.contentType, recordOffset + 32);
        nextIndex.writeUInt16LE(entry.compressionMethod, recordOffset + 34);
        nextIndex.writeUInt32LE(entry.flags, recordOffset + 36);
        createHash('sha256').update(entry.bytes).digest().copy(nextIndex, recordOffset + 40);
        id.copy(nextIndex, stringCursor);
        stringCursor += id.length;
        stringRecordOffset += id.length;
        payloadCursor += entry.bytes.length;
    });
    createHash('sha256').update(nextIndex.subarray(0, nextIndex.length - digestSize)).digest()
        .copy(nextIndex, nextIndex.length - digestSize);
    const output = Buffer.alloc(nextPayloadOffset + nextPayloadSize);
    bundle.copy(output, 0, 0, headerSize);
    output.writeBigUInt64LE(BigInt(nextPayloadOffset), 8);
    output.writeBigUInt64LE(BigInt(headerSize), 16);
    output.writeBigUInt64LE(BigInt(nextIndexSize), 24);
    nextIndex.copy(output, headerSize);
    let cursor = nextPayloadOffset;
    for (const entry of entries) {
        entry.bytes.copy(output, cursor);
        cursor += entry.bytes.length;
    }
    return output;
}

function createPng({
    width = 1,
    height = 1,
    bitDepth = 8,
    colorType = 6,
    interlace = 0,
    filter = 0
}: {
    width?: number;
    height?: number;
    bitDepth?: number;
    colorType?: number;
    interlace?: number;
    filter?: number;
} = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = bitDepth;
    header[9] = colorType;
    header[10] = 0;
    header[11] = 0;
    header[12] = interlace;
    const scanlines = Buffer.alloc((width * 4 + 1) * height);
    for (let row = 0; row < height; row += 1) {
        scanlines[row * (width * 4 + 1)] = filter;
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(scanlines)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function hash(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

function changeFirstRecordContentType(bytes: Buffer, code: number) {
    const indexSize = Number(bytes.readBigUInt64LE(24));
    const index = bytes.subarray(64, 64 + indexSize);
    index.writeUInt16LE(code, 28 + 32);
    const digestOffset = index.length - 32;
    createHash('sha256').update(index.subarray(0, digestOffset)).digest().copy(index, digestOffset);
}

async function createProjectFixture(run: (projectRoot: string, registry: Registry) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'rtab-assets-'));
    const registry = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'), 'utf8')) as Registry;
    const registryPath = path.join(projectRoot, 'scripts', 'asset-registry.json');
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await writeFile(
        path.join(projectRoot, 'scripts', 'planet-asset-approvals.json'),
        `${JSON.stringify({
            approvalSchemaVersion: '1',
            approvals: Object.fromEntries(PLANET_ASSETS.map((asset) => [asset.logicalPath, asset.sourceSha256]))
        }, null, 2)}\n`
    );
    await mkdir(path.join(projectRoot, 'src', 'generated'), { recursive: true });
    await mkdir(path.join(projectRoot, 'src', 'assets'), { recursive: true });
    await writeFile(
        path.join(projectRoot, 'src', 'assets', 'planet-runtime-references.json'),
        await readFile(path.join(REPOSITORY_ROOT, 'src', 'assets', 'planet-runtime-references.json'))
    );

    const publicAssetsRoot = path.join(projectRoot, 'public', 'assets');
    await mkdir(publicAssetsRoot, { recursive: true });
    for (const asset of registry.assets) {
        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        await mkdir(path.dirname(sourcePath), { recursive: true });
        const source = await readFile(resolveAssetSource(asset.logicalPath, REPOSITORY_ROOT));
        await writeFile(sourcePath, source);

        if (asset.logicalPath.startsWith('assets/Ships/')) {
            const stalePublicCopy = path.join(projectRoot, 'public', ...asset.logicalPath.split('/'));
            await mkdir(path.dirname(stalePublicCopy), { recursive: true });
            await writeFile(stalePublicCopy, '<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>');
        }
    }
    const privatePlanetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
    const publicPlanetRoot = path.join(projectRoot, 'public', 'assets', 'Planets');
    await mkdir(privatePlanetRoot, { recursive: true });
    await mkdir(publicPlanetRoot, { recursive: true });
    for (const asset of PLANET_ASSETS) {
        const source = await readFile(resolveAssetSource(asset.logicalPath, REPOSITORY_ROOT));
        await writeFile(path.join(privatePlanetRoot, asset.fileName), source);
        await writeFile(path.join(publicPlanetRoot, asset.fileName), source);
    }

    // Build the fixed-path schema-1.2 predecessor fixture from canonical inputs.
    // This keeps the immutable historical test meaningful after old bundle files are pruned.
    const generated = await createAssetPackageOutputs({ projectRoot });
    assert.equal(generated.manifest.assets.length, 34);
    const fixedManifest = {
        manifestSchemaVersion: '1.2',
        assets: generated.manifest.assets,
        bundles: generated.manifest.bundles.map((bundle: any) => {
            assert.equal(bundle.bundleSha256, HISTORICAL_SCHEMA_1_2_BUNDLE_HASHES[bundle.bundleId]);
            return { ...bundle, bundleFile: `/assets/${bundle.bundleId}.bin` };
        })
    };
    for (const bundle of generated.manifest.bundles) {
        const addressedPath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
        const bytes = generated.outputFiles.get(addressedPath);
        assert.ok(bytes, `Missing generated historical fixture bytes for ${bundle.bundleId}.`);
        await writeFile(path.join(publicAssetsRoot, `${bundle.bundleId}.bin`), bytes);
    }
    await writeFile(path.join(publicAssetsRoot, 'asset-manifest.json'), `${JSON.stringify(fixedManifest, null, 2)}\n`);
    await writeFile(
        path.join(publicAssetsRoot, 'asset-manifest-schema.json'),
        generated.outputFiles.get(path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json')) as string
    );

    try {
        await run(projectRoot, registry);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

async function snapshotOutputs(projectRoot: string) {
    const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
    const currentManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const paths = [
        path.join(projectRoot, 'public', 'assets', 'ships.bin'),
        path.join(projectRoot, 'public', 'assets', 'components.bin'),
        path.join(projectRoot, 'public', 'assets', 'turrets-platforms.bin'),
        path.join(projectRoot, 'public', 'assets', 'planets.bin'),
        manifestPath,
        path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json'),
        path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts'),
        path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts'),
        ...currentManifest.bundles.map((bundle: any) => path.join(projectRoot, 'public', bundle.bundleFile.slice(1)))
    ];
    const snapshots = new Map<string, Buffer>();
    for (const filePath of paths) {
        try {
            snapshots.set(filePath, await readFile(filePath));
        } catch (error: any) {
            if (error.code !== 'ENOENT' || (!filePath.endsWith('planets.bin') && !filePath.includes('.bin'))) {
                throw error;
            }
        }
    }
    return snapshots;
}

async function assertSnapshotUnchanged(snapshots: Map<string, Buffer>) {
    await Promise.all([...snapshots].map(async ([filePath, expected]) => {
        assert.deepEqual(await readFile(filePath), expected, `Unexpected output change: ${filePath}`);
    }));
}

function manifestExpectedAssets(manifest: any, bundleId: string) {
    return manifest.assets
        .filter((asset: any) => asset.bundleId === bundleId)
        .map((asset: any) => ({
            assetId: asset.assetId,
            contentType: asset.contentType,
            logicalPath: asset.logicalPath
        }))
        .sort((left: any, right: any) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
}

async function createHistoricalPlanetBundle(projectRoot: string) {
    const assets = await Promise.all(PLANET_ASSETS.map(async (asset) => {
        const bytes = await readFile(path.join(projectRoot, 'private', ...asset.logicalPath.split('/')));
        assert.equal(hash(bytes), asset.sourceSha256);
        return { ...asset, bytes };
    }));
    assets.sort((left, right) => left.assetId.localeCompare(right.assetId));

    const headerSize = 64;
    const indexHeaderSize = 28;
    const recordSize = 72;
    const digestSize = 32;
    const idBytes = assets.map((asset) => Buffer.from(asset.assetId, 'utf8'));
    const stringTableSize = idBytes.reduce((size, id) => size + id.length, 0);
    const stringTableOffset = indexHeaderSize + assets.length * recordSize;
    const indexSize = stringTableOffset + stringTableSize + digestSize;
    const payloadOffset = headerSize + indexSize;
    const payloadSize = assets.reduce((size, asset) => size + asset.bytes.length, 0);
    const index = Buffer.alloc(indexSize);
    index.write('INDX', 0, 'ascii');
    index.writeUInt32LE(assets.length, 4);
    index.writeUInt16LE(recordSize, 8);
    index.writeUInt16LE(0, 10);
    index.writeBigUInt64LE(BigInt(stringTableOffset), 12);
    index.writeBigUInt64LE(BigInt(stringTableSize), 20);

    let stringCursor = stringTableOffset;
    let payloadCursor = 0;
    let stringOffset = 0;
    assets.forEach((asset, indexInAssets) => {
        const recordOffset = indexHeaderSize + indexInAssets * recordSize;
        const id = idBytes[indexInAssets];
        index.writeUInt32LE(stringOffset, recordOffset);
        index.writeUInt32LE(id.length, recordOffset + 4);
        index.writeBigUInt64LE(BigInt(payloadCursor), recordOffset + 8);
        index.writeBigUInt64LE(BigInt(asset.bytes.length), recordOffset + 16);
        index.writeBigUInt64LE(BigInt(asset.bytes.length), recordOffset + 24);
        index.writeUInt16LE(1, recordOffset + 32);
        index.writeUInt16LE(0, recordOffset + 34);
        index.writeUInt32LE(0, recordOffset + 36);
        createHash('sha256').update(asset.bytes).digest().copy(index, recordOffset + 40);
        id.copy(index, stringCursor);
        stringCursor += id.length;
        stringOffset += id.length;
        payloadCursor += asset.bytes.length;
    });
    createHash('sha256').update(index.subarray(0, index.length - digestSize)).digest()
        .copy(index, index.length - digestSize);

    const bundle = Buffer.alloc(payloadOffset + payloadSize);
    bundle.write('RTAB', 0, 'ascii');
    bundle.writeUInt16LE(0x0100, 4);
    bundle.writeUInt16LE(0x0003, 6);
    bundle.writeBigUInt64LE(BigInt(payloadOffset), 8);
    bundle.writeBigUInt64LE(BigInt(headerSize), 16);
    bundle.writeBigUInt64LE(BigInt(indexSize), 24);
    index.copy(bundle, headerSize);
    payloadCursor = payloadOffset;
    for (const asset of assets) {
        asset.bytes.copy(bundle, payloadCursor);
        payloadCursor += asset.bytes.length;
    }
    return bundle;
}

async function addPreviouslyOwnedPlanetBundle(projectRoot: string) {
    const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
    const bundlePath = path.join(projectRoot, 'public', 'assets', 'planets.bin');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const bytes = await createHistoricalPlanetBundle(projectRoot);
    assert.equal(hash(bytes), 'ef64dfb9a6491965d5b3870918f317f9a5632fb32eeb5c4be812b1f1829dc120');
    manifest.manifestSchemaVersion = '1.1';
    delete manifest.generationId;
    delete manifest.activePlanetPlacements;
    for (const bundle of manifest.bundles) bundle.bundleFile = `/assets/${bundle.bundleId}.bin`;
    const planetBundle = manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets');
    planetBundle.formatVersion = '1.0';
    planetBundle.bundleSha256 = hash(bytes);
    await writeFile(bundlePath, bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return bytes;
}

test('registry contains the 31 static SVGs while planets are derived from approved sources', async () => {
    const registry = await readAssetRegistry(REPOSITORY_ROOT);
    const runtimeByUrl = new Map(publicSvgTextures.map((asset) => [decodeURIComponent(asset.url.slice('/assets/'.length)), asset]));

    assert.equal(registry.registrySchemaVersion, '1.2');
    assert.equal(registry.assets.length, 31);
    assert.equal(registry.assets.filter((asset) => asset.contentType === 'SVG' && asset.logicalPath.endsWith('.svg')).length, 31);
    assert.equal(registry.assets.filter((asset) => asset.contentType === 'PNG').length, 0);
    assert.equal('bundles' in registry, false);
    assert.equal(registry.assets.some((asset) => 'bundleId' in asset), false);
    assert.equal(publicSvgTextures.length, 31);

    for (const asset of registry.assets.filter((entry) => entry.contentType === 'SVG')) {
        const runtimeAsset = runtimeByUrl.get(asset.logicalPath.slice('assets/'.length));
        assert.ok(runtimeAsset, `Missing runtime manifest path ${asset.logicalPath}`);
        assert.equal(runtimeAsset.key, asset.textureKey);
        assert.deepEqual(runtimeAsset.aliases, asset.aliases);
    }
    assert.deepEqual(
        registry.assets.filter((asset) => asset.aliases.length > 0).map((asset) => [asset.logicalPath, asset.aliases]),
        [
            ['assets/Components/Aistiaria/01_side_hull_angular.svg', ['central-hull']],
            ['assets/Ships/alien-interceptor.svg', ['alien-interceptor']],
            ['assets/Ships/human-dreadnought.svg', ['human-dreadnought']]
        ]
    );
});

test('registry rejects duplicate IDs, duplicate texture keys, alias conflicts, unsupported types, and old schema fields', async () => {
    const registry = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'), 'utf8'));
    const duplicateId = structuredClone(registry);
    duplicateId.assets[1].assetId = duplicateId.assets[0].assetId;
    assert.throws(() => validateAssetRegistry(duplicateId), /duplicate asset ID/);

    const duplicateKey = structuredClone(registry);
    duplicateKey.assets[1].textureKey = duplicateKey.assets[0].textureKey;
    assert.throws(() => validateAssetRegistry(duplicateKey), /duplicate texture key/);

    const duplicateAlias = structuredClone(registry);
    duplicateAlias.assets[1].aliases.push('central-hull');
    assert.throws(() => validateAssetRegistry(duplicateAlias), /conflicting alias/);

    const unsupportedType = structuredClone(registry);
    unsupportedType.assets[0].contentType = 'JSON';
    assert.throws(() => validateAssetRegistry(unsupportedType), /unsupported content type/);

    const pngType = structuredClone(registry);
    pngType.assets[0].contentType = 'PNG';
    assert.throws(() => validateAssetRegistry(pngType), /invalid logicalPath/);

    const pngPath = structuredClone(registry);
    pngPath.assets[0].logicalPath = 'assets/Ships/not-an-svg.png';
    assert.throws(() => validateAssetRegistry(pngPath), /invalid logicalPath/);

    const oldSchema = structuredClone(registry);
    oldSchema.registrySchemaVersion = '1.1';
    assert.throws(() => validateAssetRegistry(oldSchema), /registrySchemaVersion must be "1.2"/);

    const oldBundleFields = structuredClone(registry);
    oldBundleFields.assets[0].bundleId = 'ships1';
    assert.throws(() => validateAssetRegistry(oldBundleFields), /only asset identity and runtime metadata/);
});

test('folder-derived packaging emits three SVG RTAB 1.0 bundles and a planet PNG RTAB 1.1 bundle', async () => {
    await createProjectFixture(async (projectRoot) => {
        const first = await createAssetPackageOutputs({ projectRoot });
        const second = await createAssetPackageOutputs({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const schemaPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json');
        const manifest = JSON.parse(first.outputFiles.get(manifestPath) as string);
        const schema = JSON.parse(first.outputFiles.get(schemaPath) as string);
        const bundleCounts = new Map(manifest.bundles.map((bundle: any) => [bundle.bundleId, bundle.assetCount]));

        assert.deepEqual([...bundleCounts.entries()].sort(), [
            ['components', 19],
            ['planets', 3],
            ['ships', 10],
            ['turrets-platforms', 2]
        ]);
        assert.equal(manifest.manifestSchemaVersion, '1.3');
        assert.equal(manifest.assets.length, 34);
        assert.equal(manifest.bundles.length, 4);
        assert.equal(schema.properties.manifestSchemaVersion.const, '1.3');
        assert.match(manifest.generationId, /^[a-f0-9]{64}$/);
        assert.deepEqual(schema.properties.assets.items.properties.contentType.enum, ['SVG', 'PNG']);
        assert.ok(manifest.bundles.every((bundle: any) => (
            bundle.bundleFile === `/assets/bundles/${bundle.bundleId}.${bundle.bundleSha256}.bin`
        )));
        assert.equal(manifest.assets.filter((asset: any) => asset.contentType === 'SVG').length, 31);
        assert.equal(manifest.assets.filter((asset: any) => asset.contentType === 'PNG').length, 3);
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets').formatVersion, '1.1');

        for (const bundle of manifest.bundles) {
            const outputPath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
            const bytes = first.outputFiles.get(outputPath) as Buffer;
            const decoded = await validateRtabBundle(bytes, bundle, manifestExpectedAssets(manifest, bundle.bundleId));
            assert.equal(bytes.readUInt16LE(4), bundle.formatVersion === '1.0' ? 0x0100 : 0x0101);
            assert.equal(hash(bytes), bundle.bundleSha256);
            assert.equal(decoded.length, bundle.assetCount);
            assert.ok(decoded.every((asset: any) => (
                bundle.bundleId === 'planets' ? asset.contentType === 'PNG' : asset.contentType === 'SVG'
            )));
            assert.deepEqual(bytes, second.outputFiles.get(outputPath));
        }
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'ships').bundleSha256, '5a88e030dfbd0cecc8d2b51acf7e80dce2bdb36862838ba0ea113d84707fd65b');
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'components').bundleSha256, 'c765204592f66b0431a41b7c20a3f4ff58559757883aa39f0a81ad864a1928df');
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'turrets-platforms').bundleSha256, '943e47cfed1ff6e28bc4bca70efe0f42c9d1403b8e2a17c24643f8a61c9e126e');
    });
});

test('real planet PNGs match the approved fingerprints and bounded RGBA8 non-interlaced profile', async () => {
    let aggregateFileBytes = 0;
    let aggregateDecodedPixelBytes = 0;
    let aggregateInflatedScanlineBytes = 0;
    for (const asset of PLANET_ASSETS) {
        const bytes = await readFile(resolveAssetSource(asset.logicalPath, REPOSITORY_ROOT));
        assert.equal(hash(bytes), asset.sourceSha256, `Public fingerprint differs: ${asset.logicalPath}`);
        const result = await validatePng(bytes, asset);
        assert.equal(result.width, 2000);
        assert.equal(result.height, 1000);
        assert.equal(result.decodedPixelBytes, 8_000_000);
        assert.equal(result.scanlineBytes, 8_001_000);
        aggregateFileBytes += result.fileBytes;
        aggregateDecodedPixelBytes += result.decodedPixelBytes;
        aggregateInflatedScanlineBytes += result.scanlineBytes;
    }
    assert.ok(aggregateFileBytes <= PNG_LIMITS.maxAggregateFileBytes);
    assert.ok(aggregateDecodedPixelBytes <= PNG_LIMITS.maxAggregateDecodedPixelBytes);
    assert.ok(aggregateInflatedScanlineBytes <= PNG_LIMITS.maxAggregateScanlineBytes);
});

test('RTAB packages and preserves exactly the three approved private planet PNGs', async () => {
    await createProjectFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
        const original = new Map<string, Buffer>();
        for (const asset of PLANET_ASSETS) {
            const filePath = path.join(planetRoot, asset.fileName);
            original.set(asset.fileName, await readFile(filePath));
        }

        const { manifest, outputFiles } = await createAssetPackageOutputs({ projectRoot });
        assert.equal(manifest.assets.length, 34);
        assert.equal(manifest.assets.filter((asset: any) => asset.logicalPath.startsWith('assets/Planets/')).length, 3);
        const planetBundle = manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets');
        const planetBytes = outputFiles.get(path.join(projectRoot, 'public', planetBundle.bundleFile.slice(1))) as Buffer;
        const decoded = await validateRtabBundle(planetBytes, planetBundle, manifestExpectedAssets(manifest, 'planets'));
        assert.deepEqual(decoded.map((asset: any) => asset.assetId).sort(), PLANET_ASSETS.map((asset) => asset.assetId).sort());
        for (const [fileName, bytes] of original) {
            assert.deepEqual(await readFile(path.join(planetRoot, fileName)), bytes);
            assert.deepEqual(
                await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', fileName)),
                bytes
            );
        }
    });
});

test('missing private planet source fails explicitly', async () => {
    await createProjectFixture(async (projectRoot) => {
        await rm(path.join(projectRoot, 'private', 'assets', 'Planets', 'Map-111.png'));
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /stale|could not find canonical source/);
    });
});

test('modified private planet sources fail and public copies are never packaging fallbacks', async () => {
    await createProjectFixture(async (projectRoot) => {
        const privatePath = path.join(projectRoot, 'private', 'assets', 'Planets', 'Map-111.png');
        const original = await readFile(privatePath);
        const corrupted = Buffer.from(original);
        corrupted[corrupted.length - 1] ^= 0xff;
        await writeFile(privatePath, corrupted);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /approved fingerprint/);
        assert.deepEqual(await readFile(privatePath), corrupted);
        assert.deepEqual(
            await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-111.png')),
            original
        );
    });

    await createProjectFixture(async (projectRoot) => {
        await rm(path.join(projectRoot, 'public', 'assets', 'Planets'), { recursive: true });
        const { manifest, outputFiles } = await createAssetPackageOutputs({ projectRoot });
        assert.equal(manifest.assets.length, 34);
        assert.ok(outputFiles.has(path.join(projectRoot, 'public', manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets').bundleFile.slice(1))));
    });
});

test('newly discovered planets require explicit approval and register without changing active placements', async () => {
    await createProjectFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
        await writeFile(
            path.join(planetRoot, 'Map-314.png'),
            await readFile(path.join(planetRoot, 'Map-111.png'))
        );
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /no approved fingerprint/);
        await approvePlanetAssets({ projectRoot, apply: true });
        const result = await createAssetPackageOutputs({ projectRoot });
        assert.equal(result.manifest.assets.length, 35);
        assert.ok(result.manifest.assets.some((asset: any) => (
            asset.assetId === 'rt.planet-map.map-314' && asset.textureKey === 'planetMap314'
        )));
        assert.deepEqual(result.runtimeContract.activePlanetPlacements.map((entry: any) => entry.textureKey), [
            'planetMap692', 'planetMap122', 'planetMap111'
        ]);
    });
});

test('properly named planets and numeric-suffixed variants are approved and packaged dynamically', async () => {
    await createProjectFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
        await writeFile(
            path.join(planetRoot, 'Hushanyia.png'),
            await readFile(path.join(planetRoot, 'Map-111.png'))
        );
        await writeFile(
            path.join(planetRoot, 'Kansansas.png'),
            await readFile(path.join(planetRoot, 'Map-692.png'))
        );
        await writeFile(
            path.join(planetRoot, 'Map-111-2.png'),
            await readFile(path.join(planetRoot, 'Map-122.png'))
        );

        const preview = await approvePlanetAssets({ projectRoot });
        assert.deepEqual(preview.changes.map((entry) => entry.logicalPath).sort(), [
            'assets/Planets/Hushanyia.png',
            'assets/Planets/Kansansas.png',
            'assets/Planets/Map-111-2.png'
        ]);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /no approved fingerprint/);

        await approvePlanetAssets({ projectRoot, apply: true });
        const { manifest, outputFiles } = await createAssetPackageOutputs({ projectRoot });
        assert.equal(manifest.assets.length, 37);
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Hushanyia.png')?.assetId,
            'rt.planet-map.hushanyia');
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Hushanyia.png')?.textureKey,
            'planetMapHushanyia');
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Kansansas.png')?.assetId,
            'rt.planet-map.kansansas');
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Kansansas.png')?.textureKey,
            'planetMapKansansas');
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Map-111-2.png')?.assetId,
            'rt.planet-map.map-111-2');
        assert.equal(manifest.assets.find((asset: any) => asset.logicalPath === 'assets/Planets/Map-111-2.png')?.textureKey,
            'planetMapMap1112');
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets')?.assetCount, 6);
        assert.deepEqual(manifest.activePlanetPlacements.map((entry: any) => entry.textureKey), [
            'planetMap692', 'planetMap122', 'planetMap111'
        ]);
        assert.ok([...outputFiles.keys()].some((filePath) => filePath.endsWith('runtimeAssetContract.ts')));
    });
});

test('planet approval rejects names that normalize to duplicate runtime identities', async () => {
    await createProjectFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
        const bytes = await readFile(path.join(planetRoot, 'Map-111.png'));
        await writeFile(path.join(planetRoot, 'Hushanyia-Nova.png'), bytes);
        await writeFile(path.join(planetRoot, 'Hushanyia_Nova.png'), bytes);
        await assert.rejects(
            approvePlanetAssets({ projectRoot }),
            /same asset ID|same texture key/
        );
    });
});

test('removing a planet requires explicit approval pruning and active placements still block publication', async () => {
    await createProjectFixture(async (projectRoot) => {
        await rm(path.join(projectRoot, 'private', 'assets', 'Planets', 'Map-111.png'));
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /stale/);
        await approvePlanetAssets({ projectRoot, apply: true, prune: true });
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /references missing texture "planetMap111"/);
    });
});

test('an absent private Planets directory fails even when public planet PNGs exist', async () => {
    await createProjectFixture(async (projectRoot) => {
        await rm(path.join(projectRoot, 'private', 'assets', 'Planets'), { recursive: true });
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /stale|could not find canonical source/);
    });
});

test('Planets directory rejects every unexpected file and nested directory', async () => {
    await createProjectFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
        const unexpectedFile = path.join(planetRoot, 'extra.png');
        await writeFile(unexpectedFile, createPng());
        await assert.rejects(
            createAssetPackageOutputs({ projectRoot }),
            /no approved fingerprint/
        );
        await rm(unexpectedFile);

        const unexpectedDirectory = path.join(planetRoot, 'nested');
        await mkdir(unexpectedDirectory);
        await assert.rejects(
            createAssetPackageOutputs({ projectRoot }),
            /Planet source entries must be direct PNG files/
        );
    });
});

test('PNG validator rejects unsupported IHDR profiles, invalid scanline filters, and corruption', async () => {
    const asset = { logicalPath: 'assets/Planets/test.png' };
    await assert.rejects(validatePng(createPng({ bitDepth: 16 }), asset), /unsupported PNG profile/);
    await assert.rejects(validatePng(createPng({ colorType: 2 }), asset), /unsupported PNG profile/);
    await assert.rejects(validatePng(createPng({ interlace: 1 }), asset), /unsupported PNG compression, filter, or interlace/);
    await assert.rejects(validatePng(createPng({ filter: 5 }), asset), /unsupported scanline filter/);
    const corrupted = createPng();
    corrupted[corrupted.length - 1] ^= 0xff;
    await assert.rejects(validatePng(corrupted, asset), /invalid CRC/);
});

test('RTAB validator rejects PNG and other unsupported content type codes', async () => {
    await createProjectFixture(async (projectRoot) => {
        const { outputFiles } = await createAssetPackageOutputs({ projectRoot });
        const manifest = JSON.parse(outputFiles.get(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json')) as string);
        const bundle = manifest.bundles.find((entry: any) => entry.bundleId === 'ships');
        const bundlePath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
        const original = Buffer.from(outputFiles.get(bundlePath) as Buffer);
        const expected = manifestExpectedAssets(manifest, 'ships');
        for (const code of [1, 2, 3, 4]) {
            const changed = Buffer.from(original);
            changeFirstRecordContentType(changed, code);
            await assert.rejects(
                validateRtabBundle(changed, bundle, expected),
                new RegExp(`Unsupported RTAB content type ${code}`)
            );
        }

        const planetBundle = manifest.bundles.find((entry: any) => entry.bundleId === 'planets');
        const planetPath = path.join(projectRoot, 'public', planetBundle.bundleFile.slice(1));
        const planetBytes = Buffer.from(outputFiles.get(planetPath) as Buffer);
        const legacyVersionBytes = Buffer.from(planetBytes);
        legacyVersionBytes.writeUInt16LE(0x0100, 4);
        await assert.rejects(
            validateRtabBundle(
                legacyVersionBytes,
                { ...planetBundle, formatVersion: '1.0' },
                manifestExpectedAssets(manifest, 'planets')
            ),
            /Unsupported RTAB content type 1/
        );
        for (const code of [2, 3, 4]) {
            const changed = Buffer.from(planetBytes);
            changeFirstRecordContentType(changed, code);
            await assert.rejects(
                validateRtabBundle(changed, planetBundle, manifestExpectedAssets(manifest, 'planets')),
                new RegExp(`Unsupported RTAB content type ${code}`)
            );
        }
    });
});

test('clean-clone manifest rejects content-type and logical-path mismatches', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.assets.find((asset: any) => asset.contentType === 'SVG').contentType = 'PNG';
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await assert.rejects(
            validateCommittedAssetOutputs({ projectRoot }),
            /metadata does not match registry asset/
        );
    });
});

test('packager rejects malformed SVG, missing sources, unregistered assets, root files, and normalized category collisions', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        const svg = registry.assets.find((asset) => asset.assetId === 'rt.ship.human-frigate')!;
        const sourcePath = resolveAssetSource(svg.logicalPath, projectRoot);
        await writeFile(sourcePath, '<svg><g></svg>');
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /not a well-formed SVG document/);

        await writeFile(sourcePath, SVG);
        await rm(sourcePath);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /could not find canonical source/);
        await writeFile(sourcePath, SVG);

        await writeFile(path.join(projectRoot, 'private', 'assets', 'Ships', 'unknown.svg'), SVG);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /Unregistered asset source file/);
        await rm(path.join(projectRoot, 'private', 'assets', 'Ships', 'unknown.svg'));

        await writeFile(path.join(projectRoot, 'private', 'assets', 'direct.svg'), SVG);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /inside a top-level category/);
        await rm(path.join(projectRoot, 'private', 'assets', 'direct.svg'));

        await mkdir(path.join(projectRoot, 'private', 'assets', 'Turrets Platforms'));
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /collide after normalization/);
    });
});

test('empty category directories do not create bundles', async () => {
    await createProjectFixture(async (projectRoot) => {
        await mkdir(path.join(projectRoot, 'private', 'assets', 'Stations'));
        const { manifest } = await createAssetPackageOutputs({ projectRoot });
        assert.deepEqual(manifest.bundles.map((bundle: any) => bundle.bundleId).sort(), [
            'components',
            'planets',
            'ships',
            'turrets-platforms'
        ]);
    });
});

test('preparation publishes successfully when private is a top-level directory symlink', async (t) => {
    await createProjectFixture(async (projectRoot) => {
        const privateRoot = path.join(projectRoot, 'private');
        const externalParent = await mkdtemp(path.join(os.tmpdir(), 'rtab-linked-private-'));
        const externalPrivateRoot = path.join(externalParent, 'private-store');
        try {
            await cp(privateRoot, externalPrivateRoot, { recursive: true });
            await rm(privateRoot, { recursive: true });
            try {
                await symlink(externalPrivateRoot, privateRoot, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error: any) {
                if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                    t.skip(`directory symlink creation is unavailable: ${error.code}`);
                    return;
                }
                throw error;
            }

            const result = await prepareAssets({ projectRoot });
            assert.equal(result.mode, 'package');
            const published = JSON.parse(await readFile(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'), 'utf8'));
            assert.equal(published.assets.length, 34);
            assert.equal(published.bundles.find((bundle: any) => bundle.bundleId === 'planets')?.assetCount, 3);
            assert.equal((await lstat(privateRoot)).isSymbolicLink(), true);
            await assert.rejects(lstat(path.join(externalPrivateRoot, '.asset-package.lock')));
            await assert.rejects(lstat(path.join(externalPrivateRoot, '.asset-package-transaction.jsonl')));
        } finally {
            await rm(externalParent, { recursive: true, force: true });
        }
    });
});

test('category traversal rejects symbolic links and special filesystem entries', async (t) => {
    await createProjectFixture(async (projectRoot) => {
        const target = path.join(projectRoot, 'private', 'assets', 'Ships', 'human-frigate.svg');
        const linkPath = path.join(projectRoot, 'private', 'assets', 'Ships', 'linked.svg');
        try {
            await symlink(target, linkPath);
        } catch (error: any) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`symbolic link creation is unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /link or special file/);
    });
});

test('category traversal rejects a symbolic-link directory', async (t) => {
    await createProjectFixture(async (projectRoot) => {
        const target = path.join(projectRoot, 'private', 'assets', 'Ships');
        const linkPath = path.join(projectRoot, 'private', 'assets', 'Components', 'Aistiaria', 'linked-category');
        try {
            await symlink(target, linkPath, process.platform === 'win32' ? 'dir' : undefined);
        } catch (error: any) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`symbolic-link directory creation is unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /link or special file/);
    });
});

test('native Windows category traversal rejects junction/reparse-point directories', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('requires native Windows junction behavior');
        return;
    }
    await createProjectFixture(async (projectRoot) => {
        const target = path.join(projectRoot, 'private', 'assets', 'Ships');
        const junctionPath = path.join(projectRoot, 'private', 'assets', 'Components', 'Aistiaria', 'junction-category');
        await symlink(target, junctionPath, 'junction');
        const info = await import('node:fs/promises').then(({ lstat }) => lstat(junctionPath));
        assert.equal(info.isSymbolicLink(), true);
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /link or special file/);
    });
});

test('lifecycle publishes four mixed-asset bundles, preserves the 31-entry SVG runtime manifest, and validates clean clones', async () => {
    await createProjectFixture(async (projectRoot) => {
        const generated = await prepareAssets({ projectRoot });
        assert.equal(generated.mode, 'package');
        assert.equal(generated.outputFiles.size, 8);
        const generatedManifest = generated.outputFiles.get(
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json')
        ) as string;
        const generatedMetadata = JSON.parse(generatedManifest);
        const expectedOutputPaths = [
            ...generatedMetadata.bundles.map((bundle: any) => path.resolve(projectRoot, 'public', bundle.bundleFile.slice(1))),
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
            path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json'),
            path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts'),
            path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts')
        ].sort();
        assert.deepEqual([...generated.outputFiles.keys()].sort(), expectedOutputPaths);
        const runtimeManifestPath = path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts');
        const runtimeManifest = await readFile(runtimeManifestPath, 'utf8');
        const baselineRuntimeManifest = await readFile(path.join(REPOSITORY_ROOT, 'src', 'generated', 'publicSvgManifest.ts'), 'utf8');
        assert.equal((runtimeManifest.match(/"key":/g) ?? []).length, 31);
        assert.match(runtimeManifest, /"central-hull"/);
        assert.doesNotMatch(runtimeManifest, /Map-111\.png|planetMap111/);
        assert.equal(runtimeManifest, baselineRuntimeManifest);

        const outputs = await snapshotOutputs(projectRoot);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        const cleanClone = await prepareAssets({ projectRoot });
        assert.equal(cleanClone.mode, 'validate-only');
        assert.deepEqual(cleanClone.validatedBundles, ['components', 'planets', 'ships', 'turrets-platforms']);
        await assertSnapshotUnchanged(outputs);
    });
});

test('schema-1.2 predecessor accepts only its independently pinned bundle fingerprint snapshot', async () => {
    await createProjectFixture(async (projectRoot) => {
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const historical = JSON.parse(await readFile(manifestPath, 'utf8'));
        assert.equal(historical.manifestSchemaVersion, '1.2');
        await prepareAssets({ projectRoot });
        const migrated = JSON.parse(await readFile(manifestPath, 'utf8'));
        assert.equal(migrated.manifestSchemaVersion, '1.3');

        await createProjectFixture(async (corruptRoot) => {
            const corruptManifestPath = path.join(corruptRoot, 'public', 'assets', 'asset-manifest.json');
            const corruptManifest = JSON.parse(await readFile(corruptManifestPath, 'utf8'));
            const bundle = corruptManifest.bundles.find((entry: any) => entry.bundleId === 'planets');
            bundle.bundleSha256 = 'a'.repeat(64);
            await writeFile(corruptManifestPath, `${JSON.stringify(corruptManifest, null, 2)}\n`);
            await assert.rejects(
                prepareAssets({ projectRoot: corruptRoot }),
                /invalid bundle record "planets"/
            );
        });
    });
});

test('publication replaces the exact historical transitional planet bundle with required RTAB 1.1 output', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const oldPlanetBundle = await addPreviouslyOwnedPlanetBundle(projectRoot);
        const historicalManifest = JSON.parse(await readFile(
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
            'utf8'
        ));
        assert.equal(historicalManifest.assets.length, 34);
        assert.deepEqual(historicalManifest.bundles.map((bundle: any) => bundle.bundleId).sort(), [
            'components',
            'planets',
            'ships',
            'turrets-platforms'
        ]);
        assert.equal(hash(await readFile(path.join(projectRoot, 'public', 'assets', 'planets.bin'))), hash(oldPlanetBundle));

        const result = await prepareAssets({ projectRoot });
        assert.equal(result.mode, 'package');
        assert.equal(result.publication.staleFiles, 0);
        const manifest = JSON.parse(await readFile(
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
            'utf8'
        ));
        assert.equal(manifest.manifestSchemaVersion, '1.3');
        assert.equal(manifest.assets.length, 34);
        assert.equal(manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets').formatVersion, '1.1');
        assert.deepEqual(manifest.bundles.map((bundle: any) => bundle.bundleId).sort(), [
            'components',
            'planets',
            'ships',
            'turrets-platforms'
        ]);
        assert.deepEqual(await readFile(path.join(projectRoot, 'public', 'assets', 'planets.bin')), oldPlanetBundle);
        const addressedPlanet = manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets');
        assert.equal(addressedPlanet.bundleFile, `/assets/bundles/planets.${addressedPlanet.bundleSha256}.bin`);
        assert.notEqual(addressedPlanet.bundleFile, '/assets/planets.bin');
    });
});

test('publication accepts the exact interrupted SVG-only predecessor and adds required planets.bin', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const assetsRoot = path.join(projectRoot, 'public', 'assets');
        const manifestPath = path.join(assetsRoot, 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.manifestSchemaVersion = '1.1';
        delete manifest.generationId;
        delete manifest.activePlanetPlacements;
        manifest.assets = manifest.assets.filter((asset: any) => asset.contentType === 'SVG');
        manifest.bundles = manifest.bundles.filter((bundle: any) => bundle.bundleId !== 'planets');
        for (const bundle of manifest.bundles) bundle.bundleFile = `/assets/${bundle.bundleId}.bin`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(path.join(assetsRoot, 'planets.bin'));

        const result = await prepareAssets({ projectRoot });
        assert.equal(result.mode, 'package');
        const upgraded = JSON.parse(await readFile(manifestPath, 'utf8'));
        assert.equal(upgraded.manifestSchemaVersion, '1.3');
        assert.equal(upgraded.assets.length, 34);
        assert.equal(upgraded.bundles.length, 4);
        assert.equal(upgraded.bundles.find((bundle: any) => bundle.bundleId === 'planets').formatVersion, '1.1');
    });
});

test('publication preserves and rejects a planet bundle whose prior manifest hash does not match', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await addPreviouslyOwnedPlanetBundle(projectRoot);
        const planetPath = path.join(projectRoot, 'public', 'assets', 'planets.bin');
        const corrupt = await readFile(planetPath);
        corrupt[corrupt.length - 1] ^= 0xff;
        await writeFile(planetPath, corrupt);
        const before = await snapshotOutputs(projectRoot);

        await assert.rejects(
            prepareAssets({ projectRoot }),
            /Previous bundle hash does not match its manifest/
        );
        await assertSnapshotUnchanged(before);
    });
});

test('publication preserves and rejects an unowned planet bundle', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        await rm(manifestPath);
        const planetPath = path.join(projectRoot, 'public', 'assets', 'planets.bin');
        const oldPlanetBundle = await createHistoricalPlanetBundle(projectRoot);
        await writeFile(planetPath, oldPlanetBundle);

        await assert.rejects(
            prepareAssets({ projectRoot }),
            /no historical manifest ownership; preserving it/
        );
        assert.deepEqual(await readFile(planetPath), oldPlanetBundle);
    });
});

test('publication rejects malformed historical planet ownership metadata', async () => {
    const mutations = [
        (bundle: any) => { bundle.bundleId = 'wrong-id'; },
        (bundle: any) => { bundle.formatVersion = '1.1'; },
        (bundle: any) => { bundle.assetCount = 2; },
        (bundle: any) => { bundle.unexpected = true; }
    ];
    for (const mutate of mutations) {
        await createProjectFixture(async (projectRoot) => {
            await prepareAssets({ projectRoot });
            await addPreviouslyOwnedPlanetBundle(projectRoot);
            const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            mutate(manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets'));
            await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            await assert.rejects(
                prepareAssets({ projectRoot }),
                /historical bundle record|bundle record has an invalid shape/
            );
        });
    }

    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await addPreviouslyOwnedPlanetBundle(projectRoot);
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.assets = manifest.assets.filter((asset: any) => asset.assetId !== 'rt.planet-map.map-111');
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await assert.rejects(prepareAssets({ projectRoot }), /exact interrupted schema-1.1 31-asset state|complete historical schema-1.1 34-asset state/);
    });
});

test('publication rejects a historical manifest that claims planets.bin when the file is missing', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await addPreviouslyOwnedPlanetBundle(projectRoot);
        await rm(path.join(projectRoot, 'public', 'assets', 'planets.bin'));
        await assert.rejects(prepareAssets({ projectRoot }), /Historical manifest claims planets.bin but the file is unavailable/);
    });
});

test('incomplete private sources fail without public fallback or replacing prior outputs', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const ship = registry.assets.find((asset) => asset.assetId === 'rt.ship.human-dreadnought')!;
        await rm(resolveAssetSource(ship.logicalPath, projectRoot));
        await assert.rejects(prepareAssets({ projectRoot }), /could not find canonical source/);
        await assertSnapshotUnchanged(outputs);
    });
});

test('clean-clone validation detects bundle hash mismatches and rejects extra manifest fields', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifest = JSON.parse(await readFile(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'), 'utf8'));
        const shipsBundle = manifest.bundles.find((bundle: any) => bundle.bundleId === 'ships');
        const bundlePath = path.join(projectRoot, 'public', shipsBundle.bundleFile.slice(1));
        const bytes = await readFile(bundlePath);
        bytes[bytes.length - 1] ^= 0xff;
        await writeFile(bundlePath, bytes);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await assert.rejects(validateCommittedAssetOutputs({ projectRoot }), /Bundle "ships" SHA-256 mismatch/);
    });

    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.assets[0].privateSourcePath = 'private/assets/Ships/secret.svg';
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await assert.rejects(validateCommittedAssetOutputs({ projectRoot }), /unsupported properties/);
    });

    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const asset = manifest.assets.find((entry: any) => entry.contentType === 'SVG');
        asset.sourceSha256 = '0'.repeat(64);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await assert.rejects(
            validateCommittedAssetOutputs({ projectRoot }),
            /generation ID/
        );
    });
});

test('an existing but invalid private root is not treated as an absent clean clone', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await writeFile(path.join(projectRoot, 'private'), 'not a directory');
        await assert.rejects(prepareAssets({ projectRoot }), /Private source root target is not a directory/);
    });
});

test('existing private roots without assets fail instead of entering clean-clone mode', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const privateRoot = path.join(projectRoot, 'private');
        await rm(path.join(privateRoot, 'assets'), { recursive: true });

        await assert.rejects(prepareAssets({ projectRoot }), /missing the required assets directory/);
        await assertSnapshotUnchanged(outputs);
    });

    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const privateRoot = path.join(projectRoot, 'private');
        await rm(path.join(privateRoot, 'assets'), { recursive: true });
        await mkdir(path.join(privateRoot, 'staging'));
        await writeFile(path.join(privateRoot, 'staging', 'note.txt'), 'not an assets source tree');

        await assert.rejects(prepareAssets({ projectRoot }), /missing the required assets directory/);
        await assertSnapshotUnchanged(outputs);
    });
});

test('an existing private/assets path must be a real directory', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const privateRoot = path.join(projectRoot, 'private');
        await rm(path.join(privateRoot, 'assets'), { recursive: true });
        await writeFile(path.join(privateRoot, 'assets'), 'not a directory');

        await assert.rejects(prepareAssets({ projectRoot }), /Private asset source root must be a real directory/);
        await assertSnapshotUnchanged(outputs);
    });
});

test('preparation preserves existing locks and journals; clean-clone mode rejects orphan artifacts read-only', async () => {
    for (const kind of ['lock', 'journal', 'orphan'] as const) {
        await createProjectFixture(async (projectRoot) => {
            await prepareAssets({ projectRoot });
            const snapshots = await snapshotOutputs(projectRoot);
            const privateRoot = path.join(projectRoot, 'private');

            if (kind === 'lock') {
                const lockPath = path.join(privateRoot, '.asset-package.lock');
                const contents = Buffer.from('{"pid":1,"hostname":"test","token":"active"}\n');
                await writeFile(lockPath, contents);
                await assert.rejects(prepareAssets({ projectRoot }), /lock already exists/);
                assert.deepEqual(await readFile(lockPath), contents);
            } else if (kind === 'journal') {
                const journalPath = path.join(privateRoot, '.asset-package-transaction.jsonl');
                const contents = Buffer.from('{"type":"begin","transactionId":"unfinished"}');
                await writeFile(journalPath, contents);
                await assert.rejects(prepareAssets({ projectRoot }), /journal is truncated/);
                assert.deepEqual(await readFile(journalPath), contents);
            } else {
                await rm(privateRoot, { recursive: true });
                const artifactPath = path.join(projectRoot, 'public', 'assets', `ships.bin.rtab-${randomUUID()}.tmp`);
                const contents = Buffer.from('ambiguous temporary file');
                await writeFile(artifactPath, contents);
                await assert.rejects(prepareAssets({ projectRoot }), /publication artifact.*without recovery/);
                assert.deepEqual(await readFile(artifactPath), contents);
            }
            await assertSnapshotUnchanged(snapshots);
        });
    }
});

test('clean-clone validation rejects a rehashed planet payload with a non-approved source fingerprint', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const assetsRoot = path.join(projectRoot, 'public', 'assets');
        const manifestPath = path.join(assetsRoot, 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const bundle = manifest.bundles.find((entry: any) => entry.bundleId === 'planets');
        const bundlePath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
        const bundleBytes = await readFile(bundlePath);
        const alteredAsset = manifest.assets.find((asset: any) => asset.assetId === 'rt.planet-map.map-111');
        const originalPng = await readFile(path.join(projectRoot, 'private', ...alteredAsset.logicalPath.split('/')));
        const alteredPng = addPngTextChunk(originalPng);
        const alteredBundle = rebuildBundleWithPayload(bundleBytes, alteredAsset.assetId, alteredPng);

        alteredAsset.sourceSha256 = hash(alteredPng);
        bundle.bundleSha256 = hash(alteredBundle);
        await writeFile(bundlePath, alteredBundle);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(path.join(projectRoot, 'private'), { recursive: true });

        await assert.rejects(
            validateCommittedAssetOutputs({ projectRoot }),
            /does not match its approved fingerprint/
        );
    });
});

test('PNG aggregate limits cover full file sizes, decoded pixels, and inflated scanlines', () => {
    assert.throws(
        () => assertPngAggregateLimits(PNG_LIMITS.maxAggregateFileBytes + 1, 0, 0, 'test PNG set'),
        /aggregate PNG file-size limit/
    );
    assert.throws(
        () => assertPngAggregateLimits(0, PNG_LIMITS.maxAggregateDecodedPixelBytes + 1, 0, 'test PNG set'),
        /aggregate decoded pixel limit/
    );
    assert.throws(
        () => assertPngAggregateLimits(0, 0, PNG_LIMITS.maxAggregateScanlineBytes + 1, 'test PNG set'),
        /aggregate inflated scanline limit/
    );
});

test('generated manifest schema 1.3 carries the generation ID and permits SVG and PNG', () => {
    const schema = getManifestSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.properties.manifestSchemaVersion.const, '1.3');
    assert.deepEqual(schema.required, ['manifestSchemaVersion', 'generationId', 'activePlanetPlacements', 'assets', 'bundles']);
    assert.deepEqual(schema.properties.assets.items.properties.contentType.enum, ['SVG', 'PNG']);
    assert.deepEqual(schema.properties.bundles.items.properties.formatVersion.enum, ['1.0', '1.1']);
    const placementKeyPattern = new RegExp(schema.properties.activePlanetPlacements.items.properties.textureKey.pattern);
    assert.match('planetMap111', placementKeyPattern);
    assert.match('planetMapHushanyia', placementKeyPattern);
    assert.doesNotMatch('planetMap', placementKeyPattern);
    assert.equal('assetIds' in schema.properties.bundles.items.properties, false);
    assert.equal('textureKeys' in schema.properties.bundles.items.properties, false);
});

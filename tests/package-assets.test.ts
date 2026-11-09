import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { PNG_LIMITS, validatePng } from '../scripts/validate-png.mjs';
import { prepareAssets } from '../scripts/prepare-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
const PLANET_ASSETS = [
    ['rt.planet-map.map-111', 'assets/Planets/Map-111.png', 'planetMap111'],
    ['rt.planet-map.map-122', 'assets/Planets/Map-122.png', 'planetMap122'],
    ['rt.planet-map.map-692', 'assets/Planets/Map-692.png', 'planetMap692']
];

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
    await mkdir(path.join(projectRoot, 'src', 'generated'), { recursive: true });

    for (const asset of registry.assets) {
        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        await mkdir(path.dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, asset.contentType === 'SVG' ? SVG : createPng());

        if (asset.logicalPath.startsWith('assets/Ships/')) {
            const stalePublicCopy = path.join(projectRoot, 'public', ...asset.logicalPath.split('/'));
            await mkdir(path.dirname(stalePublicCopy), { recursive: true });
            await writeFile(stalePublicCopy, '<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>');
        }
    }

    try {
        await run(projectRoot, registry);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

async function snapshotOutputs(projectRoot: string) {
    const paths = [
        path.join(projectRoot, 'public', 'assets', 'ships.bin'),
        path.join(projectRoot, 'public', 'assets', 'components.bin'),
        path.join(projectRoot, 'public', 'assets', 'turrets-platforms.bin'),
        path.join(projectRoot, 'public', 'assets', 'planets.bin'),
        path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
        path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json'),
        path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts')
    ];
    const snapshots = new Map<string, Buffer>();
    for (const filePath of paths) {
        snapshots.set(filePath, await readFile(filePath));
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

test('registry preserves 31 SVG identities and registers only the three approved planet PNGs', async () => {
    const registry = await readAssetRegistry(REPOSITORY_ROOT);
    const svgAssets = registry.assets.filter((asset) => asset.contentType === 'SVG');
    const pngAssets = registry.assets.filter((asset) => asset.contentType === 'PNG');
    const runtimeByUrl = new Map(publicSvgTextures.map((asset) => [decodeURIComponent(asset.url.slice('/assets/'.length)), asset]));

    assert.equal(registry.registrySchemaVersion, '1.1');
    assert.equal(registry.assets.length, 34);
    assert.equal(svgAssets.length, 31);
    assert.equal(pngAssets.length, 3);
    assert.equal('bundles' in registry, false);
    assert.equal(registry.assets.some((asset) => 'bundleId' in asset), false);
    assert.deepEqual(
        pngAssets.map((asset) => [asset.assetId, asset.logicalPath, asset.textureKey, asset.contentType]),
        PLANET_ASSETS.map(([assetId, logicalPath, textureKey]) => [assetId, logicalPath, textureKey, 'PNG'])
    );
    assert.equal(registry.assets.some((asset) => asset.logicalPath.endsWith('Map-111-2.png')), false);
    assert.equal(registry.assets.some((asset) => asset.logicalPath.endsWith('Map-122-2.png')), false);
    assert.equal(publicSvgTextures.length, 31);

    for (const asset of svgAssets) {
        const runtimeAsset = runtimeByUrl.get(asset.logicalPath.slice('assets/'.length));
        assert.ok(runtimeAsset, `Missing runtime manifest path ${asset.logicalPath}`);
        assert.equal(runtimeAsset.key, asset.textureKey);
        assert.deepEqual(runtimeAsset.aliases, asset.aliases);
    }
    assert.deepEqual(
        svgAssets.filter((asset) => asset.aliases.length > 0).map((asset) => [asset.logicalPath, asset.aliases]),
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

    const oldSchema = structuredClone(registry);
    oldSchema.registrySchemaVersion = '1.0';
    assert.throws(() => validateAssetRegistry(oldSchema), /registrySchemaVersion must be "1.1"/);

    const oldBundleFields = structuredClone(registry);
    oldBundleFields.assets[0].bundleId = 'ships1';
    assert.throws(() => validateAssetRegistry(oldBundleFields), /only asset identity and runtime metadata/);
});

test('folder-derived packaging emits the four RTAB 1.0 bundles and a manifest schema 1.1', async () => {
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
        assert.equal(manifest.manifestSchemaVersion, '1.1');
        assert.equal(manifest.assets.length, 34);
        assert.equal(manifest.bundles.length, 4);
        assert.equal(schema.properties.manifestSchemaVersion.const, '1.1');
        assert.deepEqual(manifest.bundles.map((bundle: any) => bundle.bundleFile).sort(), [
            '/assets/components.bin',
            '/assets/planets.bin',
            '/assets/ships.bin',
            '/assets/turrets-platforms.bin'
        ]);

        for (const bundle of manifest.bundles) {
            const outputPath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
            const bytes = first.outputFiles.get(outputPath) as Buffer;
            const decoded = await validateRtabBundle(bytes, bundle, manifestExpectedAssets(manifest, bundle.bundleId));
            assert.equal(bytes.readUInt16LE(4), 0x0100);
            assert.equal(hash(bytes), bundle.bundleSha256);
            assert.equal(decoded.length, bundle.assetCount);
            assert.equal(
                decoded.every((asset: any) => asset.contentType === (bundle.bundleId === 'planets' ? 'PNG' : 'SVG')),
                true
            );
            assert.deepEqual(bytes, second.outputFiles.get(outputPath));
        }
        assert.equal(manifest.assets.some((asset: any) => asset.logicalPath.endsWith('Map-111-2.png')), false);
        assert.equal(manifest.assets.some((asset: any) => asset.logicalPath.endsWith('Map-122-2.png')), false);
    });
});

test('real planet PNGs match the approved bounded RGBA8 non-interlaced profile', async () => {
    let aggregateCompressedBytes = 0;
    let aggregateDecodedPixelBytes = 0;
    let aggregateInflatedScanlineBytes = 0;
    for (const [, logicalPath] of PLANET_ASSETS) {
        const bytes = await readFile(path.join(REPOSITORY_ROOT, 'public', logicalPath));
        const result = await validatePng(bytes, { logicalPath });
        assert.equal(result.width, 2000);
        assert.equal(result.height, 1000);
        assert.equal(result.decodedPixelBytes, 8_000_000);
        assert.equal(result.scanlineBytes, 8_001_000);
        aggregateCompressedBytes += result.compressedBytes;
        aggregateDecodedPixelBytes += result.decodedPixelBytes;
        aggregateInflatedScanlineBytes += result.scanlineBytes;
    }
    assert.ok(aggregateCompressedBytes <= PNG_LIMITS.maxAggregateFileBytes);
    assert.ok(aggregateDecodedPixelBytes <= PNG_LIMITS.maxAggregateDecodedPixelBytes);
    assert.ok(aggregateInflatedScanlineBytes <= PNG_LIMITS.maxAggregateScanlineBytes);
});

test('packaging enforces the aggregate compressed PNG source-size limit', async () => {
    await createProjectFixture(async (projectRoot) => {
        const registryPath = path.join(projectRoot, 'scripts', 'asset-registry.json');
        const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Registry;
        const basePng = createPng();
        const ancillary = pngChunk('tEXt', Buffer.alloc(7 * 1024 * 1024));
        const largePng = Buffer.concat([basePng.subarray(0, 33), ancillary, basePng.subarray(33)]);

        for (let index = 0; index < 5; index += 1) {
            const logicalPath = `assets/Planets/aggregate-file-${index}.png`;
            registry.assets.push({
                assetId: `rt.test.aggregate-file-${index}`,
                logicalPath,
                textureKey: `aggregateFile${index}`,
                aliases: [],
                contentType: 'PNG'
            });
            const source = resolveAssetSource(logicalPath, projectRoot);
            await mkdir(path.dirname(source), { recursive: true });
            await writeFile(source, largePng);
        }
        await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /aggregate PNG source size exceeds/);
        assert.ok(largePng.length <= PNG_LIMITS.maxFileBytes);
        assert.ok(largePng.length * 5 > PNG_LIMITS.maxAggregateFileBytes);
    });
});

test('packaging independently enforces the aggregate decoded PNG pixel limit', async () => {
    await createProjectFixture(async (projectRoot) => {
        const registryPath = path.join(projectRoot, 'scripts', 'asset-registry.json');
        const registry = JSON.parse(await readFile(registryPath, 'utf8')) as Registry;
        const largePng = createPng({ width: 4096, height: 4095 });
        const extraAssets = [];
        for (let index = 0; index < 2; index += 1) {
            const logicalPath = `assets/Planets/aggregate-pixels-${index}.png`;
            const asset = {
                assetId: `rt.test.aggregate-pixels-${index}`,
                logicalPath,
                textureKey: `aggregatePixels${index}`,
                aliases: [],
                contentType: 'PNG' as const
            };
            registry.assets.push(asset);
            extraAssets.push(asset);
        }
        await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
        for (const asset of registry.assets.filter((entry) => entry.contentType === 'PNG')) {
            const source = resolveAssetSource(asset.logicalPath, projectRoot);
            await mkdir(path.dirname(source), { recursive: true });
            await writeFile(source, largePng);
        }

        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /aggregate decoded pixel limit/);
        assert.equal(extraAssets.length + 3, 5);
        assert.ok(largePng.length < PNG_LIMITS.maxFileBytes);
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

test('RTAB record content type must match manifest metadata in both directions', async () => {
    await createProjectFixture(async (projectRoot) => {
        const { outputFiles } = await createAssetPackageOutputs({ projectRoot });
        const manifest = JSON.parse(outputFiles.get(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json')) as string);
        const bundle = manifest.bundles.find((entry: any) => entry.bundleId === 'planets');
        const bundlePath = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
        const original = Buffer.from(outputFiles.get(bundlePath) as Buffer);
        const expected = manifestExpectedAssets(manifest, 'planets');
        const recordSaysSvg = Buffer.from(original);
        changeFirstRecordContentType(recordSaysSvg, 0);
        await assert.rejects(
            validateRtabBundle(recordSaysSvg, bundle, expected),
            /does not match manifest content type "PNG"/
        );

        const manifestSaysSvg = expected.map((asset: any, index: number) => (
            index === 0 ? { ...asset, contentType: 'SVG' } : asset
        ));
        await assert.rejects(
            validateRtabBundle(original, bundle, manifestSaysSvg),
            /RTAB content type .* does not match manifest content type "SVG"/
        );
    });
});

test('clean-clone manifest content type must match the registry asset metadata', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const planet = manifest.assets.find((asset: any) => asset.contentType === 'PNG');
        planet.contentType = 'SVG';
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

test('lifecycle packages from private sources, keeps the SVG runtime manifest at 31 entries, and clean-clone validation is read-only', async () => {
    await createProjectFixture(async (projectRoot) => {
        const legacyNestedBundle = path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin');
        await mkdir(path.dirname(legacyNestedBundle), { recursive: true });
        const legacyBundleBytes = Buffer.from('previous nested bundle');
        await writeFile(legacyNestedBundle, legacyBundleBytes);
        await writeFile(
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
            JSON.stringify({
                manifestSchemaVersion: '1.0',
                assets: [],
                bundles: [{
                    bundleId: 'ships1',
                    bundleFile: '/assets/Ships/ships.bin',
                    bundleSha256: hash(legacyBundleBytes)
                }]
            })
        );

        const generated = await prepareAssets({ projectRoot });
        assert.equal(generated.mode, 'package');
        await assert.rejects(readFile(legacyNestedBundle), { code: 'ENOENT' });
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
        const bundlePath = path.join(projectRoot, 'public', 'assets', 'ships.bin');
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
});

test('an existing but invalid private root is not treated as an absent clean clone', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await writeFile(path.join(projectRoot, 'private'), 'not a directory');
        await assert.rejects(prepareAssets({ projectRoot }), /exists but is not a real directory/);
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

        await assert.rejects(prepareAssets({ projectRoot }), /Private asset source root exists but is not a real directory/);
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

test('generated manifest schema 1.1 contains both content types without bundle membership arrays', () => {
    const schema = getManifestSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.properties.manifestSchemaVersion.const, '1.1');
    assert.deepEqual(schema.required, ['manifestSchemaVersion', 'assets', 'bundles']);
    assert.deepEqual(schema.properties.assets.items.properties.contentType.enum, ['SVG', 'PNG']);
    assert.equal('assetIds' in schema.properties.bundles.items.properties, false);
    assert.equal('textureKeys' in schema.properties.bundles.items.properties, false);
});

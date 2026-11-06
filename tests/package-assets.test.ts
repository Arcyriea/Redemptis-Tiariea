import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { prepareAssets } from '../scripts/prepare-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

async function createProjectFixture(run: (projectRoot: string, registry: any) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'rtab-assets-'));
    const registry = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'), 'utf8'));
    const registryPath = path.join(projectRoot, 'scripts', 'asset-registry.json');
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await mkdir(path.join(projectRoot, 'src', 'generated'), { recursive: true });

    for (const asset of registry.assets) {
        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        await mkdir(path.dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, SVG);

        if (asset.logicalPath.startsWith('assets/Ships/')) {
            const stalePublicCopy = path.join(
                projectRoot,
                'public',
                ...asset.logicalPath.split('/')
            );
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
        path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin'),
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

function assertSnapshotUnchanged(snapshots: Map<string, Buffer>, projectRoot: string) {
    return Promise.all([...snapshots].map(async ([filePath, expected]) => {
        assert.deepEqual(await readFile(filePath), expected, `Unexpected output change: ${path.relative(projectRoot, filePath)}`);
    }));
}

function hash(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

test('registry covers only 31 game SVGs, preserves runtime keys and the exact legacy aliases', async () => {
    const registry = await readAssetRegistry(REPOSITORY_ROOT, { expectedAssetCount: 31 });
    const registeredPaths = new Set(registry.assets.map((asset) => asset.logicalPath));
    const runtimeByUrl = new Map(publicSvgTextures.map((asset) => [decodeURIComponent(asset.url.slice('/assets/'.length)), asset]));

    assert.equal(registry.assets.length, 31);
    assert.equal(registry.assets.filter((asset) => asset.bundleId === 'ships1').length, 10);
    assert.equal(registry.assets.filter((asset) => !asset.bundleId).length, 21);
    assert.equal(registry.assets.every((asset) => asset.logicalPath.startsWith('assets/')), true);
    assert.equal(registry.assets.some((asset) => asset.logicalPath.startsWith('minimap/')), false);
    assert.equal(registeredPaths.has('favicon.svg'), false);
    assert.equal(registeredPaths.has('icons.svg'), false);
    assert.equal(Object.keys(registry.bundles).join(','), 'ships1');

    for (const asset of registry.assets) {
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

test('registry rejects duplicate IDs, duplicate texture keys, alias conflicts, and unsupported content types', async () => {
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
    unsupportedType.assets[0].contentType = 'PNG';
    assert.throws(() => validateAssetRegistry(unsupportedType), /unsupported content type/);
});

test('packager emits a deterministic ten-ship RTAB bundle and generated-only manifest/schema', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        const first = await createAssetPackageOutputs({ projectRoot });
        const second = await createAssetPackageOutputs({ projectRoot });
        const bundlePath = path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin');
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const schemaPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json');
        const bundleBytes = first.outputFiles.get(bundlePath) as Buffer;
        const secondBundle = second.outputFiles.get(bundlePath) as Buffer;
        const manifest = JSON.parse(first.outputFiles.get(manifestPath) as string);
        const schema = JSON.parse(first.outputFiles.get(schemaPath) as string);
        const expectedAssets = registry.assets
            .filter((asset: any) => asset.bundleId === 'ships1')
            .map((asset: any) => ({ assetId: asset.assetId }))
            .sort((left: any, right: any) => left.assetId < right.assetId ? -1 : 1);
        const decoded = validateRtabBundle(bundleBytes, manifest.bundles[0], expectedAssets);

        assert.deepEqual(bundleBytes, secondBundle);
        assert.equal(hash(bundleBytes), manifest.bundles[0].bundleSha256);
        assert.equal(bundleBytes.toString('ascii', 0, 4), 'RTAB');
        assert.equal(bundleBytes.readUInt16LE(4), 0x0100);
        assert.equal(bundleBytes.readUInt16LE(6), 0x0003);
        assert.equal(bundleBytes.readBigUInt64LE(16), 64n);
        assert.equal(bundleBytes.subarray(32, 64).every((byte) => byte === 0), true);
        assert.equal(decoded.length, 10);
        assert.equal(decoded.every((asset) => asset.bytes.toString('utf8').startsWith('<svg')), true);
        assert.equal(manifest.assets.length, 10);
        assert.equal(manifest.assets.every((asset: any) => asset.bundleId === 'ships1'), true);
        assert.equal(manifest.assets.some((asset: any) => asset.logicalPath.includes('Components')), false);
        assert.equal(manifest.bundles[0].bundleFile, '/assets/Ships/ships.bin');
        assert.equal('assetIds' in manifest.bundles[0], false);
        assert.equal('textureKeys' in manifest.bundles[0], false);
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.equal(schema.properties.manifestSchemaVersion.const, '1.0');
        assert.deepEqual(manifest, JSON.parse(second.outputFiles.get(manifestPath) as string));
    });
});

test('packager rejects malformed, non-SVG, and empty canonical ship sources', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        const ship = registry.assets.find((asset: any) => asset.assetId === 'rt.ship.human-frigate');
        const sourcePath = resolveAssetSource(ship.logicalPath, projectRoot);

        await writeFile(sourcePath, '<svg><g></svg>');
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /not a well-formed SVG document/);

        await writeFile(sourcePath, '<html/>');
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /does not have an SVG document root/);

        await writeFile(sourcePath, '<svg xmlns="urn:not-svg"/>');
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /unexpected root namespace/);

        await writeFile(sourcePath, Buffer.alloc(0));
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /zero-byte file/);
    });
});

test('bundle validator rejects unsupported versions, flags, and payload corruption', async () => {
    await createProjectFixture(async (projectRoot) => {
        const { outputFiles } = await createAssetPackageOutputs({ projectRoot });
        const bundlePath = path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin');
        const bytes = outputFiles.get(bundlePath) as Buffer;
        const bundle = { bundleId: 'ships1' };
        const expectedAssets = JSON.parse(outputFiles.get(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json')) as string)
            .assets.map((asset: any) => ({ assetId: asset.assetId }))
            .sort((left: any, right: any) => left.assetId < right.assetId ? -1 : 1);

        const badVersion = Buffer.from(bytes);
        badVersion.writeUInt16LE(0x0101, 4);
        assert.throws(() => validateRtabBundle(badVersion, bundle, expectedAssets), /Unsupported RTAB version/);

        const badFlags = Buffer.from(bytes);
        badFlags.writeUInt16LE(0x0007, 6);
        assert.throws(() => validateRtabBundle(badFlags, bundle, expectedAssets), /header flags/);

        const badPayload = Buffer.from(bytes);
        badPayload[badPayload.length - 1] ^= 0xff;
        assert.throws(() => validateRtabBundle(badPayload, bundle, expectedAssets), /Payload for/);
    });
});

test('missing private ship sources fail even when stale public ship copies exist', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        const ship = registry.assets.find((asset: any) => asset.assetId === 'rt.ship.human-frigate');
        await rm(resolveAssetSource(ship.logicalPath, projectRoot));
        await assert.rejects(createAssetPackageOutputs({ projectRoot }), /could not find canonical source/);
    });
});

test('lifecycle packages from private ships, retains 31 loose entries, and validates clean-clone mode read-only', async () => {
    await createProjectFixture(async (projectRoot) => {
        const generated = await prepareAssets({ projectRoot });
        assert.equal(generated.mode, 'package');
        const runtimeManifestPath = path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts');
        const runtimeManifest = await readFile(runtimeManifestPath, 'utf8');
        assert.equal((runtimeManifest.match(/"key":/g) ?? []).length, 31);
        assert.match(runtimeManifest, /"central-hull"/);
        assert.match(runtimeManifest, /"human-dreadnought"/);
        assert.match(runtimeManifest, /"alien-interceptor"/);

        const outputs = await snapshotOutputs(projectRoot);
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        const cleanClone = await prepareAssets({ projectRoot });
        assert.equal(cleanClone.mode, 'validate-only');
        assert.deepEqual(cleanClone.validatedBundles, ['ships1']);
        await assertSnapshotUnchanged(outputs, projectRoot);
    });
});

test('incomplete private source fails before replacing previously valid outputs', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const ship = registry.assets.find((asset: any) => asset.assetId === 'rt.ship.human-dreadnought');
        await rm(resolveAssetSource(ship.logicalPath, projectRoot));

        await assert.rejects(prepareAssets({ projectRoot }), /could not find canonical source/);
        await assertSnapshotUnchanged(outputs, projectRoot);
    });
});

test('a missing public canonical source also fails before generated output replacement', async () => {
    await createProjectFixture(async (projectRoot, registry) => {
        await prepareAssets({ projectRoot });
        const outputs = await snapshotOutputs(projectRoot);
        const component = registry.assets.find((asset: any) => asset.logicalPath.includes('Components/Aistiaria/02_hex_cockpit'));
        await rm(resolveAssetSource(component.logicalPath, projectRoot));

        await assert.rejects(prepareAssets({ projectRoot }), /could not find canonical source|Missing canonical source/);
        await assertSnapshotUnchanged(outputs, projectRoot);
    });
});

test('clean-clone validation detects a committed bundle hash mismatch', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const bundlePath = path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin');
        const bytes = await readFile(bundlePath);
        bytes[bytes.length - 1] ^= 0xff;
        await writeFile(bundlePath, bytes);
        await rm(path.join(projectRoot, 'private'), { recursive: true });

        await assert.rejects(validateCommittedAssetOutputs({ projectRoot }), /Bundle "ships1" SHA-256 mismatch/);
    });
});

test('clean-clone validation rejects manifest fields outside the public contract', async () => {
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

test('a private path that exists but is not a directory is not treated as an absent clean clone', async () => {
    await createProjectFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        await rm(path.join(projectRoot, 'private'), { recursive: true });
        await writeFile(path.join(projectRoot, 'private'), 'not a directory');

        await assert.rejects(prepareAssets({ projectRoot }), /exists but is not a directory/);
    });
});

test('generated schema declares the manifest contract without asset membership arrays', () => {
    const schema = getManifestSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(schema.required, ['manifestSchemaVersion', 'assets', 'bundles']);
    assert.equal('assetIds' in schema.properties.bundles.items.properties, false);
    assert.equal('textureKeys' in schema.properties.bundles.items.properties, false);
});

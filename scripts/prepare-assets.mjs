import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetPackageOutputs, validateCommittedAssetOutputs, validateRtabBundle } from './package-assets.mjs';
import { createPublicSvgManifest, renderPublicSvgManifest } from './generate-public-svg-manifest.mjs';
import { buildRuntimeContract, renderRuntimeContract } from './asset-contract.mjs';
import { PROJECT_ROOT, readAssetRegistry } from './asset-registry.mjs';
import {
    assertNoPendingAssetOutputTransaction,
    publishAssetOutputs,
    withAssetOutputLock
} from './asset-output-publisher.mjs';

const HISTORICAL_PLANET_ASSETS = [
    {
        assetId: 'rt.planet-map.map-111',
        logicalPath: 'assets/Planets/Map-111.png',
        textureKey: 'planetMap111',
        aliases: [],
        contentType: 'PNG',
        sourceSha256: '83d39b7a7603f574f47cee57c4d9b12b0b468b469fece0ffe7765d921f067ea1'
    },
    {
        assetId: 'rt.planet-map.map-122',
        logicalPath: 'assets/Planets/Map-122.png',
        textureKey: 'planetMap122',
        aliases: [],
        contentType: 'PNG',
        sourceSha256: '35f8af626f4d7162a2926ef3dad6cdec36610cfd6f3acac86a1547d764081f7e'
    },
    {
        assetId: 'rt.planet-map.map-692',
        logicalPath: 'assets/Planets/Map-692.png',
        textureKey: 'planetMap692',
        aliases: [],
        contentType: 'PNG',
        sourceSha256: '43652c4465b35a1e3ae4bf99bbb75308359179c9d1b3fd8711d38c806b1472a8'
    }
];
const KNOWN_PREDECESSOR_BUNDLE_HASHES = Object.freeze({
    components: 'c765204592f66b0431a41b7c20a3f4ff58559757883aa39f0a81ad864a1928df',
    planets: 'ef64dfb9a6491965d5b3870918f317f9a5632fb32eeb5c4be812b1f1829dc120',
    ships: '5a88e030dfbd0cecc8d2b51acf7e80dce2bdb36862838ba0ea113d84707fd65b',
    'turrets-platforms': '943e47cfed1ff6e28bc4bca70efe0f42c9d1403b8e2a17c24643f8a61c9e126e'
});
const PLANET_BUNDLE_HASH = KNOWN_PREDECESSOR_BUNDLE_HASHES.planets;

function assertExactKeys(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== expectedKeys.length
        || Object.keys(value).some((key) => !expectedKeys.includes(key))) {
        throw new Error(`Previous asset manifest ${label} has an invalid shape`);
    }
}

function historicalBundleId(logicalPath) {
    const category = logicalPath.split('/')[1];
    return category.toLowerCase().split(/[ _-]+/).filter(Boolean).join('-');
}

function validateHistoricalManifest(manifest, registry) {
    assertExactKeys(manifest, ['manifestSchemaVersion', 'assets', 'bundles'], 'root');
    if (manifest.manifestSchemaVersion !== '1.1'
        || !Array.isArray(manifest.assets) || manifest.assets.length !== 34
        || !Array.isArray(manifest.bundles) || manifest.bundles.length !== 4) {
        throw new Error('Previous asset manifest is not the complete historical schema-1.1 34-asset state');
    }

    const expectedAssets = new Map();
    for (const asset of registry.assets) {
        expectedAssets.set(asset.assetId, {
            assetId: asset.assetId,
            logicalPath: asset.logicalPath,
            textureKey: asset.textureKey,
            aliases: asset.aliases,
            contentType: asset.contentType,
            bundleId: historicalBundleId(asset.logicalPath),
            sourceSha256: null
        });
    }
    for (const asset of HISTORICAL_PLANET_ASSETS) {
        expectedAssets.set(asset.assetId, { ...asset, bundleId: 'planets' });
    }
    if (expectedAssets.size !== 34) {
        throw new Error('Current asset registry cannot define the expected historical asset set');
    }

    const assetIds = new Set();
    const logicalPaths = new Set();
    const textureKeys = new Set();
    const aliases = new Set();
    const actualById = new Map();
    for (const asset of manifest.assets) {
        assertExactKeys(
            asset,
            ['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'],
            'asset record'
        );
        const expected = expectedAssets.get(asset.assetId);
        if (!expected
            || asset.logicalPath !== expected.logicalPath
            || asset.textureKey !== expected.textureKey
            || asset.contentType !== expected.contentType
            || asset.bundleId !== expected.bundleId
            || JSON.stringify(asset.aliases) !== JSON.stringify(expected.aliases)
            || typeof asset.sourceSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)
            || (expected.sourceSha256 && asset.sourceSha256 !== expected.sourceSha256)) {
            throw new Error(`Previous asset manifest has invalid metadata or source fingerprint for "${asset.assetId}"`);
        }
        const normalizedPath = asset.logicalPath.toLowerCase();
        const normalizedKey = asset.textureKey.toLowerCase();
        if (assetIds.has(asset.assetId) || logicalPaths.has(normalizedPath) || textureKeys.has(normalizedKey)) {
            throw new Error('Previous asset manifest contains duplicate asset IDs, logical paths, or texture keys');
        }
        assetIds.add(asset.assetId);
        logicalPaths.add(normalizedPath);
        textureKeys.add(normalizedKey);
        actualById.set(asset.assetId, asset);
    }
    if (assetIds.size !== expectedAssets.size
        || [...expectedAssets.keys()].some((assetId) => !actualById.has(assetId))) {
        throw new Error('Previous asset manifest does not contain every historical asset identity');
    }
    for (const asset of manifest.assets) {
        for (const alias of asset.aliases) {
            const normalizedAlias = alias.toLowerCase();
            if (typeof alias !== 'string' || alias.length === 0
                || textureKeys.has(normalizedAlias) || aliases.has(normalizedAlias)) {
                throw new Error('Previous asset manifest contains an invalid or duplicate texture alias');
            }
            aliases.add(normalizedAlias);
        }
    }

    const bundleIds = new Set();
    const expectedBundleIds = new Set(['components', 'planets', 'ships', 'turrets-platforms']);
    const bundleCounts = new Map();
    for (const asset of manifest.assets) {
        if (!expectedBundleIds.has(asset.bundleId)) {
            throw new Error(`Previous asset "${asset.assetId}" references an unknown bundle`);
        }
        bundleCounts.set(asset.bundleId, (bundleCounts.get(asset.bundleId) ?? 0) + 1);
    }
    for (const bundle of manifest.bundles) {
        assertExactKeys(
            bundle,
            ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'],
            'bundle record'
        );
        if (!expectedBundleIds.has(bundle.bundleId) || bundleIds.has(bundle.bundleId)
            || bundle.bundleFile !== `/assets/${bundle.bundleId}.bin`
            || bundle.formatVersion !== '1.0'
            || !Number.isSafeInteger(bundle.assetCount)
            || bundle.assetCount !== bundleCounts.get(bundle.bundleId)
            || typeof bundle.bundleSha256 !== 'string'
            || bundle.bundleSha256 !== KNOWN_PREDECESSOR_BUNDLE_HASHES[bundle.bundleId]) {
            throw new Error(`Previous asset manifest has an invalid historical bundle record "${bundle.bundleId}"`);
        }
        bundleIds.add(bundle.bundleId);
    }
    if (bundleIds.size !== expectedBundleIds.size
        || [...expectedBundleIds].some((bundleId) => !bundleIds.has(bundleId))) {
        throw new Error('Previous asset manifest does not declare exactly the four historical bundles');
    }
}

function validateInterruptedSvgOnlyManifest(manifest, registry) {
    assertExactKeys(manifest, ['manifestSchemaVersion', 'assets', 'bundles'], 'root');
    const svgAssets = registry.assets.filter((asset) => asset.contentType === 'SVG');
    if (manifest.manifestSchemaVersion !== '1.1'
        || !Array.isArray(manifest.assets) || manifest.assets.length !== 31
        || !Array.isArray(manifest.bundles) || manifest.bundles.length !== 3) {
        throw new Error('Previous asset manifest is not the exact interrupted schema-1.1 31-asset state');
    }

    const expectedBundles = new Map([
        ['components', 19],
        ['ships', 10],
        ['turrets-platforms', 2]
    ]);
    const ids = new Set();
    const paths = new Set();
    const keys = new Set();
    const aliases = new Set();
    const actualById = new Map();
    for (const asset of manifest.assets) {
        assertExactKeys(
            asset,
            ['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'],
            'asset record'
        );
        const expected = svgAssets.find((entry) => entry.assetId === asset.assetId);
        const expectedBundle = expected && historicalBundleId(expected.logicalPath);
        if (!expected || asset.logicalPath !== expected.logicalPath
            || asset.textureKey !== expected.textureKey
            || asset.contentType !== 'SVG'
            || asset.bundleId !== expectedBundle
            || JSON.stringify(asset.aliases) !== JSON.stringify(expected.aliases)
            || typeof asset.sourceSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)) {
            throw new Error(`Previous SVG-only manifest has invalid metadata for "${asset.assetId}"`);
        }
        if (ids.has(asset.assetId) || paths.has(asset.logicalPath.toLowerCase())
            || keys.has(asset.textureKey.toLowerCase())) {
            throw new Error('Previous SVG-only manifest contains duplicate asset identities');
        }
        ids.add(asset.assetId);
        paths.add(asset.logicalPath.toLowerCase());
        keys.add(asset.textureKey.toLowerCase());
        actualById.set(asset.assetId, asset);
    }
    if (actualById.size !== svgAssets.length
        || svgAssets.some((asset) => !actualById.has(asset.assetId))) {
        throw new Error('Previous SVG-only manifest does not contain all 31 registered SVG identities');
    }
    for (const asset of manifest.assets) {
        for (const alias of asset.aliases) {
            const normalizedAlias = alias.toLowerCase();
            if (typeof alias !== 'string' || !alias || keys.has(normalizedAlias) || aliases.has(normalizedAlias)) {
                throw new Error('Previous SVG-only manifest contains an invalid or duplicate alias');
            }
            aliases.add(normalizedAlias);
        }
    }

    const actualBundles = new Map();
    for (const bundle of manifest.bundles) {
        assertExactKeys(bundle, ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'], 'bundle record');
        if (!expectedBundles.has(bundle.bundleId) || actualBundles.has(bundle.bundleId)
            || bundle.bundleFile !== `/assets/${bundle.bundleId}.bin`
            || bundle.formatVersion !== '1.0'
            || bundle.assetCount !== expectedBundles.get(bundle.bundleId)
            || bundle.bundleSha256 !== KNOWN_PREDECESSOR_BUNDLE_HASHES[bundle.bundleId]) {
            throw new Error(`Previous SVG-only manifest has an invalid bundle record "${bundle.bundleId}"`);
        }
        actualBundles.set(bundle.bundleId, bundle);
    }
    if (actualBundles.size !== expectedBundles.size) {
        throw new Error('Previous SVG-only manifest must declare exactly the three known SVG bundles');
    }
}

function validateCurrentMixedManifest(manifest, registry) {
    assertExactKeys(manifest, ['manifestSchemaVersion', 'assets', 'bundles'], 'root');
    if (manifest.manifestSchemaVersion !== '1.2'
        || !Array.isArray(manifest.assets) || manifest.assets.length !== 34
        || !Array.isArray(manifest.bundles) || manifest.bundles.length !== 4) {
        throw new Error('Previous asset manifest is not a complete schema-1.2 mixed-asset output set');
    }

    const expectedAssets = new Map(registry.assets.map((asset) => [
        asset.assetId,
        { ...asset, bundleId: historicalBundleId(asset.logicalPath) }
    ]));
    for (const asset of HISTORICAL_PLANET_ASSETS) {
        expectedAssets.set(asset.assetId, { ...asset, bundleId: 'planets' });
    }
    const actualById = new Map();
    const paths = new Set();
    const keys = new Set();
    for (const asset of manifest.assets) {
        assertExactKeys(
            asset,
            ['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'],
            'asset record'
        );
        const expected = expectedAssets.get(asset.assetId);
        if (!expected || asset.logicalPath !== expected.logicalPath
            || asset.textureKey !== expected.textureKey
            || asset.contentType !== expected.contentType
            || asset.bundleId !== expected.bundleId
            || JSON.stringify(asset.aliases) !== JSON.stringify(expected.aliases)
            || typeof asset.sourceSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)
            || actualById.has(asset.assetId)
            || paths.has(asset.logicalPath.toLowerCase())
            || keys.has(asset.textureKey.toLowerCase())) {
            throw new Error(`Previous mixed-asset manifest has invalid metadata for "${asset.assetId}"`);
        }
        actualById.set(asset.assetId, asset);
        paths.add(asset.logicalPath.toLowerCase());
        keys.add(asset.textureKey.toLowerCase());
    }
    if (actualById.size !== expectedAssets.size) {
        throw new Error('Previous mixed-asset manifest does not contain all 34 registered identities');
    }

    const counts = new Map();
    for (const asset of manifest.assets) {
        counts.set(asset.bundleId, (counts.get(asset.bundleId) ?? 0) + 1);
    }
    const bundles = new Map();
    for (const bundle of manifest.bundles) {
        assertExactKeys(bundle, ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'], 'bundle record');
        const formatVersion = bundle.bundleId === 'planets' ? '1.1' : '1.0';
        if (!['components', 'planets', 'ships', 'turrets-platforms'].includes(bundle.bundleId)
            || bundles.has(bundle.bundleId)
            || bundle.bundleFile !== `/assets/${bundle.bundleId}.bin`
            || bundle.formatVersion !== formatVersion
            || bundle.assetCount !== counts.get(bundle.bundleId)
            || typeof bundle.bundleSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(bundle.bundleSha256)) {
            throw new Error(`Previous mixed-asset manifest has an invalid bundle record "${bundle.bundleId}"`);
        }
        bundles.set(bundle.bundleId, bundle);
    }
    if (bundles.size !== 4 || ['components', 'planets', 'ships', 'turrets-platforms'].some((id) => !bundles.has(id))) {
        throw new Error('Previous mixed-asset manifest must declare exactly four required bundles');
    }
}

async function privateAssetsRootExists(projectRoot) {
    const privateRoot = path.join(projectRoot, 'private');
    let privateInfo;
    try {
        privateInfo = await lstat(privateRoot);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (privateInfo.isSymbolicLink() || !privateInfo.isDirectory()) {
        throw new Error(`Private source root exists but is not a real directory: ${privateRoot}`);
    }

    const assetsRoot = path.join(privateRoot, 'assets');
    let assetsInfo;
    try {
        assetsInfo = await lstat(assetsRoot);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Private source root exists but is missing the required assets directory: ${assetsRoot}`);
        }
        throw error;
    }
    if (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory()) {
        throw new Error(`Private asset source root exists but is not a real directory: ${assetsRoot}`);
    }
    return true;
}

async function validatePublishedOutputs(projectRoot, expectedRuntimeManifest) {
    await validateCommittedAssetOutputs({ projectRoot });
    const runtimeManifestPath = path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts');
    const info = await lstat(runtimeManifestPath);
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Generated SVG runtime manifest is not a regular file: ${runtimeManifestPath}`);
    }
    const actual = await readFile(runtimeManifestPath, 'utf8');
    if (Buffer.byteLength(actual, 'utf8') !== info.size || actual !== expectedRuntimeManifest) {
        throw new Error('Published SVG runtime manifest does not match the current registered public SVG assets');
    }
}

async function validatePreviousGeneratedManifest(projectRoot, manifest) {
    assertExactKeys(manifest, [
        'manifestSchemaVersion', 'generationId', 'activePlanetPlacements', 'assets', 'bundles'
    ], 'schema-1.3 root');
    if (manifest.manifestSchemaVersion !== '1.3' || !/^[a-f0-9]{64}$/.test(manifest.generationId)
        || !Array.isArray(manifest.assets) || !Array.isArray(manifest.bundles)
        || !Array.isArray(manifest.activePlanetPlacements)) {
        throw new Error('Previous asset manifest is not a valid generated schema-1.3 contract');
    }
    const approvals = new Map();
    const ids = new Set();
    for (const asset of manifest.assets) {
        assertExactKeys(asset, [
            'assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'
        ], 'schema-1.3 asset record');
        if (ids.has(asset.assetId) || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)) {
            throw new Error('Previous schema-1.3 manifest contains duplicate identities or an invalid source hash');
        }
        ids.add(asset.assetId);
        if (asset.contentType === 'PNG') approvals.set(asset.logicalPath, asset.sourceSha256);
    }
    const generated = buildRuntimeContract(manifest, approvals, manifest.activePlanetPlacements);
    if (generated.generationId !== manifest.generationId) {
        throw new Error('Previous schema-1.3 manifest generation ID is invalid');
    }
    const contractPath = path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts');
    const contractSource = await readFile(contractPath, 'utf8');
    if (contractSource !== renderRuntimeContract(generated)) {
        throw new Error('Previous schema-1.3 runtime contract does not match its manifest');
    }
    const seenBundles = new Set();
    for (const bundle of manifest.bundles) {
        assertExactKeys(bundle, ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'], 'schema-1.3 bundle record');
        if (seenBundles.has(bundle.bundleId) || !/^[a-f0-9]{64}$/.test(bundle.bundleSha256)
            || bundle.bundleFile !== `/assets/${bundle.bundleId}.${bundle.bundleSha256}.bin`) {
            throw new Error(`Previous schema-1.3 bundle record is invalid: ${bundle.bundleId}`);
        }
        seenBundles.add(bundle.bundleId);
        const bundlePath = path.resolve(projectRoot, 'public', `.${bundle.bundleFile}`);
        const bytes = await readFile(bundlePath);
        if (createHash('sha256').update(bytes).digest('hex') !== bundle.bundleSha256) {
            throw new Error(`Previous content-addressed bundle hash is invalid: ${bundle.bundleFile}`);
        }
        const expectedAssets = manifest.assets.filter((asset) => asset.bundleId === bundle.bundleId)
            .map(({ assetId, contentType, logicalPath, sourceSha256 }) => ({ assetId, contentType, logicalPath, sourceSha256 }))
            .sort((left, right) => left.assetId.localeCompare(right.assetId));
        await validateRtabBundle(bytes, bundle, expectedAssets);
    }
}

async function findStaleBundlePaths(projectRoot, nextManifest) {
    const publicRoot = path.join(projectRoot, 'public');
    const registry = await readAssetRegistry(projectRoot);
    const legacyNestedShips = path.join(publicRoot, 'assets', 'Ships', 'ships.bin');
    const oldManifestPath = path.join(publicRoot, 'assets', 'asset-manifest.json');
    const planetsBundlePath = path.join(publicRoot, 'assets', 'planets.bin');
    let oldManifest;
    try {
        const info = await lstat(oldManifestPath);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error(`Previous asset manifest is not a regular file: ${oldManifestPath}`);
        }
        oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error(`Could not inspect previous asset manifest for stale outputs: ${error.message}`);
        }
    }

    const planetInfo = await lstat(planetsBundlePath, { bigint: true }).catch((error) => {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    });
    if (oldManifest === undefined) {
        if (planetInfo) {
            throw new Error(`Previous planet bundle has no historical manifest ownership; preserving it: ${planetsBundlePath}`);
        }
        for (const bundleId of Object.keys(KNOWN_PREDECESSOR_BUNDLE_HASHES)) {
            const bundlePath = path.join(publicRoot, 'assets', `${bundleId}.bin`);
            const bundleInfo = await lstat(bundlePath).catch((error) => {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            });
            if (bundleInfo) {
                throw new Error(`Previous bundle has no manifest ownership; preserving it: ${bundlePath}`);
            }
        }
        const legacyInfo = await lstat(legacyNestedShips).catch((error) => {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (legacyInfo) {
            throw new Error(`Legacy Ships bundle has no prior manifest ownership record; preserving it: ${legacyNestedShips}`);
        }
        return [];
    }

    const isHistorical = oldManifest?.manifestSchemaVersion === '1.1'
        && Array.isArray(oldManifest.assets) && oldManifest.assets.length !== 31;
    const isCurrentMixed = oldManifest?.manifestSchemaVersion === '1.2'
        && Array.isArray(oldManifest.assets) && oldManifest.assets.length === 34;
    const isGenerated = oldManifest?.manifestSchemaVersion === '1.3';
    if (isHistorical) {
        validateHistoricalManifest(oldManifest, registry);
        if (!planetInfo) {
            throw new Error(`Historical manifest claims planets.bin but the file is unavailable: ${planetsBundlePath}`);
        }
        if (planetInfo.isSymbolicLink() || !planetInfo.isFile()) {
            throw new Error(`Previous planet bundle is not a regular file; preserving it: ${planetsBundlePath}`);
        }
    } else if (isCurrentMixed) {
        validateCurrentMixedManifest(oldManifest, registry);
        if (!planetInfo) {
            throw new Error(`Current mixed-asset manifest claims planets.bin but the file is unavailable: ${planetsBundlePath}`);
        }
        if (planetInfo.isSymbolicLink() || !planetInfo.isFile()) {
            throw new Error(`Current planet bundle is not a regular file: ${planetsBundlePath}`);
        }
    } else if (isGenerated) {
        await validatePreviousGeneratedManifest(projectRoot, oldManifest);
    } else {
        validateInterruptedSvgOnlyManifest(oldManifest, registry);
        if (planetInfo) {
            throw new Error(`Unexpected planets.bin is not owned by the exact interrupted SVG-only predecessor; preserving it: ${planetsBundlePath}`);
        }
    }

    for (const bundle of oldManifest.bundles) {
        if (!bundle.bundleFile.startsWith('/assets/')
            || bundle.bundleFile.includes('\\')
            || bundle.bundleFile.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
            throw new Error('Previous asset manifest contains an unsafe bundle path');
        }
        const destination = path.resolve(publicRoot, `.${bundle.bundleFile}`);
        if (!destination.startsWith(`${publicRoot}${path.sep}`)) {
            throw new Error(`Previous bundle path escapes public output root: ${bundle.bundleFile}`);
        }
        const info = await lstat(destination, { bigint: true }).catch((error) => {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (!info || info.isSymbolicLink() || !info.isFile()) {
            throw new Error(`Previous owned bundle is unavailable or not a regular file: ${destination}`);
        }
        const bytes = await readFile(destination);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (BigInt(bytes.length) !== info.size || digest !== bundle.bundleSha256) {
            throw new Error(`Previous bundle hash does not match its manifest: ${destination}`);
        }
        if (!(isHistorical && bundle.bundleId === 'planets')) {
            const expectedAssets = oldManifest.assets
                .filter((asset) => asset.bundleId === bundle.bundleId)
                .map((asset) => ({
                    assetId: asset.assetId,
                    contentType: asset.contentType,
                    logicalPath: asset.logicalPath,
                    sourceSha256: asset.sourceSha256
                }))
                .sort((left, right) => left.assetId.localeCompare(right.assetId));
            await validateRtabBundle(bytes, bundle, expectedAssets);
        } else if (digest !== PLANET_BUNDLE_HASH) {
            throw new Error(`Historical transitional planet bundle fingerprint mismatch: ${destination}`);
        }
    }
    if (nextManifest.assets.length < 32 || nextManifest.bundles.length < 4
        || nextManifest.bundles.some((bundle) => bundle.bundleId === 'planets' && bundle.formatVersion !== '1.1')) {
        throw new Error('New mixed-asset output set is incomplete or does not use RTAB 1.1 for planets.bin');
    }
    return [];
}

export async function prepareAssets({ projectRoot = PROJECT_ROOT } = {}) {
    const hasPrivateSources = await privateAssetsRootExists(projectRoot);

    if (!hasPrivateSources) {
        await assertNoPendingAssetOutputTransaction(projectRoot);
        const result = await validateCommittedAssetOutputs({ projectRoot });
        console.log(`Validated ${result.validatedBundles.length} committed RTAB bundle(s) without source changes.`);
        return { mode: 'validate-only', ...result };
    }

    return withAssetOutputLock(projectRoot, async () => {
        const { outputFiles, manifest } = await createAssetPackageOutputs({ projectRoot });
        const runtimeAssets = await createPublicSvgManifest(undefined, undefined, projectRoot);
        const runtimeManifest = renderPublicSvgManifest(runtimeAssets);
        outputFiles.set(
            path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts'),
            runtimeManifest
        );
        const stalePaths = await findStaleBundlePaths(projectRoot, manifest);
        const publication = await publishAssetOutputs({
            projectRoot,
            outputs: outputFiles,
            stalePaths,
            validatePublishedOutputs: () => validatePublishedOutputs(projectRoot, runtimeManifest)
        });
        console.log(`Packaged ${outputFiles.size} generated asset output(s) from canonical sources.`);
        return { mode: 'package', outputFiles, publication };
    });
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    prepareAssets().catch((error) => {
        console.error(`Failed to prepare assets: ${error.message}`);
        process.exitCode = 1;
    });
}

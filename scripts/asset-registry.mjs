import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_ROOTS, resolvePhysicalDir } from './asset-roots.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_ASSET_COUNT = 31;
const REQUIRED_ALIASES = new Map([
    ['assets/Ships/human-dreadnought.svg', 'human-dreadnought'],
    ['assets/Ships/alien-interceptor.svg', 'alien-interceptor'],
    ['assets/Components/Aistiaria/01_side_hull_angular.svg', 'central-hull']
]);

function fail(message) {
    throw new Error(`Invalid asset registry: ${message}`);
}

function isSafeLogicalPath(logicalPath) {
    return typeof logicalPath === 'string'
        && logicalPath.startsWith('assets/')
        && logicalPath.toLowerCase().endsWith('.svg')
        && !logicalPath.includes('\\')
        && logicalPath.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function validateAssetRegistry(registry, { expectedAssetCount } = {}) {
    if (!registry || registry.registrySchemaVersion !== '1.0') {
        fail('registrySchemaVersion must be "1.0"');
    }
    if (!Array.isArray(registry.assets) || registry.assets.length === 0) {
        fail('assets must be a non-empty array');
    }
    if (!registry.bundles || typeof registry.bundles !== 'object' || Array.isArray(registry.bundles)) {
        fail('bundles must be an object');
    }
    if (expectedAssetCount !== undefined && registry.assets.length !== expectedAssetCount) {
        fail(`expected ${expectedAssetCount} assets, found ${registry.assets.length}`);
    }

    const ids = new Set();
    const paths = new Set();
    const keys = new Map();
    const aliases = new Map();
    const bundleMembers = new Map();
    const bundleFiles = new Set();

    for (const [bundleId, bundle] of Object.entries(registry.bundles)) {
        if (!/^[a-zA-Z0-9._-]+$/.test(bundleId)) {
            fail(`invalid bundle ID "${bundleId}"`);
        }
        if (!bundle || typeof bundle.bundleFile !== 'string'
            || !bundle.bundleFile.startsWith('/assets/')
            || bundle.bundleFile.includes('\\')
            || bundle.bundleFile.split('/').slice(1).some((part) => !part || part === '.' || part === '..')
            || !bundle.bundleFile.toLowerCase().endsWith('.bin')) {
            fail(`bundle "${bundleId}" must declare a safe root-relative .bin bundleFile`);
        }
        if (bundleFiles.has(bundle.bundleFile.toLowerCase())) {
            fail(`duplicate bundle output path "${bundle.bundleFile}"`);
        }
        bundleFiles.add(bundle.bundleFile.toLowerCase());
        bundleMembers.set(bundleId, 0);
    }

    for (const asset of registry.assets) {
        if (!asset || typeof asset.assetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset.assetId)) {
            fail('every asset must have a non-empty namespaced assetId using letters, digits, dot, underscore, or hyphen');
        }
        if (ids.has(asset.assetId)) {
            fail(`duplicate asset ID "${asset.assetId}"`);
        }
        ids.add(asset.assetId);

        if (!isSafeLogicalPath(asset.logicalPath)) {
            fail(`asset "${asset.assetId}" has an invalid logicalPath`);
        }
        if (paths.has(asset.logicalPath.toLowerCase())) {
            fail(`duplicate logical path "${asset.logicalPath}"`);
        }
        paths.add(asset.logicalPath.toLowerCase());

        if (typeof asset.textureKey !== 'string' || asset.textureKey.length === 0) {
            fail(`asset "${asset.assetId}" must have an explicit textureKey`);
        }
        const normalizedKey = asset.textureKey.toLowerCase();
        if (keys.has(normalizedKey)) {
            fail(`duplicate texture key "${asset.textureKey}"`);
        }
        keys.set(normalizedKey, asset.textureKey);

        if (!Array.isArray(asset.aliases) || asset.aliases.some((alias) => typeof alias !== 'string' || !alias)) {
            fail(`asset "${asset.assetId}" aliases must be an array of non-empty strings`);
        }
        for (const alias of asset.aliases) {
            const normalizedAlias = alias.toLowerCase();
            if (keys.has(normalizedAlias)) {
                fail(`alias "${alias}" conflicts with texture key "${keys.get(normalizedAlias)}"`);
            }
            if (aliases.has(normalizedAlias)) {
                fail(`conflicting alias "${alias}" maps to multiple assets`);
            }
            aliases.set(normalizedAlias, asset.assetId);
        }

        if (asset.contentType !== 'SVG') {
            fail(`unsupported content type "${asset.contentType}" for asset "${asset.assetId}"`);
        }
        if (asset.bundleId !== undefined) {
            if (!bundleMembers.has(asset.bundleId)) {
                fail(`asset "${asset.assetId}" references undeclared bundle "${asset.bundleId}"`);
            }
            bundleMembers.set(asset.bundleId, bundleMembers.get(asset.bundleId) + 1);
        }
    }

    for (const [aliasPath, alias] of REQUIRED_ALIASES) {
        const asset = registry.assets.find((entry) => entry.logicalPath === aliasPath);
        if (!asset || asset.aliases.length !== 1 || asset.aliases[0] !== alias) {
            fail(`required alias mapping "${aliasPath}" -> "${alias}" is missing or changed`);
        }
    }
    if (aliases.size !== REQUIRED_ALIASES.size) {
        fail(`expected exactly ${REQUIRED_ALIASES.size} legacy aliases, found ${aliases.size}`);
    }
    for (const [alias, ownerId] of aliases) {
        if (keys.has(alias)) {
            fail(`alias "${alias}" conflicts with texture key "${keys.get(alias)}"`);
        }
        if (!ownerId) {
            fail(`alias "${alias}" has no asset owner`);
        }
    }

    for (const [bundleId, count] of bundleMembers) {
        if (count === 0) {
            fail(`bundle "${bundleId}" has no assigned assets`);
        }
    }

    return registry;
}

export async function readAssetRegistry(projectRoot = PROJECT_ROOT, options = {}) {
    const registryPath = path.join(projectRoot, 'scripts', 'asset-registry.json');
    let content;
    try {
        content = await readFile(registryPath, 'utf8');
    } catch (error) {
        throw new Error(`Could not read asset registry at ${registryPath}: ${error.message}`);
    }

    let registry;
    try {
        registry = JSON.parse(content);
    } catch (error) {
        throw new Error(`Could not parse asset registry at ${registryPath}: ${error.message}`);
    }

    return validateAssetRegistry(registry, {
        expectedAssetCount: options.expectedAssetCount ?? REGISTRY_ASSET_COUNT
    });
}

export function resolveAssetSource(logicalPath, projectRoot = PROJECT_ROOT) {
    const root = resolvePhysicalDir(logicalPath);
    if (!root || !isSafeLogicalPath(logicalPath)) {
        throw new Error(`Could not resolve canonical source for logical asset "${logicalPath}"`);
    }

    const rootRelative = path.relative(PROJECT_ROOT, root.physical);
    const sourceRoot = path.resolve(projectRoot, rootRelative);
    const suffix = root.logical
        ? logicalPath.slice(root.logical.length).replace(/^[/\\]/, '')
        : logicalPath;
    const sourcePath = path.resolve(sourceRoot, ...suffix.split('/'));
    if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error(`Logical asset path escapes its canonical source root: "${logicalPath}"`);
    }
    return sourcePath;
}

export { PROJECT_ROOT };

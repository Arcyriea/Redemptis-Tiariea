import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAssetSourcePath } from './asset-roots.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_ALIASES = new Map([
    ['assets/Ships/human-dreadnought.svg', 'human-dreadnought'],
    ['assets/Ships/alien-interceptor.svg', 'alien-interceptor'],
    ['assets/Components/Aistiaria/01_side_hull_angular.svg', 'central-hull']
]);

function fail(message) {
    throw new Error(`Invalid asset registry: ${message}`);
}

function isSafeLogicalPath(logicalPath, contentType) {
    const extension = contentType === 'SVG' ? '.svg' : contentType === 'PNG' ? '.png' : null;
    return extension !== null
        && typeof logicalPath === 'string'
        && logicalPath.startsWith('assets/')
        && logicalPath.endsWith(extension)
        && !logicalPath.includes('\\')
        && logicalPath.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function validateAssetRegistry(registry) {
    if (!registry || registry.registrySchemaVersion !== '1.2') {
        fail('registrySchemaVersion must be "1.2"');
    }
    if (!Array.isArray(registry.assets) || registry.assets.length === 0) {
        fail('assets must be a non-empty array');
    }
    if ('bundles' in registry) {
        fail('bundle membership is derived from source folders and must not be declared in the registry');
    }

    const ids = new Set();
    const paths = new Set();
    const keys = new Map();
    const aliases = new Map();

    for (const asset of registry.assets) {
        if (!asset || Object.keys(asset).some((key) => (
            !['assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType'].includes(key)
        ))) {
            fail('assets must contain only asset identity and runtime metadata fields');
        }
        if (!asset || typeof asset.assetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset.assetId)) {
            fail('every asset must have a non-empty namespaced assetId using letters, digits, dot, underscore, or hyphen');
        }
        if (ids.has(asset.assetId)) {
            fail(`duplicate asset ID "${asset.assetId}"`);
        }
        ids.add(asset.assetId);

        if (asset.contentType !== 'SVG' && asset.contentType !== 'PNG') {
            fail(`unsupported content type "${asset.contentType}" for asset "${asset.assetId}"`);
        }
        if (!isSafeLogicalPath(asset.logicalPath, asset.contentType)) {
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

    return registry;
}

export async function readAssetRegistry(projectRoot = PROJECT_ROOT) {
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

    return validateAssetRegistry(registry);
}

export function resolveAssetSource(logicalPath, projectRoot = PROJECT_ROOT) {
    const contentType = /\.svg$/i.test(logicalPath) ? 'SVG' : /\.png$/i.test(logicalPath) ? 'PNG' : null;
    if (!contentType || !isSafeLogicalPath(logicalPath, contentType)) {
        throw new Error(`Could not resolve canonical source for logical asset "${logicalPath}"`);
    }
    const sourcePath = resolveAssetSourcePath(logicalPath, projectRoot);
    if (!sourcePath) throw new Error(`Logical asset path escapes its canonical source root: "${logicalPath}"`);
    return sourcePath;
}

/** Resolve a real private directory or one top-level symlink/junction target. */
export async function resolvePrivateSourceRoot(projectRoot = PROJECT_ROOT) {
    const privateRoot = path.resolve(projectRoot, 'private');
    let privateInfo;
    try {
        privateInfo = await lstat(privateRoot);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }

    let realPrivateRoot;
    let privateTargetInfo;
    try {
        realPrivateRoot = await realpath(privateRoot);
        privateTargetInfo = await stat(realPrivateRoot);
    } catch (error) {
        throw new Error(`Private source root cannot be resolved: ${privateRoot}: ${error.message}`);
    }
    if (!privateTargetInfo.isDirectory()) {
        throw new Error(`Private source root target is not a directory: ${privateRoot}`);
    }

    return {
        privateRoot,
        realPrivateRoot,
        privateRootIsSymlink: privateInfo.isSymbolicLink()
    };
}

/**
 * Validate the private source root while allowing either a real directory or
 * one top-level symlink/junction to a real directory. The assets directory
 * itself must remain a real direct child so category traversal cannot escape
 * through a nested link.
 */
export async function inspectPrivateAssetsRoot(projectRoot = PROJECT_ROOT) {
    const privateRoots = await resolvePrivateSourceRoot(projectRoot);
    if (!privateRoots) return null;
    const { privateRoot, realPrivateRoot } = privateRoots;

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
        throw new Error(`Private asset source root must be a real directory: ${assetsRoot}`);
    }

    const realAssetsRoot = await realpath(assetsRoot);
    const relativeAssetsRoot = path.relative(realPrivateRoot, realAssetsRoot);
    const normalizedRelativeAssetsRoot = process.platform === 'win32'
        ? relativeAssetsRoot.toLowerCase()
        : relativeAssetsRoot;
    if (normalizedRelativeAssetsRoot !== 'assets') {
        throw new Error(`Private assets directory must resolve to the direct assets child of ${realPrivateRoot}`);
    }

    return {
        privateRoot,
        assetsRoot,
        realPrivateRoot,
        realAssetsRoot,
        privateRootIsSymlink: privateRoots.privateRootIsSymlink
    };
}

export { PROJECT_ROOT };

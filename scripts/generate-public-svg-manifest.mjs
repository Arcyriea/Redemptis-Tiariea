import { readdir, readFile, mkdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_LOGICAL_PREFIX, logicalPathToUrl } from './asset-roots.mjs';
import { readAssetRegistry, resolveAssetSource, PROJECT_ROOT } from './asset-registry.mjs';

function comparePaths(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTextureKey(relativePath) {
    const withoutExtension = relativePath.replace(/\.svg$/i, '');
    const normalized = withoutExtension
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9/_-]+/g, '-')
        .replace(/\/+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();

    return `public-${normalized || 'asset'}`;
}

function encodePublicUrl(logicalPath) {
    const url = logicalPathToUrl(logicalPath);
    if (!url) throw new Error(`Could not construct runtime URL for logical path "${logicalPath}"`);
    return url;
}

async function discoverRegisteredAssets(projectRoot) {
    const registry = await readAssetRegistry(projectRoot);
    const assets = registry.assets
        .filter((asset) => asset.contentType === 'SVG')
        .sort((left, right) => comparePaths(left.logicalPath, right.logicalPath));
    for (const asset of assets) {
        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        try {
            const sourceStat = await lstat(sourcePath);
            if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
                throw new Error('not a file');
            }
        } catch (error) {
            throw new Error(
                `Missing canonical source for registered asset "${asset.assetId}" at "${asset.logicalPath}": ${error.message}`
            );
        }
    }
    return assets;
}

/**
 * Legacy discovery: walk the explicit `assetsRoot` directory, excluding planets and
 * raster files, preserving the original ordering and URL-encoding semantics.
 *
 * @param {string} assetsRoot - e.g. `path.join(projectRoot, 'public', 'assets')`
 * @returns {Promise<string[]>}
 */
async function discoverRelativeSvgPathsLegacy(assetsRoot) {
    const rootEntries = await readdir(assetsRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Public assets directory does not exist: ${assetsRoot}`);
        }
        throw error;
    });

    const files = [];
    async function walk(directory, relativeDirectory = '') {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => comparePaths(left.name, right.name));

        for (const entry of entries) {
            if (entry.isDirectory() && !relativeDirectory && entry.name.toLowerCase() === 'planets') {
                continue;
            }

            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;

            if (entry.isDirectory()) {
                await walk(path.join(directory, entry.name), relativePath);
            } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
                files.push(relativePath);
            }
        }
    }

    await walk(assetsRoot, '');
    return files.sort(comparePaths);
}

function resolveTextureKeys(relativePaths) {
    const groups = new Map();
    for (const relativePath of relativePaths) {
        const key = normalizeTextureKey(relativePath);
        const normalizedKey = key.toLowerCase();
        const group = groups.get(normalizedKey) ?? [];
        group.push({ relativePath, key });
        groups.set(normalizedKey, group);
    }

    const resolved = new Map();
    for (const group of groups.values()) {
        if (group.length > 1) {
            console.warn(
                `Normalized public SVG texture-key collision for: ${group.map(({ relativePath }) => relativePath).join(', ')}`
            );
        }

        for (const { relativePath, key } of group) {
            const suffix = group.length > 1
                ? `-${createHash('sha256').update(relativePath).digest('hex').slice(0, 10)}`
                : '';
            resolved.set(relativePath, `${key}${suffix}`);
        }
    }

    const usedKeys = new Map();
    for (const [relativePath, key] of resolved) {
        const normalizedKey = key.toLowerCase();
        const conflictingPath = usedKeys.get(normalizedKey);
        if (conflictingPath) {
            throw new Error(
                `Unable to safely resolve public SVG texture-key collision: ${conflictingPath} and ${relativePath} both map to "${key}"`
            );
        }
        usedKeys.set(normalizedKey, relativePath);
    }

    return resolved;
}

export async function createPublicSvgManifest(assetsRoot, outputFile, projectRoot = PROJECT_ROOT) {
    let assets;
    if (assetsRoot) {
        const relativePaths = await discoverRelativeSvgPathsLegacy(assetsRoot);
        const textureKeys = resolveTextureKeys(relativePaths);
        const registry = await readAssetRegistry(projectRoot);
        const aliasesByPath = new Map(registry.assets.map((asset) => [
            asset.logicalPath.slice(`${ASSETS_LOGICAL_PREFIX}/`.length),
            asset.aliases
        ]));
        assets = relativePaths.map((relativePath) => ({
            key: textureKeys.get(relativePath),
            url: encodePublicUrl(`${ASSETS_LOGICAL_PREFIX}/${relativePath}`),
            aliases: aliasesByPath.get(relativePath) ?? []
        }));
    } else {
        const registeredAssets = await discoverRegisteredAssets(projectRoot);
        assets = registeredAssets.map((asset) => ({
            key: asset.textureKey,
            url: encodePublicUrl(asset.logicalPath),
            aliases: asset.aliases
        }));
    }

    const assetByAlias = new Map();
    const keyOwners = new Map(assets.map((asset) => [asset.key.toLowerCase(), asset.key]));
    for (const asset of assets) {
        for (const alias of asset.aliases) {
            const normalizedAlias = alias.toLowerCase();
            if (keyOwners.has(normalizedAlias) || assetByAlias.has(normalizedAlias)) {
                const conflictingKey = keyOwners.get(normalizedAlias) ?? assetByAlias.get(normalizedAlias);
                throw new Error(
                    `Public SVG legacy alias "${alias}" for "${asset.url}" conflicts with texture key "${conflictingKey}"`
                );
            }
            assetByAlias.set(normalizedAlias, asset.key);
        }
    }
    return assets;
}

export function renderPublicSvgManifest(assets) {
    return [
        'export interface PublicSvgTexture {',
        '    readonly key: string;',
        '    readonly url: string;',
        '    readonly aliases: readonly string[];',
        '}',
        '',
        'export const publicSvgTextures: readonly PublicSvgTexture[] = ',
        `${JSON.stringify(assets, null, 4)};`,
        ''
    ].join('\n');
}

export async function generatePublicSvgManifest(assetsRoot, outputFile, projectRoot = PROJECT_ROOT) {
    const assets = await createPublicSvgManifest(assetsRoot, undefined, projectRoot);
    const content = renderPublicSvgManifest(assets);

    const targetFile = outputFile ?? path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts');
    await mkdir(path.dirname(targetFile), { recursive: true });
    let existingContent;
    try {
        existingContent = await readFile(targetFile, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (existingContent !== content) {
        await writeFile(targetFile, content, 'utf8');
    }

    console.log(`Discovered ${assets.length} public SVG texture(s).`);
    return assets.length;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    import('./prepare-assets.mjs')
        .then(({ prepareAssets }) => prepareAssets())
        .catch((error) => {
        console.error(`Failed to prepare assets: ${error.message}`);
        process.exitCode = 1;
    });
}

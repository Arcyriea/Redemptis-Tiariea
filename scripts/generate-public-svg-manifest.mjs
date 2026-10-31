import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_ALIASES = new Map([
    ['Ships/human-dreadnought.svg', ['human-dreadnought']],
    ['Ships/alien-interceptor.svg', ['alien-interceptor']],
    ['Components/Aistiaria/01_side_hull_angular.svg', ['central-hull']]
]);

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

function encodePublicUrl(relativePath) {
    const encodedPath = relativePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

    return `/assets/${encodedPath}`;
}

async function discoverRelativeSvgPaths(assetsRoot) {
    const rootEntries = await readdir(assetsRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') {
            throw new Error(`Public assets directory does not exist: ${assetsRoot}`);
        }
        throw error;
    });

    const files = [];
    async function walk(directory, relativeDirectory = '', entries) {
        entries ??= await readdir(directory, { withFileTypes: true });
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

    await walk(assetsRoot, '', rootEntries);
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

export async function createPublicSvgManifest(assetsRoot) {
    const relativePaths = await discoverRelativeSvgPaths(assetsRoot);
    const textureKeys = resolveTextureKeys(relativePaths);
    const assets = relativePaths.map((relativePath) => ({
        key: textureKeys.get(relativePath),
        url: encodePublicUrl(relativePath),
        aliases: LEGACY_ALIASES.get(relativePath) ?? []
    }));

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

export async function generatePublicSvgManifest(assetsRoot, outputFile) {
    const assets = await createPublicSvgManifest(assetsRoot);
    const content = [
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

    await mkdir(path.dirname(outputFile), { recursive: true });
    let existingContent;
    try {
        existingContent = await readFile(outputFile, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (existingContent !== content) {
        await writeFile(outputFile, content, 'utf8');
    }

    console.log(`Discovered ${assets.length} public SVG texture(s).`);
    return assets.length;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const projectRoot = path.resolve(path.dirname(scriptPath), '..');
    const assetsRoot = path.join(projectRoot, 'public', 'assets');
    const outputFile = path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts');

    generatePublicSvgManifest(assetsRoot, outputFile).catch((error) => {
        console.error(`Failed to generate public SVG manifest: ${error.message}`);
        process.exitCode = 1;
    });
}

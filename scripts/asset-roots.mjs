import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Canonical source mapping: logical asset path -> physical source directory.
 *
 * Each entry maps a logical asset prefix to the physical directory that currently
 * holds its source artwork, plus the runtime URL prefix the game consumes.
 *
 * During the partial migration exactly one root owns each logical asset. Overlapping
 * physical directories are intentionally avoided: the root-level `public` entry is
 * non-recursive so it cannot rescan artwork already owned by `assets/` or `minimap/`.
 *
 * Physical paths are absolute; logical paths and runtime URLs are repository-relative.
 */
export const ASSET_SOURCE_ROOTS = Object.freeze([
    {
        physical: path.join(PROJECT_ROOT, 'private', 'assets'),
        logical: 'assets',
        urlPrefix: '/assets',
        recursive: true
    },
    {
        physical: path.join(PROJECT_ROOT, 'public', 'minimap'),
        logical: 'minimap',
        urlPrefix: '/minimap',
        recursive: true
    },
    {
        physical: path.join(PROJECT_ROOT, 'public'),
        logical: '',
        urlPrefix: '',
        recursive: false
    }
]);

// Backward-compatible name for existing package and runtime tooling.
export const ASSET_ROOTS = ASSET_SOURCE_ROOTS;

/** Prefix that identifies assets served through the public SVG manifest. */
export const ASSETS_LOGICAL_PREFIX = 'assets';

async function readDirSorted(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return entries;
}

/**
 * Walk every source root and return the canonical source record for each SVG.
 *
 * @returns {Promise<Array<{ logicalPath: string, physicalPath: string, root: object }>>}
 */
export async function listSourceAssets() {
    const results = [];

    for (const root of ASSET_ROOTS) {
        if (root.recursive === false) {
            const entries = await readDirSorted(root.physical);
            for (const entry of entries) {
                if (entry.isFile() && /\.svg$/i.test(entry.name)) {
                    const logicalPath = root.logical ? `${root.logical}/${entry.name}` : entry.name;
                    results.push({
                        logicalPath,
                        physicalPath: path.join(root.physical, entry.name),
                        root
                    });
                }
            }
            continue;
        }

        async function walk(directory, relativePath) {
            const entries = await readDirSorted(directory);
            for (const entry of entries) {
                const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(path.join(directory, entry.name), childRelative);
                } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
                    const logicalPath = root.logical ? `${root.logical}/${childRelative}` : childRelative;
                    results.push({
                        logicalPath,
                        physicalPath: path.join(directory, entry.name),
                        root
                    });
                }
            }
        }

        await walk(root.physical, '');
    }

    return results;
}

export function resolveAssetSourcePath(logicalPath, projectRoot = PROJECT_ROOT) {
    if (typeof logicalPath !== 'string' || logicalPath.includes('\\') || logicalPath.startsWith('/')) {
        return null;
    }
    const segments = logicalPath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    const root = resolvePhysicalDir(logicalPath);
    if (!root) return null;
    const rootRelative = path.relative(PROJECT_ROOT, root.physical);
    const sourceRoot = path.resolve(projectRoot, rootRelative);
    const suffix = root.logical
        ? logicalPath.slice(root.logical.length).replace(/^\//, '')
        : logicalPath;
    const sourcePath = path.resolve(sourceRoot, ...suffix.split('/'));
    if (sourcePath !== sourceRoot && !sourcePath.startsWith(`${sourceRoot}${path.sep}`)) return null;
    return sourcePath;
}

/**
 * Resolve the physical source directory responsible for a logical asset path.
 * Longest-match wins so `assets/Components/...` is not claimed by the `assets/` root.
 *
 * @returns {{ physical: string, logical: string, urlPrefix: string } | null}
 */
export function resolvePhysicalDir(logicalPath) {
    if (typeof logicalPath !== 'string' || logicalPath.includes('\\') || logicalPath.startsWith('/')) {
        return null;
    }
    const segments = logicalPath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    let best = null;
    for (const root of ASSET_ROOTS) {
        const prefix = root.logical ? `${root.logical}/` : null;
        const matches = prefix ? logicalPath.startsWith(prefix) : true;
        if (!matches) {
            continue;
        }
        if (!best || (prefix && prefix.length > (best.logical ? best.logical.length : 0))) {
            best = root;
        }
    }
    return best;
}

/**
 * Convert a logical asset path to the runtime URL the game loads it from.
 *
 * @param {string} logicalPath - e.g. `assets/Ships/human-dreadnought.svg`
 * @returns {string | null}
 */
export function logicalPathToUrl(logicalPath) {
    const root = resolvePhysicalDir(logicalPath);
    if (!root) {
        return null;
    }

    const suffix = root.logical
        ? logicalPath.slice(root.logical.length).replace(/^\//, '')
        : logicalPath;
    const encodedSuffix = suffix.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    if (!root.urlPrefix) return `/${encodedSuffix}`;
    return `${root.urlPrefix}/${encodedSuffix}`;
}

/**
 * Return the path of a logical asset relative to the `assets/` logical root.
 * This is the stable input used for texture-key normalization.
 *
 * @param {string} logicalPath
 * @returns {string | null}
 */
export function assetsRelativePath(logicalPath) {
    if (!logicalPath.startsWith(`${ASSETS_LOGICAL_PREFIX}/`)) {
        return null;
    }
    return logicalPath.slice(`${ASSETS_LOGICAL_PREFIX}/`.length);
}

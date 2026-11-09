import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetPackageOutputs, validateCommittedAssetOutputs } from './package-assets.mjs';
import { createPublicSvgManifest, renderPublicSvgManifest } from './generate-public-svg-manifest.mjs';
import { PROJECT_ROOT } from './asset-registry.mjs';
import {
    assertNoPendingAssetOutputTransaction,
    publishAssetOutputs,
    withAssetOutputLock
} from './asset-output-publisher.mjs';

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

async function findStaleBundlePaths(projectRoot, nextManifest) {
    const publicRoot = path.join(projectRoot, 'public');
    const currentPaths = new Set(nextManifest.bundles.map((bundle) => bundle.bundleFile.toLowerCase()));
    const stale = new Set();
    const legacyNestedShips = path.join(publicRoot, 'assets', 'Ships', 'ships.bin');
    const oldManifestPath = path.join(publicRoot, 'assets', 'asset-manifest.json');
    let oldManifest;
    try {
        oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error(`Could not inspect previous asset manifest for stale outputs: ${error.message}`);
        }
    }

    if (oldManifest !== undefined) {
        if (!oldManifest || !Array.isArray(oldManifest.bundles)) {
            throw new Error('Previous asset manifest does not declare a bundle list; refusing stale-output cleanup');
        }
        for (const bundle of oldManifest.bundles) {
            if (typeof bundle.bundleFile !== 'string'
                || !bundle.bundleFile.startsWith('/assets/')
                || bundle.bundleFile.includes('\\')
                || !bundle.bundleFile.toLowerCase().endsWith('.bin')
                || bundle.bundleFile.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
                throw new Error('Previous asset manifest contains an unsafe bundle path; refusing stale-output cleanup');
            }
            if (!currentPaths.has(bundle.bundleFile.toLowerCase())) {
                const destination = path.resolve(publicRoot, `.${bundle.bundleFile}`);
                if (!destination.startsWith(`${publicRoot}${path.sep}`)) {
                    throw new Error(`Previous bundle path escapes public output root: ${bundle.bundleFile}`);
                }
                if (typeof bundle.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.bundleSha256)) {
                    throw new Error(`Previous bundle "${bundle.bundleFile}" has no valid SHA-256; refusing stale-output cleanup`);
                }
                const info = await lstat(destination).catch((error) => {
                    if (error.code === 'ENOENT') {
                        return null;
                    }
                    throw error;
                });
                if (info) {
                    if (info.isSymbolicLink() || !info.isFile()) {
                        throw new Error(`Previous bundle is not a regular file: ${destination}`);
                    }
                    const bytes = await readFile(destination);
                    if (createHash('sha256').update(bytes).digest('hex') !== bundle.bundleSha256) {
                        throw new Error(`Previous bundle hash does not match its manifest; refusing stale-output cleanup: ${destination}`);
                    }
                }
                stale.add(destination);
            }
        }
    } else {
        const legacyInfo = await lstat(legacyNestedShips).catch((error) => {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (legacyInfo) {
            throw new Error(`Legacy Ships bundle has no prior manifest ownership record; preserving it: ${legacyNestedShips}`);
        }
    }
    return [...stale];
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

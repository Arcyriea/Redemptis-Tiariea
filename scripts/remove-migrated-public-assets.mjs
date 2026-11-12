#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, readAssetRegistry, resolveAssetSource } from './asset-registry.mjs';
import { readPlanetApprovals } from './asset-contract.mjs';
import { validateCommittedAssetOutputs } from './package-assets.mjs';

const CATEGORIES = new Map([
    ['ships', 'Ships'],
    ['components', 'Components'],
    ['turrets-platforms', 'Turrets-Platforms'],
    ['planets', 'Planets']
]);
const EXCLUDED_PUBLIC_FILES = new Set(['Map-111-2.png', 'Map-122-2.png']);

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function readRegularFile(filePath, label) {
    let info;
    try {
        info = await lstat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    const bytes = await readFile(filePath);
    if (bytes.length !== info.size) throw new Error(`${label} changed while being read: ${filePath}`);
    return bytes;
}

async function findSourceFetchReferences(projectRoot, logicalPath) {
    const encodedPath = logicalPath.split('/').map(encodeURIComponent).join('/');
    const url = `/${encodedPath}`;
    const matches = [];
    const roots = [path.join(projectRoot, 'src')];
    const seen = new Set();
    async function walk(filePath) {
        const info = await lstat(filePath);
        if (info.isSymbolicLink()) return;
        if (info.isDirectory()) {
            for (const entry of await readdir(filePath, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'private') continue;
                await walk(path.join(filePath, entry.name));
            }
            return;
        }
        if (!info.isFile() || !/\.(?:ts|tsx|js|mjs|html|css)$/i.test(filePath)) return;
        const relative = path.relative(projectRoot, filePath).replaceAll('\\', '/');
        if (relative === 'src/generated/publicSvgManifest.ts'
            || relative === 'src/generated/runtimeAssetContract.ts' || seen.has(filePath)) return;
        seen.add(filePath);
        const content = await readFile(filePath, 'utf8');
        if (content.includes(url) || content.includes(logicalPath)) matches.push(relative);
    }
    for (const root of roots) {
        try {
            await walk(root);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    for (const name of ['index.html']) {
        const filePath = path.join(projectRoot, name);
        const content = await readFile(filePath, 'utf8').catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (content && (content.includes(url) || content.includes(logicalPath))) matches.push(name);
    }
    for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.css$/i.test(entry.name)) continue;
        const content = await readFile(path.join(projectRoot, entry.name), 'utf8');
        if (content.includes(url) || content.includes(logicalPath)) matches.push(entry.name);
    }
    return [...new Set(matches)].sort();
}

function categoryAssets(manifest, category) {
    const directory = CATEGORIES.get(category);
    if (!directory) throw new Error(`Unknown migration category "${category}".`);
    return manifest.assets.filter((asset) => asset.logicalPath.startsWith(`assets/${directory}/`));
}

/** Verify and optionally remove only the exact registered public duplicates for one category. */
export async function removeVerifiedPublicDuplicates({
    projectRoot = PROJECT_ROOT,
    category,
    apply = false
} = {}) {
    if (!CATEGORIES.has(category)) throw new Error(`Specify one category: ${[...CATEGORIES.keys()].join(', ')}.`);
    const { manifest, validatedBundles } = await validateCommittedAssetOutputs({ projectRoot });
    const registry = await readAssetRegistry(projectRoot);
    const registryByPath = new Map(registry.assets.map((asset) => [asset.logicalPath, asset]));
    const approvals = await readPlanetApprovals(projectRoot);
    const expected = categoryAssets(manifest, category);
    if (expected.length === 0) throw new Error(`No committed assets were found for category "${category}".`);
    const plan = [];

    for (const asset of expected) {
        const bundle = manifest.bundles.find((entry) => entry.bundleId === asset.bundleId);
        if (!bundle || !validatedBundles.includes(bundle.bundleId)) {
            throw new Error(`Committed bundle membership is not validated for "${asset.logicalPath}".`);
        }
        if (asset.contentType === 'SVG') {
            const registered = registryByPath.get(asset.logicalPath);
            if (!registered || registered.assetId !== asset.assetId || registered.textureKey !== asset.textureKey
                || JSON.stringify(registered.aliases) !== JSON.stringify(asset.aliases)) {
                throw new Error(`Runtime identity is not represented by the canonical registry: ${asset.logicalPath}`);
            }
        } else if (asset.contentType === 'PNG' && approvals.get(asset.logicalPath) !== asset.sourceSha256) {
            throw new Error(`Planet fingerprint is not independently approved: ${asset.logicalPath}`);
        }

        const sourcePath = resolveAssetSource(asset.logicalPath, projectRoot);
        const publicPath = path.join(projectRoot, 'public', ...asset.logicalPath.split('/'));
        const source = await readRegularFile(sourcePath, 'Canonical private source');
        if (!source) throw new Error(`Canonical private source is missing; preserving ${publicPath}.`);
        if (digest(source) !== asset.sourceSha256) {
            throw new Error(`Canonical private source fingerprint differs from the committed manifest: ${asset.logicalPath}`);
        }
        if (asset.contentType === 'PNG' && digest(source) !== approvals.get(asset.logicalPath)) {
            throw new Error(`Canonical private planet source differs from its approved fingerprint: ${asset.logicalPath}`);
        }
        const publicBytes = await readRegularFile(publicPath, 'Public duplicate');
        if (!publicBytes) {
            plan.push({ asset, sourcePath, publicPath, sourceHash: digest(source), publicHash: null, alreadyAbsent: true });
            continue;
        }
        if (digest(publicBytes) !== digest(source)) {
            throw new Error(`Public and canonical source hashes differ; preserving ${publicPath}.`);
        }
        const references = await findSourceFetchReferences(projectRoot, asset.logicalPath);
        if (references.length) {
            throw new Error(`Loose public asset is still referenced by ${references.join(', ')}; preserving ${publicPath}.`);
        }
        plan.push({ asset, sourcePath, publicPath, sourceHash: digest(source), publicHash: digest(publicBytes), alreadyAbsent: false });
    }

    if (!apply) return { category, assets: expected.length, removed: [], plan };

    // Recheck the complete set before the first unlink so a changed file stops the category before deletion.
    for (const entry of plan) {
        if (entry.alreadyAbsent) continue;
        const source = await readRegularFile(entry.sourcePath, 'Canonical private source');
        const publicBytes = await readRegularFile(entry.publicPath, 'Public duplicate');
        if (!source || !publicBytes || digest(source) !== entry.sourceHash || digest(publicBytes) !== entry.publicHash
            || digest(source) !== digest(publicBytes)) {
            throw new Error(`Asset changed after migration preflight; preserving category "${category}".`);
        }
    }
    const removed = [];
    for (const entry of plan) {
        if (entry.alreadyAbsent) continue;
        if (EXCLUDED_PUBLIC_FILES.has(path.basename(entry.publicPath))) {
            throw new Error(`Refusing to remove explicitly excluded asset ${entry.publicPath}.`);
        }
        await unlink(entry.publicPath);
        removed.push(entry.publicPath);
    }
    return { category, assets: expected.length, removed, plan };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const categoryIndex = process.argv.indexOf('--category');
    const category = categoryIndex >= 0 ? process.argv[categoryIndex + 1] : undefined;
    const apply = process.argv.includes('--apply');
    removeVerifiedPublicDuplicates({ category, apply }).then((result) => {
        if (apply) console.log(`Removed ${result.removed.length} verified public duplicate(s) from ${result.category}.`);
        else console.log(`Dry run: ${result.plan.filter((entry) => !entry.alreadyAbsent).length} verified public duplicate(s) can be removed from ${result.category}.`);
    }).catch((error) => {
        console.error(`Public asset migration stopped: ${error.message}`);
        process.exitCode = 1;
    });
}

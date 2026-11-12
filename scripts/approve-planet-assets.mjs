import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePlanetIdentity } from './asset-contract.mjs';
import { assertPngAggregateLimits, PNG_LIMITS, validatePng } from './validate-png.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function inspectPlanetApprovals(projectRoot = PROJECT_ROOT) {
    const planetsDir = path.join(projectRoot, 'private', 'assets', 'Planets');
    const approvalPath = path.join(projectRoot, 'scripts', 'planet-asset-approvals.json');
    const current = JSON.parse(await readFile(approvalPath, 'utf8'));
    const currentMap = new Map(Object.entries(current.approvals ?? {}));
    const directoryInfo = await lstat(planetsDir);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error(`Planet source directory is not a real directory: ${planetsDir}`);
    }
    const entries = await readdir(planetsDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const found = new Map();
    const assetIds = new Set();
    const textureKeys = new Set();
    let aggregateFileBytes = 0;
    let aggregateDecodedBytes = 0;
    let aggregateScanlineBytes = 0;
    for (const entry of entries) {
        if (!entry.isFile()) throw new Error(`Planet source entry is not a regular file: ${entry.name}`);
        const identity = derivePlanetIdentity(entry.name);
        if (assetIds.has(identity.assetId)) {
            throw new Error(`Planet filenames derive the same asset ID "${identity.assetId}".`);
        }
        if (textureKeys.has(identity.textureKey)) {
            throw new Error(`Planet filenames derive the same texture key "${identity.textureKey}".`);
        }
        assetIds.add(identity.assetId);
        textureKeys.add(identity.textureKey);
        const fullPath = path.join(planetsDir, entry.name);
        const info = await lstat(fullPath);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Planet source is not a regular file: ${fullPath}`);
        const bytes = await readFile(fullPath);
        if (bytes.length !== info.size) throw new Error(`Planet source changed while being read: ${identity.logicalPath}`);
        const png = await validatePng(bytes, identity);
        if (png.width !== 2000 || png.height !== 1000) {
            throw new Error(`Planet ${identity.logicalPath} must be 2000x1000, got ${png.width}x${png.height}`);
        }
        aggregateFileBytes += png.fileBytes;
        aggregateDecodedBytes += png.decodedPixelBytes;
        aggregateScanlineBytes += png.scanlineBytes;
        assertPngAggregateLimits(aggregateFileBytes, aggregateDecodedBytes, aggregateScanlineBytes, 'Planet PNG assets', PNG_LIMITS);
        found.set(identity.logicalPath, createHash('sha256').update(bytes).digest('hex'));
    }
    const changes = [];
    for (const [logicalPath, hash] of found) {
        if (currentMap.get(logicalPath) !== hash) changes.push({ logicalPath, prior: currentMap.get(logicalPath) ?? null, hash });
    }
    const stale = [...currentMap.keys()].filter((logicalPath) => !found.has(logicalPath));
    return { currentMap, found, changes, stale };
}

export async function approvePlanetAssets({ projectRoot = PROJECT_ROOT, apply = false, prune = false } = {}) {
    const report = await inspectPlanetApprovals(projectRoot);
    for (const change of report.changes) {
        console.log(`${change.prior ? 'CHANGED' : 'NEW'} ${change.logicalPath}: ${change.hash}`);
    }
    for (const logicalPath of report.stale) console.log(`STALE ${logicalPath}`);
    if (!apply) {
        console.log('Preview only. Pass --apply to approve listed current source hashes.');
        return report;
    }
    if (report.stale.length && !prune) {
        throw new Error('Stale approvals exist; use the explicit --prune option to remove them.');
    }
    const approvals = Object.fromEntries([...report.found].sort(([a], [b]) => a.localeCompare(b)));
    if (!prune) {
        for (const logicalPath of report.stale) approvals[logicalPath] = report.currentMap.get(logicalPath);
    }
    const target = path.join(projectRoot, 'scripts', 'planet-asset-approvals.json');
    const temporary = `${target}.approval-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ approvalSchemaVersion: '1', approvals }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
    console.log(`Updated ${path.relative(projectRoot, target).split(path.sep).join('/')}.`);
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    approvePlanetAssets({ apply: process.argv.includes('--apply'), prune: process.argv.includes('--prune') })
        .catch((error) => {
            console.error(`Planet approval failed: ${error.message}`);
            process.exitCode = 1;
        });
}

import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './asset-registry.mjs';
import { validatePng } from './validate-png.mjs';

const PLANET_ASSETS = Object.freeze([
    { assetId: 'rt.planet-map.map-111', logicalPath: 'assets/Planets/Map-111.png', textureKey: 'planetMap111' },
    { assetId: 'rt.planet-map.map-122', logicalPath: 'assets/Planets/Map-122.png', textureKey: 'planetMap122' },
    { assetId: 'rt.planet-map.map-692', logicalPath: 'assets/Planets/Map-692.png', textureKey: 'planetMap692' }
]);

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
    throw new Error(`Planet asset migration failed: ${message}`);
}

async function assertRealDirectory(directory, label, { allowMissing = false } = {}) {
    let info;
    try {
        info = await lstat(directory);
    } catch (error) {
        if (allowMissing && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        fail(`${label} must be a real directory: ${directory}`);
    }
    return info;
}

async function assertExactEntryName(parent, expectedName, label) {
    const entries = await readdir(parent, { withFileTypes: true });
    const match = entries.find((entry) => entry.name.toLowerCase() === expectedName.toLowerCase());
    if (match && match.name !== expectedName) {
        fail(`${label} casing differs: expected "${expectedName}", found "${match.name}"`);
    }
}

async function readRegularFile(filePath, label) {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
        fail(`${label} must be a regular file: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    if (bytes.length !== info.size) {
        fail(`${label} changed while being read: ${filePath}`);
    }
    return { bytes, info };
}

async function inspectPlan(projectRoot) {
    const publicRoot = path.join(projectRoot, 'public');
    const publicAssets = path.join(publicRoot, 'assets');
    const publicPlanets = path.join(publicAssets, 'Planets');
    const privateRoot = path.join(projectRoot, 'private');
    const privateAssets = path.join(privateRoot, 'assets');
    const privatePlanets = path.join(privateAssets, 'Planets');
    await assertRealDirectory(publicRoot, 'public');
    await assertRealDirectory(publicAssets, 'public/assets');
    await assertExactEntryName(publicAssets, 'Planets', 'public asset category');
    await assertRealDirectory(publicPlanets, 'public/assets/Planets');
    await assertRealDirectory(privateRoot, 'private');
    const privateAssetsInfo = await assertRealDirectory(privateAssets, 'private/assets');
    await assertExactEntryName(privateAssets, 'Planets', 'private asset category');
    const privatePlanetsExists = await assertRealDirectory(privatePlanets, 'private/assets/Planets', { allowMissing: true });

    const existingEntries = privatePlanetsExists
        ? await readdir(privatePlanets, { withFileTypes: true })
        : [];
    const existingByLower = new Map();
    for (const entry of existingEntries) {
        const existingPath = path.join(privatePlanets, entry.name);
        const info = await lstat(existingPath);
        if (info.isSymbolicLink() || !info.isFile()) {
            fail(`private planet source must be a regular file: ${existingPath}`);
        }
        const lower = entry.name.toLowerCase();
        if (existingByLower.has(lower)) {
            fail(`private Planets directory has a case-insensitive collision: ${entry.name}`);
        }
        existingByLower.set(lower, entry.name);
    }
    for (const [filename, actual] of existingByLower) {
        if (!PLANET_ASSETS.some((asset) => path.posix.basename(asset.logicalPath).toLowerCase() === filename)) {
            fail(`private Planets directory contains an unapproved asset: ${actual}`);
        }
    }

    const records = [];
    for (const expected of PLANET_ASSETS) {
        const filename = path.posix.basename(expected.logicalPath);
        await assertExactEntryName(publicPlanets, filename, 'public planet source');
        const caseVariant = existingByLower.get(filename.toLowerCase());
        if (caseVariant && caseVariant !== filename) {
            fail(`private destination filename casing differs: expected "${filename}", found "${caseVariant}"`);
        }
        const sourcePath = path.join(publicPlanets, filename);
        const source = await readRegularFile(sourcePath, 'public source');
        const pngInfo = await validatePng(source.bytes, expected);
        const destinationPath = path.join(privatePlanets, filename);
        let alreadyPresent = false;
        if (caseVariant) {
            const existing = await readRegularFile(destinationPath, 'existing private destination');
            if (sha256(existing.bytes) !== sha256(source.bytes)) {
                fail(`existing private file differs from its public source and will not be overwritten: ${expected.logicalPath}`);
            }
            alreadyPresent = true;
        }
        records.push({
            ...expected,
            filename,
            sourcePath,
            destinationPath,
            bytes: source.bytes,
            sourceSha256: sha256(source.bytes),
            decodedBytes: pngInfo.scanlineBytes,
            alreadyPresent
        });
    }
    return { records, privateRoot, privateAssets, privateAssetsInfo, privatePlanets };
}

async function copyToStage(records, stagingRoot) {
    const stagingPlanets = path.join(stagingRoot, 'Planets');
    await mkdir(stagingPlanets);
    for (const record of records) {
        const stagedPath = path.join(stagingPlanets, record.filename);
        await copyFile(record.sourcePath, stagedPath, fsConstants.COPYFILE_EXCL);
        const staged = await readRegularFile(stagedPath, 'staged source');
        if (sha256(staged.bytes) !== record.sourceSha256) {
            fail(`staged SHA-256 mismatch for ${record.logicalPath}`);
        }
        await validatePng(staged.bytes, record);
        record.stagedPath = stagedPath;
    }
}

async function removeInstalledCopies(installed) {
    const errors = [];
    for (const entry of [...installed].reverse()) {
        try {
            const [destinationInfo, stageInfo] = await Promise.all([
                lstat(entry.destinationPath),
                lstat(entry.stagedPath)
            ]);
            if (destinationInfo.dev !== stageInfo.dev || destinationInfo.ino !== stageInfo.ino) {
                throw new Error(`destination no longer matches this migration's staged file: ${entry.destinationPath}`);
            }
            await rm(entry.destinationPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                errors.push(error);
            }
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, 'Planet asset installation failed and rollback was incomplete');
    }
}

export async function migratePlanetAssetsPrivate({
    projectRoot = PROJECT_ROOT,
    apply = false,
    publishLink = link
} = {}) {
    const plan = await inspectPlan(projectRoot);
    const copyRecords = plan.records.filter((record) => !record.alreadyPresent);
    const report = {
        mode: apply ? 'apply' : 'dry-run',
        assetCount: plan.records.length,
        existingPrivateCount: plan.records.filter((record) => record.alreadyPresent).length,
        filesToCopy: copyRecords.length,
        copyBytes: copyRecords.reduce((total, record) => total + record.bytes.length, 0),
        decodedBytes: plan.records.reduce((total, record) => total + record.decodedBytes, 0),
        assets: plan.records.map((record) => ({
            assetId: record.assetId,
            logicalPath: record.logicalPath,
            textureKey: record.textureKey,
            bytes: record.bytes.length,
            sha256: record.sourceSha256,
            alreadyPresent: record.alreadyPresent
        }))
    };
    if (!apply) {
        return report;
    }

    const stagingRoot = path.join(plan.privateRoot, `.planet-asset-migration-${randomUUID()}`);
    const installed = [];
    try {
        await mkdir(stagingRoot);
        const stagingInfo = await lstat(stagingRoot);
        if (stagingInfo.dev !== plan.privateAssetsInfo.dev) {
            fail('staging directory is not on the same filesystem as private/assets');
        }
        await copyToStage(copyRecords, stagingRoot);
        if (!await assertRealDirectory(plan.privatePlanets, 'private/assets/Planets', { allowMissing: true })) {
            await mkdir(plan.privatePlanets);
        }
        await assertRealDirectory(plan.privatePlanets, 'private/assets/Planets');

        for (const record of copyRecords) {
            const currentSource = await readRegularFile(record.sourcePath, 'public source');
            if (sha256(currentSource.bytes) !== record.sourceSha256) {
                fail(`public source changed during migration: ${record.logicalPath}`);
            }
            try {
                await publishLink(record.stagedPath, record.destinationPath);
                installed.push(record);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
                const existing = await readRegularFile(record.destinationPath, 'concurrent private destination');
                if (sha256(existing.bytes) !== record.sourceSha256) {
                    fail(`private destination appeared with different bytes and will not be overwritten: ${record.logicalPath}`);
                }
            }
        }

        for (const record of plan.records) {
            const privateFile = await readRegularFile(record.destinationPath, 'verified private source');
            if (sha256(privateFile.bytes) !== record.sourceSha256) {
                fail(`private source failed final SHA-256 verification: ${record.logicalPath}`);
            }
        }
        report.mode = 'migrated';
        return report;
    } catch (error) {
        try {
            await removeInstalledCopies(installed);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Planet asset migration failed and rollback was incomplete');
        }
        throw error;
    } finally {
        await rm(stagingRoot, { recursive: true, force: true });
    }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const apply = process.argv.slice(2).includes('--apply');
    migratePlanetAssetsPrivate({ apply })
        .then((report) => {
            console.log(JSON.stringify(report, null, 2));
            if (report.mode === 'dry-run') {
                console.log('Dry run only. Re-run with --apply to copy the approved planet PNGs.');
            }
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

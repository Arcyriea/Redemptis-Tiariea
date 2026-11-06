import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    copyFile,
    link,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readAssetRegistry, PROJECT_ROOT } from './asset-registry.mjs';

const execFileAsync = promisify(execFile);
const EXPECTED_ASSET_COUNT = 31;
const EXPECTED_PRIVATE_COPY_COUNT = 21;
const EXPECTED_SHIP_COUNT = 10;
const EXPECTED_PRIVATE_COPY_PATHS = new Set([
    'assets/Components/Aistiaria/01_side_hull_angular.svg',
    'assets/Components/Aistiaria/02_hex_cockpit.svg',
    'assets/Components/Aistiaria/03_side_wing.svg',
    'assets/Components/Aistiaria/04_rear_engine_pod.svg',
    'assets/Components/Aistiaria/05_nose_section.svg',
    'assets/Components/Aistiaria/06_swept_wing.svg',
    'assets/Components/Aistiaria/07_connector_module.svg',
    'assets/Components/Aistiaria/08_tail_fuselage.svg',
    'assets/Components/Yutiarin/Part 1.svg',
    'assets/Components/Yutiarin/Part 2.svg',
    'assets/Components/Yutiarin/Part 3.svg',
    'assets/Components/Yutiarin/Part 4.svg',
    'assets/Components/Yutiarin/Part 5.svg',
    'assets/Components/Yutiarin/Part 6.svg',
    'assets/Components/Yutiarin/Part 7.svg',
    'assets/Components/Yutiarin/Part 8.svg',
    'assets/Components/Yutiarin/Part 9.svg',
    'assets/Components/Yutiarin/Part 10.svg',
    'assets/Components/Yutiarin/Wing 1.svg',
    'assets/Turrets-Platforms/Yutiarin-Defense Turret.svg',
    'assets/Turrets-Platforms/Yutiarin-Perimeter Turret.svg'
]);

const SOURCE_ROOT_PATTERNS = [
    /    \{\r?\n        physical: path\.join\(PROJECT_ROOT, 'public', 'assets', 'Components'\),\r?\n        logical: 'assets\/Components',\r?\n        urlPrefix: '\/assets',\r?\n        recursive: true\r?\n    \},\r?\n/,
    /    \{\r?\n        physical: path\.join\(PROJECT_ROOT, 'public', 'assets', 'Turrets-Platforms'\),\r?\n        logical: 'assets\/Turrets-Platforms',\r?\n        urlPrefix: '\/assets',\r?\n        recursive: true\r?\n    \},\r?\n/
];

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function toNativePath(logicalPath) {
    return logicalPath.split('/').join(path.sep);
}

function logicalPrivatePath(logicalPath) {
    return path.posix.join('assets', logicalPath.slice('assets/'.length));
}

function fail(message) {
    throw new Error(`Private asset migration failed: ${message}`);
}

async function assertDirectory(directory, label) {
    let info;
    try {
        info = await lstat(directory);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        fail(`${label} must be a real directory: ${directory}`);
    }
    return true;
}

async function walkSvgFiles(root, relativeDirectory = '') {
    const directory = relativeDirectory ? path.join(root, toNativePath(relativeDirectory)) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    const files = [];
    for (const entry of entries) {
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        const absolutePath = path.join(root, toNativePath(relativePath));
        if (entry.isSymbolicLink()) {
            fail(`symbolic links are not allowed in the asset source tree: ${absolutePath}`);
        }
        if (entry.isDirectory()) {
            files.push(...await walkSvgFiles(root, relativePath));
        } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
            files.push(relativePath);
        }
    }
    return files;
}

function assertUniqueCaseInsensitive(paths, label) {
    const seen = new Map();
    for (const relativePath of paths) {
        const key = relativePath.toLocaleLowerCase('en-US');
        const prior = seen.get(key);
        if (prior && prior !== relativePath) {
            fail(`${label} contains a case-insensitive path collision: "${prior}" and "${relativePath}"`);
        }
        seen.set(key, relativePath);
    }
}

function compareInventory(actual, expected, label) {
    assertUniqueCaseInsensitive(actual, label);
    const actualByLower = new Map(actual.map((item) => [item.toLocaleLowerCase('en-US'), item]));
    const expectedSet = new Set(expected);
    const missing = expected.filter((item) => !actual.includes(item));
    const unexpected = actual.filter((item) => !expectedSet.has(item));

    for (const item of missing) {
        const caseVariant = actualByLower.get(item.toLocaleLowerCase('en-US'));
        if (caseVariant) {
            fail(`${label} path casing differs: expected "${item}", found "${caseVariant}"`);
        }
    }
    if (missing.length > 0) {
        fail(`${label} is missing registered SVGs: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
        fail(`${label} contains unregistered SVGs: ${unexpected.join(', ')}`);
    }
}

function inspectSourceRootMapping(source) {
    const matches = SOURCE_ROOT_PATTERNS.map((pattern) => source.match(pattern)?.length ?? 0);
    const privateRootExists = source.includes("physical: path.join(PROJECT_ROOT, 'private', 'assets')");

    if (matches.every((count) => count === 1)) {
        if (!privateRootExists) {
            fail('asset-roots.mjs does not declare the existing private assets root');
        }
        return { mode: 'public-overrides', source };
    }
    if (matches.every((count) => count === 0) && privateRootExists) {
        return { mode: 'private-only', source };
    }
    fail('asset-roots.mjs has a partial or unexpected Components/Turrets-Platforms mapping; inspect it before migration');
}

function createPrivateOnlyMapping(source) {
    let result = source;
    for (const pattern of SOURCE_ROOT_PATTERNS) {
        result = result.replace(pattern, '');
    }
    if (SOURCE_ROOT_PATTERNS.some((pattern) => pattern.test(result))) {
        fail('could not remove the public asset-root overrides safely');
    }
    return result;
}

async function readRegularFile(root, relativePath, label) {
    const absolutePath = path.join(root, toNativePath(relativePath));
    let info;
    try {
        info = await lstat(absolutePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            fail(`${label} is missing: ${absolutePath}`);
        }
        throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
        fail(`${label} must be a regular file: ${absolutePath}`);
    }
    return { absolutePath, bytes: await readFile(absolutePath) };
}

async function planMigration(projectRoot) {
    const registry = await readAssetRegistry(projectRoot);
    if (registry.assets.length !== EXPECTED_ASSET_COUNT) {
        fail(`expected ${EXPECTED_ASSET_COUNT} registry assets, found ${registry.assets.length}`);
    }

    const assetsRoot = path.join(projectRoot, 'public', 'assets');
    const privateRoot = path.join(projectRoot, 'private');
    const privateAssetsRoot = path.join(privateRoot, 'assets');
    if (!await assertDirectory(assetsRoot, 'public/assets')) {
        fail(`public assets root is missing: ${assetsRoot}`);
    }
    if (!await assertDirectory(privateRoot, 'private root')) {
        fail(`private root is missing; the ten existing private ships must be present: ${privateRoot}`);
    }
    await assertDirectory(privateAssetsRoot, 'private/assets');

    const mappingPath = path.join(projectRoot, 'scripts', 'asset-roots.mjs');
    const mappingSource = await readFile(mappingPath, 'utf8');
    const mapping = inspectSourceRootMapping(mappingSource);

    const expectedLogicalPaths = registry.assets.map((asset) => asset.logicalPath.slice('assets/'.length));
    const publicPaths = await walkSvgFiles(assetsRoot);
    compareInventory(publicPaths, expectedLogicalPaths, 'public/assets SVG inventory');

    const privatePaths = await walkSvgFiles(privateAssetsRoot).catch((error) => {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    assertUniqueCaseInsensitive(privatePaths, 'private/assets SVG inventory');

    const privateByLower = new Map(privatePaths.map((item) => [item.toLocaleLowerCase('en-US'), item]));
    const registryByLogicalPath = new Map(registry.assets.map((asset) => [
        asset.logicalPath.slice('assets/'.length),
        asset
    ]));
    for (const privatePath of privatePaths) {
        const expected = registryByLogicalPath.get(privatePath);
        if (!expected) {
            const caseVariant = [...registryByLogicalPath.keys()].find(
                (item) => item.toLocaleLowerCase('en-US') === privatePath.toLocaleLowerCase('en-US')
            );
            if (caseVariant) {
                fail(`private asset path casing differs: expected "${caseVariant}", found "${privatePath}"`);
            }
            fail(`private/assets contains an unregistered SVG: ${privatePath}`);
        }
    }

    const records = [];
    for (const asset of registry.assets) {
        const relativePath = asset.logicalPath.slice('assets/'.length);
        const publicFile = await readRegularFile(assetsRoot, relativePath, 'public source');
        const publicHash = sha256(publicFile.bytes);
        const privateRelativePath = logicalPrivatePath(asset.logicalPath);
        const privateSpelling = privateByLower.get(
            privateRelativePath.slice('assets/'.length).toLocaleLowerCase('en-US')
        );
        if (privateSpelling && privateSpelling !== privateRelativePath.slice('assets/'.length)) {
            fail(`private destination casing differs: expected "${privateRelativePath}", found "assets/${privateSpelling}"`);
        }

        const privateAbsolutePath = path.join(privateRoot, toNativePath(privateRelativePath));
        let privateBytes = null;
        if (privateSpelling) {
            const privateFile = await readRegularFile(privateAssetsRoot, privateSpelling, 'existing private source');
            privateBytes = privateFile.bytes;
            if (sha256(privateBytes) !== publicHash) {
                fail(`existing private file differs from its public source and will not be overwritten: ${privateRelativePath}`);
            }
        }

        if (asset.logicalPath.startsWith('assets/Ships/') && !privateBytes) {
            fail(`existing private ship source is missing: ${privateRelativePath}`);
        }

        records.push({
            assetId: asset.assetId,
            logicalPath: asset.logicalPath,
            relativePath,
            privateRelativePath,
            publicPath: publicFile.absolutePath,
            publicBytes: publicFile.bytes,
            sourceSha256: publicHash,
            privatePath: privateAbsolutePath,
            alreadyPresent: privateBytes !== null
        });
    }

    const shipCount = records.filter((record) => record.logicalPath.startsWith('assets/Ships/')).length;
    if (shipCount !== EXPECTED_SHIP_COUNT) {
        fail(`expected ${EXPECTED_SHIP_COUNT} ships, found ${shipCount}`);
    }
    const remainingPaths = records
        .filter((record) => !record.logicalPath.startsWith('assets/Ships/'))
        .map((record) => record.logicalPath);
    if (remainingPaths.length !== EXPECTED_PRIVATE_COPY_PATHS.size
        || remainingPaths.some((logicalPath) => !EXPECTED_PRIVATE_COPY_PATHS.has(logicalPath))) {
        fail('registry non-ship assets do not match the approved 21-file private migration scope');
    }
    const copyRecords = records.filter((record) => !record.alreadyPresent);
    if (copyRecords.length > EXPECTED_PRIVATE_COPY_COUNT) {
        fail(`expected at most ${EXPECTED_PRIVATE_COPY_COUNT} remaining files to migrate, found ${copyRecords.length}`);
    }

    return {
        registry,
        records,
        copyRecords,
        mappingPath,
        mapping,
        mappedSource: mapping.mode === 'private-only'
            ? mapping.source
            : createPrivateOnlyMapping(mapping.source),
        privateRoot,
        privateAssetsRoot
    };
}

async function copyToStage(records, stagingRoot) {
    for (const record of records) {
        const relative = record.privateRelativePath.slice('assets/'.length);
        const stagedPath = path.join(stagingRoot, 'assets', toNativePath(relative));
        await mkdir(path.dirname(stagedPath), { recursive: true });
        await copyFile(record.publicPath, stagedPath);
        const stagedBytes = await readFile(stagedPath);
        if (sha256(stagedBytes) !== record.sourceSha256
            || stagedBytes.length !== record.publicBytes.length) {
            fail(`staged SHA-256 or size mismatch for ${record.logicalPath}`);
        }
        record.stagedPath = stagedPath;
    }
}

async function verifySourcesUnchanged(records) {
    for (const record of records) {
        const source = await readFile(record.publicPath);
        if (source.length !== record.publicBytes.length || sha256(source) !== record.sourceSha256) {
            fail(`public source changed during migration: ${record.logicalPath}`);
        }
    }
}

async function ensureExactDirectory(directory) {
    const exists = await assertDirectory(directory, 'private destination parent');
    if (exists) {
        return;
    }
    try {
        await mkdir(directory);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
    if (!await assertDirectory(directory, 'private destination parent')) {
        fail(`could not create destination directory: ${directory}`);
    }
}

async function publishStagedCopies(records, privateRoot, publishLink = link) {
    const installed = [];
    try {
        for (const record of records) {
            const relative = record.privateRelativePath.slice('assets/'.length).split('/');
            let currentDirectory = privateRoot;
            for (const segment of ['assets', ...relative.slice(0, -1)]) {
                currentDirectory = path.join(currentDirectory, segment);
                await ensureExactDirectory(currentDirectory);
            }

            try {
                await publishLink(record.stagedPath, record.privatePath);
                installed.push({
                    path: record.privatePath,
                    stagedPath: record.stagedPath
                });
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
                const existing = await readRegularFile(
                    path.dirname(record.privatePath),
                    path.basename(record.privatePath),
                    'concurrent private destination'
                );
                if (sha256(existing.bytes) !== record.sourceSha256) {
                    fail(`private destination appeared during migration with different bytes: ${record.privateRelativePath}`);
                }
            }
        }
    } catch (error) {
        const rollbackErrors = [];
        for (const entry of installed.reverse()) {
            try {
                const [destinationInfo, stageInfo] = await Promise.all([
                    lstat(entry.path),
                    lstat(entry.stagedPath)
                ]);
                if (destinationInfo.dev !== stageInfo.dev || destinationInfo.ino !== stageInfo.ino) {
                    throw new Error(`destination no longer matches this migration's staged file: ${entry.path}`);
                }
                await rm(entry.path);
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], 'Private asset installation failed and rollback was incomplete');
        }
        throw error;
    }
    return installed;
}

async function replaceMapping(mappingPath, expected, replacement) {
    const current = await readFile(mappingPath);
    if (!current.equals(Buffer.from(expected))) {
        fail('asset-roots.mjs changed after preflight; refusing to overwrite it');
    }

    const token = `${process.pid}-${randomUUID()}`;
    const temporary = `${mappingPath}.${token}.tmp`;
    const backup = `${mappingPath}.${token}.bak`;
    await writeFile(temporary, replacement, { flag: 'wx' });
    try {
        const stillCurrent = await readFile(mappingPath);
        if (!stillCurrent.equals(Buffer.from(expected))) {
            fail('asset-roots.mjs changed during migration; refusing to overwrite it');
        }
        await rename(mappingPath, backup);
        if (!(await readFile(backup)).equals(Buffer.from(expected))) {
            await rename(backup, mappingPath);
            fail('asset-roots.mjs changed while creating its rollback copy');
        }
        await rename(temporary, mappingPath);
        if (!(await readFile(mappingPath)).equals(Buffer.from(replacement))) {
            fail('updated asset-roots.mjs did not match the verified migration mapping');
        }
        return { backup, replacement: Buffer.from(replacement) };
    } catch (error) {
        await rm(temporary, { force: true });
        const sourceExists = await lstat(mappingPath).then(() => true, () => false);
        const backupExists = await lstat(backup).then(() => true, () => false);
        if (!sourceExists && backupExists) {
            await rename(backup, mappingPath);
        }
        throw error;
    }
}

async function restoreMapping(mappingPath, backup, replacement) {
    const current = await readFile(mappingPath);
    if (!current.equals(replacement)) {
        fail('asset-roots.mjs changed after migration; refusing to overwrite it during rollback');
    }

    const displaced = `${mappingPath}.${process.pid}-${randomUUID()}.failed`;
    await rename(mappingPath, displaced);
    try {
        await rename(backup, mappingPath);
    } catch (error) {
        await rename(displaced, mappingPath);
        throw error;
    }
    await rm(displaced, { force: true });
}

async function runPreparation(projectRoot) {
    const script = path.join(projectRoot, 'scripts', 'prepare-assets.mjs');
    const { stdout, stderr } = await execFileAsync(process.execPath, [script], { cwd: projectRoot });
    if (stdout) {
        process.stdout.write(stdout);
    }
    if (stderr) {
        process.stderr.write(stderr);
    }
}

async function removeStagingDirectory(stagingRoot) {
    await rm(stagingRoot, { recursive: true, force: true });
}

export async function migrateAssetsPrivate({
    projectRoot = PROJECT_ROOT,
    apply = false,
    runPreparationCommand = runPreparation,
    publishLink = link
} = {}) {
    const plan = await planMigration(projectRoot);
    const sourceBytes = plan.records.reduce((total, record) => total + record.publicBytes.length, 0);
    const report = {
        mode: apply ? 'apply' : 'dry-run',
        registryAssetCount: plan.records.length,
        existingPrivateCount: plan.records.filter((record) => record.alreadyPresent).length,
        filesToCopy: plan.copyRecords.length,
        sourceBytes,
        copyBytes: plan.copyRecords.reduce((total, record) => total + record.publicBytes.length, 0),
        mappingChangeRequired: plan.mapping.mode === 'public-overrides',
        assets: plan.records.map((record) => ({
            assetId: record.assetId,
            logicalPath: record.logicalPath,
            publicPath: path.relative(projectRoot, record.publicPath),
            privatePath: path.relative(projectRoot, record.privatePath),
            bytes: record.publicBytes.length,
            sha256: record.sourceSha256,
            alreadyPresent: record.alreadyPresent
        }))
    };

    if (!apply) {
        return report;
    }

    const stagingRoot = path.join(plan.privateRoot, `.asset-migration-${randomUUID()}`);
    let mappingTransaction = null;
    try {
        await mkdir(stagingRoot);
        await copyToStage(plan.copyRecords, stagingRoot);
        await verifySourcesUnchanged(plan.records);
        await publishStagedCopies(plan.copyRecords, plan.privateRoot, publishLink);

        for (const record of plan.records) {
            const privateFile = await readRegularFile(
                plan.privateAssetsRoot,
                record.privateRelativePath.slice('assets/'.length),
                'verified private source'
            );
            if (privateFile.bytes.length !== record.publicBytes.length
                || sha256(privateFile.bytes) !== record.sourceSha256) {
                fail(`private source failed final SHA-256 verification: ${record.privateRelativePath}`);
            }
        }
        compareInventory(
            await walkSvgFiles(plan.privateAssetsRoot),
            plan.records.map((record) => record.privateRelativePath.slice('assets/'.length)),
            'final private/assets SVG inventory'
        );
        await verifySourcesUnchanged(plan.records);

        if (plan.mapping.mode === 'public-overrides') {
            mappingTransaction = await replaceMapping(
                plan.mappingPath,
                plan.mapping.source,
                plan.mappedSource
            );
        }

        await runPreparationCommand(projectRoot);
        if (mappingTransaction) {
            await rm(mappingTransaction.backup);
            mappingTransaction = null;
        }

        report.mode = 'migrated';
        report.filesToCopy = plan.copyRecords.length;
        return report;
    } catch (error) {
        if (mappingTransaction) {
            try {
                await restoreMapping(
                    plan.mappingPath,
                    mappingTransaction.backup,
                    mappingTransaction.replacement
                );
                mappingTransaction = null;
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'Migration failed and source-root rollback was incomplete');
            }
        }
        throw error;
    } finally {
        await removeStagingDirectory(stagingRoot);
    }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    const apply = process.argv.slice(2).includes('--apply');
    migrateAssetsPrivate({ apply })
        .then((report) => {
            console.log(JSON.stringify(report, null, 2));
            if (report.mode === 'dry-run') {
                console.log('Dry run only. Re-run with --apply to copy verified assets and update canonical roots.');
            }
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

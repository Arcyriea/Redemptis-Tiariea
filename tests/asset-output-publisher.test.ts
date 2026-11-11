import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { publishAssetOutputs, withAssetOutputLock } from '../scripts/asset-output-publisher.mjs';
import { createAssetPackageOutputs, validateCommittedAssetOutputs } from '../scripts/package-assets.mjs';
import { prepareAssets } from '../scripts/prepare-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
function hash(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

function sortJson(value: any): any {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
    }
    return value;
}

function signedRecord(fields: Record<string, unknown>) {
    const checksum = hash(Buffer.from(JSON.stringify(sortJson(fields))));
    return { ...fields, checksum };
}

function relative(projectRoot: string, filePath: string) {
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function journalOutput(projectRoot: string, destination: string, prior: Buffer, next: Buffer, transactionId: string) {
    return {
        destination: relative(projectRoot, destination),
        priorExists: true,
        priorSha256: hash(prior),
        temporary: relative(projectRoot, `${destination}.rtab-${transactionId}.tmp`),
        backup: relative(projectRoot, `${destination}.rtab-${transactionId}.bak`),
        newSha256: hash(next),
        unchanged: false
    };
}

async function writePlanetReplacementRecoveryJournal(
    projectRoot: string,
    { committed = false, removeDestination = false } = {}
) {
    const assetsRoot = path.join(projectRoot, 'public', 'assets');
    const manifest = JSON.parse(await readFile(path.join(assetsRoot, 'asset-manifest.json'), 'utf8'));
    const transactionId = randomUUID();
    const planetBundle = manifest.bundles.find((bundle: any) => bundle.bundleId === 'planets');
    const planetPath = path.join(projectRoot, 'public', planetBundle.bundleFile.slice(1));
    const currentPlanet = await readFile(planetPath);
    const priorPlanet = committed ? Buffer.from('previous transaction-owned planet bundle') : currentPlanet;
    const nextPlanet = committed ? currentPlanet : Buffer.from(currentPlanet);
    if (!committed) {
        nextPlanet[nextPlanet.length - 1] ^= 0xff;
    }
    const outputs = [];
    for (const destination of [
        ...manifest.bundles.map((bundle: any) => path.join(projectRoot, 'public', bundle.bundleFile.slice(1))),
        path.join(assetsRoot, 'asset-manifest.json'),
        path.join(assetsRoot, 'asset-manifest-schema.json'),
        path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts')
        ,path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts')
    ]) {
        if (destination === planetPath) {
            const temporary = `${destination}.rtab-${transactionId}.tmp`;
            const backup = `${destination}.rtab-${transactionId}.bak`;
            await writeFile(backup, priorPlanet);
            await writeFile(temporary, nextPlanet);
            if (committed) {
                await rm(temporary);
            } else if (removeDestination) {
                await rm(destination);
            } else {
                await writeFile(destination, nextPlanet);
                await rm(temporary);
            }
            outputs.push({
                destination: relative(projectRoot, destination),
                priorExists: true,
                priorSha256: hash(priorPlanet),
                temporary: relative(projectRoot, temporary),
                backup: relative(projectRoot, backup),
                newSha256: hash(nextPlanet),
                unchanged: false
            });
        } else {
            const bytes = await readFile(destination);
            const digest = hash(bytes);
            outputs.push({
                destination: relative(projectRoot, destination),
                priorExists: true,
                priorSha256: digest,
                temporary: null,
                backup: null,
                newSha256: digest,
                unchanged: true
            });
        }
    }

    const records: Record<string, unknown>[] = [
        { type: 'begin', transactionId, sequence: 0, state: 'preparing', outputs, staleOutputs: [] },
        { type: 'state', transactionId, sequence: 1, from: 'preparing', to: 'staging' },
        { type: 'state', transactionId, sequence: 2, from: 'staging', to: 'publishing' }
    ];
    if (committed) {
        records.push(
            { type: 'state', transactionId, sequence: 3, from: 'publishing', to: 'validating' },
            { type: 'state', transactionId, sequence: 4, from: 'validating', to: 'committed', manifestCommitted: true }
        );
    }
    await writeJournalRecords(projectRoot, records);
    return { planetPath, priorPlanet };
}

async function createFixture(run: (projectRoot: string) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'asset-output-recovery-'));
    const registry = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'), 'utf8'));
    await mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
    await mkdir(path.join(projectRoot, 'src', 'generated'), { recursive: true });
    await mkdir(path.join(projectRoot, 'src', 'assets'), { recursive: true });
    await mkdir(path.join(projectRoot, 'private', 'assets'), { recursive: true });
    await mkdir(path.join(projectRoot, 'public', 'assets'), { recursive: true });
    await writeFile(path.join(projectRoot, 'scripts', 'asset-registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
    await writeFile(
        path.join(projectRoot, 'scripts', 'planet-asset-approvals.json'),
        await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'planet-asset-approvals.json'))
    );
    await writeFile(
        path.join(projectRoot, 'src', 'assets', 'planet-runtime-references.json'),
        await readFile(path.join(REPOSITORY_ROOT, 'src', 'assets', 'planet-runtime-references.json'))
    );
    await writeFile(
        path.join(projectRoot, 'scripts', 'planet-asset-approvals.json'),
        await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'planet-asset-approvals.json'))
    );
    await mkdir(path.join(projectRoot, 'src', 'assets'), { recursive: true });
    await writeFile(
        path.join(projectRoot, 'src', 'assets', 'planet-runtime-references.json'),
        await readFile(path.join(REPOSITORY_ROOT, 'src', 'assets', 'planet-runtime-references.json'))
    );

    for (const asset of registry.assets) {
        const logicalPath = asset.logicalPath.slice('assets/'.length).split('/').join(path.sep);
        const privatePath = path.join(projectRoot, 'private', 'assets', logicalPath);
        await mkdir(path.dirname(privatePath), { recursive: true });
        const bytes = await readFile(path.join(REPOSITORY_ROOT, 'public', 'assets', logicalPath));
        await writeFile(privatePath, bytes);
    }
    const planetSourceRoot = path.join(projectRoot, 'private', 'assets', 'Planets');
    await mkdir(planetSourceRoot, { recursive: true });
    for (const fileName of ['Map-111.png', 'Map-122.png', 'Map-692.png']) {
        await writeFile(
            path.join(planetSourceRoot, fileName),
            await readFile(path.join(REPOSITORY_ROOT, 'private', 'assets', 'Planets', fileName))
        );
    }
    const privatePlanets = path.join(projectRoot, 'private', 'assets', 'Planets');
    await mkdir(privatePlanets, { recursive: true });
    for (const filename of ['Map-111.png', 'Map-122.png', 'Map-692.png']) {
        await writeFile(
            path.join(privatePlanets, filename),
            await readFile(path.join(REPOSITORY_ROOT, 'private', 'assets', 'Planets', filename))
        );
    }

    try {
        await run(projectRoot);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

async function writeJournal(projectRoot: string, transactionId: string, outputs: object[], staleOutputs: object[] = []) {
    await writeFile(
        path.join(projectRoot, 'private', '.asset-package-transaction.jsonl'),
        `${JSON.stringify(signedRecord({
            type: 'begin',
            transactionId,
            sequence: 0,
            state: 'preparing',
            outputs,
            staleOutputs
        }))}\n`
    );
}

async function writeJournalRecords(projectRoot: string, records: Record<string, unknown>[]) {
    await writeFile(
        path.join(projectRoot, 'private', '.asset-package-transaction.jsonl'),
        `${records.map((record) => JSON.stringify(signedRecord(record))).join('\n')}\n`
    );
}

test('recovery rolls back an interrupted publication and restores the prior output by hash', async () => {
    await createFixture(async (projectRoot) => {
        const destination = path.join(projectRoot, 'public', 'assets', 'ships.bin');
        const prior = Buffer.from('prior valid bundle');
        const next = Buffer.from('incomplete replacement bundle');
        const transactionId = randomUUID();
        const temporary = `${destination}.rtab-${transactionId}.tmp`;
        const backup = `${destination}.rtab-${transactionId}.bak`;
        await writeFile(destination, prior);
        await writeFile(temporary, next);
        await link(destination, backup);
        await rm(destination);
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifestNext = Buffer.from('not yet committed');
        await writeJournal(projectRoot, transactionId, [
            journalOutput(projectRoot, destination, prior, next, transactionId),
            {
                destination: relative(projectRoot, manifestPath),
                priorExists: false,
                priorSha256: null,
                temporary: relative(projectRoot, `${manifestPath}.rtab-${transactionId}.tmp`),
                backup: null,
                newSha256: hash(manifestNext),
                unchanged: false
            }
        ]);

        await withAssetOutputLock(projectRoot, async () => {});

        assert.deepEqual(await readFile(destination), prior);
        await assert.rejects(lstat(temporary), { code: 'ENOENT' });
        await assert.rejects(lstat(backup), { code: 'ENOENT' });
        await assert.rejects(lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')), { code: 'ENOENT' });
    });
});

test('rolled-back recovery verifies prior files and retries failed terminal journal deletion', async () => {
    await createFixture(async (projectRoot) => {
        const transactionId = randomUUID();
        const destination = path.join(projectRoot, 'public', 'assets', 'ships.bin');
        const prior = Buffer.from('prior output must remain unchanged');
        const next = Buffer.from('replacement output');
        const temporary = `${destination}.rtab-${transactionId}.tmp`;
        const backup = `${destination}.rtab-${transactionId}.bak`;
        const unrelatedPath = path.join(projectRoot, 'public', 'assets', 'operator-note.txt');
        const unrelated = Buffer.from('unrelated file must not be removed');
        await writeFile(destination, prior);
        await writeFile(unrelatedPath, unrelated);

        const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
        await writeJournalRecords(projectRoot, [
            {
                type: 'begin',
                transactionId,
                sequence: 0,
                state: 'preparing',
                outputs: [journalOutput(projectRoot, destination, prior, next, transactionId)],
                staleOutputs: []
            },
            {
                type: 'state',
                transactionId,
                sequence: 1,
                from: 'preparing',
                to: 'rolling-back'
            },
            {
                type: 'state',
                transactionId,
                sequence: 2,
                from: 'rolling-back',
                to: 'rolled-back'
            }
        ]);
        let removalAttempts = 0;
        const failFirstRemoval = async (target: string) => {
            removalAttempts += 1;
            if (removalAttempts === 1) {
                throw new Error('injected terminal journal deletion failure');
            }
            await rm(target);
        };

        await assert.rejects(
            withAssetOutputLock(projectRoot, async () => {}, { removeJournal: failFirstRemoval }),
            /injected terminal journal deletion failure/
        );
        assert.deepEqual(await readFile(destination), prior);
        assert.deepEqual(await readFile(unrelatedPath), unrelated);
        await assert.rejects(lstat(temporary), { code: 'ENOENT' });
        await assert.rejects(lstat(backup), { code: 'ENOENT' });
        assert.ok((await readFile(journalPath, 'utf8')).includes('"to":"rolled-back"'));

        await withAssetOutputLock(projectRoot, async () => {});

        assert.deepEqual(await readFile(destination), prior);
        assert.deepEqual(await readFile(unrelatedPath), unrelated);
        await assert.rejects(lstat(temporary), { code: 'ENOENT' });
        await assert.rejects(lstat(backup), { code: 'ENOENT' });
        await assert.rejects(lstat(journalPath), { code: 'ENOENT' });
        assert.equal(removalAttempts, 1);
    });
});

test('rolled-back recovery preserves the journal when prior outputs or artifacts are ambiguous', async () => {
    for (const ambiguous of ['destination', 'temporary'] as const) {
        await createFixture(async (projectRoot) => {
            const transactionId = randomUUID();
            const destination = path.join(projectRoot, 'public', 'assets', 'ships.bin');
            const prior = Buffer.from('recorded prior output');
            const next = Buffer.from('replacement output');
            const temporary = `${destination}.rtab-${transactionId}.tmp`;
            const backup = `${destination}.rtab-${transactionId}.bak`;
            await writeFile(destination, ambiguous === 'destination' ? Buffer.from('unexpected output') : prior);
            if (ambiguous === 'temporary') {
                await writeFile(temporary, Buffer.from('unresolved temporary contents'));
            }
            const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
            await writeJournalRecords(projectRoot, [
                {
                    type: 'begin',
                    transactionId,
                    sequence: 0,
                    state: 'preparing',
                    outputs: [journalOutput(projectRoot, destination, prior, next, transactionId)],
                    staleOutputs: []
                },
                {
                    type: 'state',
                    transactionId,
                    sequence: 1,
                    from: 'preparing',
                    to: 'rolling-back'
                },
                {
                    type: 'state',
                    transactionId,
                    sequence: 2,
                    from: 'rolling-back',
                    to: 'rolled-back'
                }
            ]);
            const journalBytes = await readFile(journalPath);

            await assert.rejects(
                withAssetOutputLock(projectRoot, async () => {}),
                ambiguous === 'destination' ? /prior state/ : /artifact remains/
            );

            assert.deepEqual(await readFile(journalPath), journalBytes);
            if (ambiguous === 'destination') {
                assert.deepEqual(await readFile(destination), Buffer.from('unexpected output'));
            } else {
                assert.deepEqual(await readFile(destination), prior);
                assert.deepEqual(await readFile(temporary), Buffer.from('unresolved temporary contents'));
            }
            await assert.rejects(lstat(backup), { code: 'ENOENT' });
        });
    }
});

test('recovery restores schema 1.1 if interrupted before manifest 1.1 is committed', async () => {
    await createFixture(async (projectRoot) => {
        const transactionId = randomUUID();
        const schemaPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json');
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const oldSchema = Buffer.from('prior schema');
        const newSchema = Buffer.from('schema 1.1');
        const oldManifest = Buffer.from('prior manifest 1.0');
        const newManifest = Buffer.from('manifest 1.1');
        const schemaTemp = `${schemaPath}.rtab-${transactionId}.tmp`;
        const schemaBackup = `${schemaPath}.rtab-${transactionId}.bak`;
        const manifestTemp = `${manifestPath}.rtab-${transactionId}.tmp`;
        const manifestBackup = `${manifestPath}.rtab-${transactionId}.bak`;

        await writeFile(schemaPath, oldSchema);
        await writeFile(manifestPath, oldManifest);
        await link(schemaPath, schemaBackup);
        await rm(schemaPath);
        await writeFile(schemaPath, newSchema);
        await writeFile(manifestTemp, newManifest);
        await writeJournal(projectRoot, transactionId, [
            journalOutput(projectRoot, schemaPath, oldSchema, newSchema, transactionId),
            journalOutput(projectRoot, manifestPath, oldManifest, newManifest, transactionId)
        ]);

        await withAssetOutputLock(projectRoot, async () => {});

        assert.deepEqual(await readFile(schemaPath), oldSchema);
        assert.deepEqual(await readFile(manifestPath), oldManifest);
        await assert.rejects(lstat(schemaBackup), { code: 'ENOENT' });
        await assert.rejects(lstat(manifestTemp), { code: 'ENOENT' });
        await assert.rejects(lstat(manifestBackup), { code: 'ENOENT' });
    });
});

test('recovery restores outputs after staging, backup, destination removal, and bundle publication boundaries', async () => {
    await createFixture(async (projectRoot) => {
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const priorManifest = Buffer.from('prior manifest 1.0');
        const nextManifest = Buffer.from('not-yet-published manifest 1.1');
        const destination = path.join(projectRoot, 'public', 'assets', 'boundary.bin');
        const prior = Buffer.from('prior valid bundle');
        const next = Buffer.from('new bundle');
        const transactionId = randomUUID();
        const temporary = `${destination}.rtab-${transactionId}.tmp`;
        const backup = `${destination}.rtab-${transactionId}.bak`;
        const manifestTemporary = `${manifestPath}.rtab-${transactionId}.tmp`;
        const manifestBackup = `${manifestPath}.rtab-${transactionId}.bak`;

        await writeFile(manifestPath, priorManifest);
        const states = ['staged', 'backup-created', 'destination-removed', 'bundle-published'] as const;
        for (const state of states) {
            await writeFile(destination, prior).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
            });
            await writeFile(temporary, next);
            await writeFile(manifestTemporary, nextManifest);
            if (state !== 'staged') {
                await link(destination, backup);
            }
            if (state === 'destination-removed' || state === 'bundle-published') {
                await rm(destination);
            }
            if (state === 'bundle-published') {
                await writeFile(destination, next);
                await rm(temporary);
            }

            await writeJournal(projectRoot, transactionId, [
                journalOutput(projectRoot, destination, prior, next, transactionId),
                journalOutput(projectRoot, manifestPath, priorManifest, nextManifest, transactionId)
            ]);
            await withAssetOutputLock(projectRoot, async () => {});

            assert.deepEqual(await readFile(destination), prior, `${state}: prior bundle was not restored`);
            assert.deepEqual(await readFile(manifestPath), priorManifest, `${state}: prior manifest changed`);
            await assert.rejects(lstat(temporary), { code: 'ENOENT' });
            await assert.rejects(lstat(backup), { code: 'ENOENT' });
            await assert.rejects(lstat(manifestTemporary), { code: 'ENOENT' });
            await assert.rejects(lstat(manifestBackup), { code: 'ENOENT' });
        }
    });
});

test('a committed output set is verified before stale-output retirement and backup cleanup', async () => {
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const transactionId = randomUUID();
        const manifest = JSON.parse(await readFile(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'), 'utf8'));
        const outputPaths = [
            ...manifest.bundles.map((bundle: any) => path.join(projectRoot, 'public', bundle.bundleFile.slice(1))),
            path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'),
            path.join(projectRoot, 'public', 'assets', 'asset-manifest-schema.json'),
            path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts')
            ,path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts')
        ];
        const outputs = [];
        for (const destination of outputPaths) {
            const bytes = await readFile(destination);
            outputs.push({
                destination: relative(projectRoot, destination),
                priorExists: false,
                priorSha256: null,
                temporary: relative(projectRoot, `${destination}.rtab-${transactionId}.tmp`),
                backup: null,
                newSha256: hash(bytes),
                unchanged: false
            });
        }
        const stalePath = path.join(projectRoot, 'public', 'assets', 'Ships', 'ships.bin');
        const staleBytes = Buffer.from('old nested Ships bundle');
        await mkdir(path.dirname(stalePath), { recursive: true });
        await writeFile(stalePath, staleBytes);
        await writeJournal(projectRoot, transactionId, outputs, [{
            destination: relative(projectRoot, stalePath),
            priorExists: true,
            priorSha256: hash(staleBytes)
        }]);

        await withAssetOutputLock(projectRoot, async () => {});

        await assert.rejects(lstat(stalePath), { code: 'ENOENT' });
        await assert.rejects(lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')), { code: 'ENOENT' });
        const committed = await prepareAssets({ projectRoot });
        assert.equal(committed.mode, 'package');
    });
});

test('recovery completes a committed required planets.bin replacement before backup cleanup', async () => {
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const unrelatedPath = path.join(projectRoot, 'public', 'assets', 'operator-note.txt');
        const unrelated = Buffer.from('must remain untouched');
        await writeFile(unrelatedPath, unrelated);
        const { planetPath } = await writePlanetReplacementRecoveryJournal(projectRoot, { committed: true });

        await withAssetOutputLock(projectRoot, async () => {});

        const result = await validateCommittedAssetOutputs({ projectRoot });
        assert.deepEqual(result.validatedBundles, ['components', 'planets', 'ships', 'turrets-platforms']);
        await assert.doesNotReject(lstat(planetPath));
        assert.deepEqual(await readFile(unrelatedPath), unrelated);
        await assert.rejects(
            lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')),
            { code: 'ENOENT' }
        );
        for (const outputRoot of [
            path.join(projectRoot, 'public', 'assets'),
            path.join(projectRoot, 'src', 'generated')
        ]) {
            assert.equal((await readdir(outputRoot)).some((name) => /\.rtab-[0-9a-f-]+\.(?:tmp|bak)$/.test(name)), false);
        }
    });
});

test('recovery restores planets.bin after an interrupted replacement removed the destination', async () => {
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const unrelatedPath = path.join(projectRoot, 'public', 'assets', 'operator-note.txt');
        const unrelated = Buffer.from('must remain untouched');
        await writeFile(unrelatedPath, unrelated);
        const { planetPath, priorPlanet } = await writePlanetReplacementRecoveryJournal(projectRoot, { removeDestination: true });

        await withAssetOutputLock(projectRoot, async () => {});

        const result = await validateCommittedAssetOutputs({ projectRoot });
        assert.deepEqual(result.validatedBundles, ['components', 'planets', 'ships', 'turrets-platforms']);
        assert.deepEqual(await readFile(planetPath), priorPlanet);
        assert.deepEqual(await readFile(unrelatedPath), unrelated);
        await assert.rejects(
            lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')),
            { code: 'ENOENT' }
        );
        for (const outputRoot of [
            path.join(projectRoot, 'public', 'assets'),
            path.join(projectRoot, 'src', 'generated')
        ]) {
            assert.equal((await readdir(outputRoot)).some((name) => /\.rtab-[0-9a-f-]+\.(?:tmp|bak)$/.test(name)), false);
        }
    });
});

test('truncated journals and active locks stop without attempting recovery', async () => {
    await createFixture(async (projectRoot) => {
        const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
        await writeFile(journalPath, '{"type":"begin"');
        await assert.rejects(withAssetOutputLock(projectRoot, async () => {}), /journal is truncated/);
        assert.equal(await readFile(journalPath, 'utf8'), '{"type":"begin"');
        await rm(journalPath);

        const lockPath = path.join(projectRoot, 'private', '.asset-package.lock');
        await writeFile(lockPath, `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            token: randomUUID(),
            startedAt: new Date().toISOString()
        })}\n`);
        const lockBytes = await readFile(lockPath);
        await assert.rejects(withAssetOutputLock(projectRoot, async () => {}), /already exists/);
        assert.deepEqual(await readFile(lockPath), lockBytes);
        assert.equal((await readFile(lockPath, 'utf8')).length > 0, true);
    });
});

test('journal rejects checksum, sequence, operation identity, transaction, and state corruption without editing it', async () => {
    const cases: Array<[string, (records: Record<string, unknown>[]) => void]> = [
        ['modified record contents', (records) => { records[1].to = 'publishing'; }],
        ['missing sequence', (records) => { records[1].sequence = 3; }],
        ['duplicate sequence', (records) => { records[2].sequence = records[1].sequence; }],
        ['reordered sequence', (records) => { records.reverse(); }],
        ['duplicate operation ID', (records) => { records[4].operationId = records[2].operationId; }],
        ['invalid operation ID', (records) => { records[2].operationId = ''; }],
        ['unknown operation type', (records) => { records[2].operation = 'unknown-operation'; }],
        ['completion without intent', (records) => {
            records.splice(2, 1);
            records.forEach((record, index) => { record.sequence = index; });
        }],
        ['invalid state transition', (records) => { records[1].to = 'committed'; }],
        ['unknown transaction', (records) => { records[1].transactionId = 'unknown-transaction'; }]
    ];

    for (const [label, mutate] of cases) {
        await createFixture(async (projectRoot) => {
            const transactionId = randomUUID();
            const destination = path.join(projectRoot, 'public', 'assets', 'ships.bin');
            const prior = Buffer.from('prior');
            const next = Buffer.from('new');
            const temp = `${destination}.rtab-${transactionId}.tmp`;
            const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
            const records: Record<string, unknown>[] = [
                {
                    type: 'begin',
                    transactionId,
                    sequence: 0,
                    state: 'preparing',
                    outputs: [
                        journalOutput(projectRoot, destination, prior, next, transactionId),
                        {
                            destination: relative(projectRoot, manifestPath),
                            priorExists: false,
                            priorSha256: null,
                            temporary: relative(projectRoot, `${manifestPath}.rtab-${transactionId}.tmp`),
                            backup: null,
                            newSha256: hash(Buffer.from('manifest')),
                            unchanged: false
                        }
                    ],
                    staleOutputs: []
                },
                {
                    type: 'state',
                    transactionId,
                    sequence: 1,
                    from: 'preparing',
                    to: 'staging'
                },
                {
                    type: 'operation-intent',
                    transactionId,
                    sequence: 2,
                    operationId: randomUUID(),
                    operation: 'stage-temp',
                    target: relative(projectRoot, temp),
                    before: { exists: false, sha256: null },
                    after: { exists: true, sha256: hash(next) }
                },
                {
                    type: 'operation-complete',
                    transactionId,
                    sequence: 3,
                    operationId: '',
                    operation: 'stage-temp',
                    target: relative(projectRoot, temp),
                    result: 'applied'
                },
                {
                    type: 'operation-intent',
                    transactionId,
                    sequence: 4,
                    operationId: randomUUID(),
                    operation: 'stage-temp',
                    target: relative(projectRoot, `${manifestPath}.rtab-${transactionId}.tmp`),
                    before: { exists: false, sha256: null },
                    after: { exists: true, sha256: hash(Buffer.from('manifest')) }
                },
                {
                    type: 'operation-complete',
                    transactionId,
                    sequence: 5,
                    operationId: '',
                    operation: 'stage-temp',
                    target: relative(projectRoot, `${manifestPath}.rtab-${transactionId}.tmp`),
                    result: 'applied'
                }
            ];
            records[3].operationId = records[2].operationId;
            records[5].operationId = records[4].operationId;
            mutate(records);
            await writeJournalRecords(projectRoot, records);
            const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
            const bytes = await readFile(journalPath);
            await assert.rejects(withAssetOutputLock(projectRoot, async () => {}), /journal|transaction|operation|sequence|checksum|transition/i, label);
            assert.deepEqual(await readFile(journalPath), bytes, `${label}: ambiguous journal was modified`);
        });

    }

    await createFixture(async (projectRoot) => {
        const transactionId = randomUUID();
        await writeJournal(projectRoot, transactionId, []);
        const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
        const lines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
        const begin = JSON.parse(lines[0]);
        const state = signedRecord({
            type: 'state',
            transactionId,
            sequence: 1,
            from: 'preparing',
            to: 'staging'
        });
        state.to = 'publishing';
        await writeFile(journalPath, `${JSON.stringify(begin)}\n${JSON.stringify(state)}\n`);
        const original = await readFile(journalPath);
        await assert.rejects(withAssetOutputLock(projectRoot, async () => {}), /invalid checksum/);
        assert.deepEqual(await readFile(journalPath), original);
    });

    await createFixture(async (projectRoot) => {
        const transactionId = randomUUID();
        const shipPath = path.join(projectRoot, 'public', 'assets', 'ships.bin');
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const prior = Buffer.from('prior');
        const next = Buffer.from('staged');
        const temp = `${shipPath}.rtab-${transactionId}.tmp`;
        await writeFile(shipPath, prior);
        await writeFile(temp, next);
        await writeJournal(projectRoot, transactionId, [
            journalOutput(projectRoot, shipPath, prior, next, transactionId),
            {
                destination: relative(projectRoot, manifestPath),
                priorExists: false,
                priorSha256: null,
                temporary: relative(projectRoot, `${manifestPath}.rtab-${transactionId}.tmp`),
                backup: null,
                newSha256: hash(Buffer.from('manifest')),
                unchanged: false
            }
        ]);
        const records = [
            signedRecord({
                type: 'state',
                transactionId,
                sequence: 1,
                from: 'preparing',
                to: 'staging'
            }),
            signedRecord({
                type: 'operation-intent',
                transactionId,
                sequence: 2,
                operationId: randomUUID(),
                operation: 'stage-temp',
                target: relative(projectRoot, temp),
                before: { exists: false, sha256: null },
                after: { exists: true, sha256: hash(next) }
            })
        ];
        const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
        const begin = JSON.parse((await readFile(journalPath, 'utf8')).split('\n')[0]);
        await writeFile(journalPath, `${[begin, ...records].map((record) => JSON.stringify(record)).join('\n')}\n`);

        await withAssetOutputLock(projectRoot, async () => {});

        assert.deepEqual(await readFile(shipPath), prior);
        await assert.rejects(lstat(temp), { code: 'ENOENT' });
        await assert.rejects(lstat(journalPath), { code: 'ENOENT' });
    });
});

test('existing locks stop preparation and are never removed based on PID or hostname', async () => {
    await createFixture(async (projectRoot) => {
        const lockPath = path.join(projectRoot, 'private', '.asset-package.lock');
        const owner = {
            pid: 2147483647,
            hostname: hostname(),
            token: randomUUID(),
            startedAt: new Date().toISOString(),
            processStartIdentity: 'test-process-start'
        };
        const lockBytes = Buffer.from(`${JSON.stringify(owner)}\n`);
        await writeFile(lockPath, lockBytes);
        await assert.rejects(
            withAssetOutputLock(projectRoot, async () => {
                assert.fail('publication must not run while a lock exists');
            }),
            (error: Error) => error.message.includes(JSON.stringify(owner)) && error.message.includes('remove') && error.message.includes('manually')
        );
        assert.deepEqual(await readFile(lockPath), lockBytes);
    });
});

test('malformed lock metadata is preserved and blocks recovery', async () => {
    await createFixture(async (projectRoot) => {
        const lockPath = path.join(projectRoot, 'private', '.asset-package.lock');
        const bytes = Buffer.from('{"pid":2147483647');
        await writeFile(lockPath, bytes);
        await assert.rejects(withAssetOutputLock(projectRoot, async () => {}), /lock is malformed/);
        assert.deepEqual(await readFile(lockPath), bytes);
    });
});

test('new lock metadata includes process-start identity diagnostics', async () => {
    await createFixture(async (projectRoot) => {
        await withAssetOutputLock(projectRoot, async () => {
            const lockPath = path.join(projectRoot, 'private', '.asset-package.lock');
            const owner = JSON.parse(await readFile(lockPath, 'utf8'));
            assert.equal(owner.pid, process.pid);
            assert.equal(typeof owner.processStartIdentity, 'string');
            assert.ok(owner.processStartIdentity.length > 0);
        });
    });
});

test('post-publication validation failure restores known-good outputs and preserves recovery artifacts', async () => {
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const assetsDirectory = path.join(projectRoot, 'public', 'assets');
        const manifest = JSON.parse(await readFile(path.join(assetsDirectory, 'asset-manifest.json'), 'utf8'));
        const outputPaths = [
            ...manifest.bundles.map((bundle: any) => path.join(projectRoot, 'public', bundle.bundleFile.slice(1))),
            path.join(assetsDirectory, 'asset-manifest.json'),
            path.join(assetsDirectory, 'asset-manifest-schema.json'),
            path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts')
            ,path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts')
        ];
        const priorOutputs = new Map<string, Buffer>();
        for (const destination of outputPaths) {
            priorOutputs.set(destination, await readFile(destination));
        }
        const stalePath = path.join(assetsDirectory, 'Ships', 'ships.bin');
        const staleBytes = Buffer.from('old nested Ships bundle');
        await mkdir(path.dirname(stalePath), { recursive: true });
        await writeFile(stalePath, staleBytes);

        const outputs = new Map<string, Buffer>();
        for (const [destination, bytes] of priorOutputs) {
            outputs.set(destination, Buffer.from(bytes));
        }
        const runtimeContractPath = path.join(projectRoot, 'src', 'generated', 'runtimeAssetContract.ts');
        const changedContract = Buffer.from(outputs.get(runtimeContractPath)!);
        changedContract[changedContract.length - 1] ^= 0xff;
        outputs.set(runtimeContractPath, changedContract);

        await assert.rejects(
            publishAssetOutputs({
                projectRoot,
                outputs,
                stalePaths: [stalePath],
                validatePublishedOutputs: async () => {
                    assert.deepEqual(await readFile(runtimeContractPath), changedContract);
                    throw new Error('injected post-publication disk validation failure');
                }
            }),
            /prior outputs were restored and recovery artifacts were preserved/
        );

        for (const [destination, bytes] of priorOutputs) {
            assert.deepEqual(await readFile(destination), bytes, `Known-good output changed: ${destination}`);
        }
        assert.deepEqual(await readFile(stalePath), staleBytes);
        const journalPath = path.join(projectRoot, 'private', '.asset-package-transaction.jsonl');
        assert.equal((await readFile(journalPath, 'utf8')).includes('"type":"begin"'), true);
        const backupName = (await readdir(path.dirname(runtimeContractPath))).find((name) => name.startsWith(path.basename(runtimeContractPath) + '.rtab-') && name.endsWith('.bak'));
        assert.ok(backupName, 'expected preserved runtime contract backup');
        assert.deepEqual(await readFile(path.join(path.dirname(runtimeContractPath), backupName)), priorOutputs.get(runtimeContractPath));

        await withAssetOutputLock(projectRoot, async () => {});
        for (const [destination, bytes] of priorOutputs) {
            assert.deepEqual(await readFile(destination), bytes, `Recovery changed known-good output: ${destination}`);
        }
        await assert.rejects(lstat(journalPath), { code: 'ENOENT' });
        await assert.rejects(lstat(path.join(path.dirname(runtimeContractPath), backupName)), { code: 'ENOENT' });
        assert.deepEqual(await readFile(stalePath), staleBytes);
    });
});

test('publisher requires a validation callback before touching outputs or journal state', async () => {
    await createFixture(async (projectRoot) => {
        const assetsDirectory = path.join(projectRoot, 'public', 'assets');
        const before = await readdir(assetsDirectory);
        const destination = path.join(assetsDirectory, 'must-not-be-created.bin');

        await assert.rejects(
            publishAssetOutputs({
                projectRoot,
                outputs: new Map([[destination, Buffer.from('generated output')]])
            }),
            /requires an explicit validatePublishedOutputs callback/
        );

        assert.deepEqual(await readdir(assetsDirectory), before);
        await assert.rejects(lstat(destination), { code: 'ENOENT' });
        await assert.rejects(
            lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')),
            { code: 'ENOENT' }
        );
    });
});

test('content-addressed bundle destinations are immutable and matching existing bytes are unchanged', async () => {
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const manifestPath = path.join(projectRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const bundle = manifest.bundles.find((entry: any) => entry.bundleId === 'components');
        const destination = path.join(projectRoot, 'public', bundle.bundleFile.slice(1));
        const bytes = await readFile(destination);
        const outputs = new Map([
            [destination, bytes],
            [manifestPath, await readFile(manifestPath)]
        ]);
        await publishAssetOutputs({
            projectRoot,
            outputs,
            validatePublishedOutputs: async () => {}
        });
        const repeat = await publishAssetOutputs({
            projectRoot,
            outputs,
            validatePublishedOutputs: async () => {}
        });
        assert.equal(repeat.outputFiles, 2);
        assert.deepEqual(await readFile(destination), bytes);

        await writeFile(destination, Buffer.from('corrupt immutable bytes'));
        await assert.rejects(
            publishAssetOutputs({
                projectRoot,
                outputs,
                validatePublishedOutputs: async () => {}
            }),
            /Immutable content-addressed bundle does not match its path and cannot be replaced/
        );
    });
});

test('native Windows hard-link publication updates a validated output set', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('requires native Windows filesystem behavior');
        return;
    }
    await createFixture(async (projectRoot) => {
        await prepareAssets({ projectRoot });
        const source = path.join(projectRoot, 'private', 'assets', 'Ships', 'human-dreadnought.svg');
        await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg"><metadata>hard-link publication test</metadata></svg>');
        const generated = await createAssetPackageOutputs({ projectRoot });
        generated.outputFiles.set(
            path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts'),
            await readFile(path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts'))
        );
        await withAssetOutputLock(projectRoot, async () => {
            await publishAssetOutputs({
                projectRoot,
                outputs: generated.outputFiles,
                validatePublishedOutputs: async () => {}
            });
        });
        const manifest = JSON.parse(await readFile(path.join(projectRoot, 'public', 'assets', 'asset-manifest.json'), 'utf8'));
        assert.equal(manifest.bundles.length, 4);
    });
});

test('unsupported hard-link publication fails clearly and preserves the prior destination', async () => {
    await createFixture(async (projectRoot) => {
        const destination = path.join(projectRoot, 'public', 'assets', 'existing.bin');
        const prior = Buffer.from('prior output');
        await writeFile(destination, prior);
        const unsupportedLink = async () => {
            const error: NodeJS.ErrnoException = new Error('hard links unsupported');
            error.code = 'ENOTSUP';
            throw error;
        };
        await assert.rejects(
            publishAssetOutputs({
                projectRoot,
                outputs: new Map([[destination, Buffer.from('replacement')]]),
                linkFile: unsupportedLink,
                validatePublishedOutputs: async () => {}
            }),
            /requires hard-link support on the same filesystem/
        );
        assert.deepEqual(await readFile(destination), prior);
        await assert.rejects(lstat(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl')), { code: 'ENOENT' });
    });
});

test('native Windows no-overwrite publication preserves a racing destination', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('requires native Windows filesystem behavior');
        return;
    }
    await createFixture(async (projectRoot) => {
        const destination = path.join(projectRoot, 'public', 'assets', 'race.bin');
        const competitor = Buffer.from('created after preflight');
        let raced = false;
        const racingLink = async (source: string, target: string) => {
            if (target === destination && !raced) {
                raced = true;
                await writeFile(destination, competitor, { flag: 'wx' });
            }
            await link(source, target);
        };
        await assert.rejects(
            publishAssetOutputs({
                projectRoot,
                outputs: new Map([[destination, Buffer.from('generated output')]]),
                linkFile: racingLink,
                validatePublishedOutputs: async () => {}
            }),
            /unexpected contents/
        );
        assert.deepEqual(await readFile(destination), competitor);
        assert.equal(raced, true);
        assert.equal(await readFile(path.join(projectRoot, 'private', '.asset-package-transaction.jsonl'), 'utf8').then((text) => text.length > 0), true);
    });
});

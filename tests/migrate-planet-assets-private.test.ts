import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migratePlanetAssetsPrivate } from '../scripts/migrate-planet-assets-private.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const PLANET_FILES = ['Map-111.png', 'Map-122.png', 'Map-692.png'];

function hash(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function createFixture(run: (projectRoot: string) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'planet-asset-migration-'));
    const registry = await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'));
    await mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
    await mkdir(path.join(projectRoot, 'public', 'assets', 'Planets'), { recursive: true });
    await mkdir(path.join(projectRoot, 'private', 'assets'), { recursive: true });
    await writeFile(path.join(projectRoot, 'scripts', 'asset-registry.json'), registry);
    const currentApprovals = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'planet-asset-approvals.json'), 'utf8'));
    const approvals = Object.fromEntries(PLANET_FILES.map((filename) => {
        const logicalPath = `assets/Planets/${filename}`;
        return [logicalPath, currentApprovals.approvals[logicalPath]];
    }));
    await writeFile(path.join(projectRoot, 'scripts', 'planet-asset-approvals.json'), `${JSON.stringify({
        approvalSchemaVersion: '1', approvals
    }, null, 2)}\n`);
    for (const filename of PLANET_FILES) {
        await writeFile(
            path.join(projectRoot, 'public', 'assets', 'Planets', filename),
            await readFile(path.join(REPOSITORY_ROOT, 'private', 'assets', 'Planets', filename))
        );
    }

    try {
        await run(projectRoot);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

test('dry-run inventories only the three approved planet PNGs without copying', async () => {
    await createFixture(async (projectRoot) => {
        const report = await migratePlanetAssetsPrivate({ projectRoot });
        assert.equal(report.mode, 'dry-run');
        assert.equal(report.assetCount, 3);
        assert.equal(report.existingPrivateCount, 0);
        assert.equal(report.filesToCopy, 3);
        assert.equal((await readdir(path.join(projectRoot, 'private', 'assets'))).includes('Planets'), false);
    });
});

test('migration copies only the three legacy numeric maps and retries idempotently', async () => {
    await createFixture(async (projectRoot) => {
        const sourceHashes = new Map<string, string>();
        for (const filename of PLANET_FILES) {
            sourceHashes.set(filename, hash(await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', filename))));
        }

        const first = await migratePlanetAssetsPrivate({ projectRoot, apply: true });
        const second = await migratePlanetAssetsPrivate({ projectRoot, apply: true });
        assert.equal(first.mode, 'migrated');
        assert.equal(first.filesToCopy, 3);
        assert.equal(second.filesToCopy, 0);
        assert.equal(second.existingPrivateCount, 3);
        for (const filename of PLANET_FILES) {
            assert.equal(
                hash(await readFile(path.join(projectRoot, 'private', 'assets', 'Planets', filename))),
                sourceHashes.get(filename)
            );
        }
    });
});

test('mismatched existing destination stops without overwriting it', async () => {
    await createFixture(async (projectRoot) => {
        const destination = path.join(projectRoot, 'private', 'assets', 'Planets', PLANET_FILES[0]);
        const conflict = Buffer.from('user-owned bytes');
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, conflict);
        await assert.rejects(migratePlanetAssetsPrivate({ projectRoot, apply: true }), /will not be overwritten/);
        assert.deepEqual(await readFile(destination), conflict);
    });
});

test('planet approval mismatch aborts before changing public sources or existing private destinations', async () => {
    await createFixture(async (projectRoot) => {
        const approvalsPath = path.join(projectRoot, 'scripts', 'planet-asset-approvals.json');
        const approvals = JSON.parse(await readFile(approvalsPath, 'utf8'));
        approvals.approvals['assets/Planets/Map-111.png'] = '0'.repeat(64);
        await writeFile(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`);

        const privateDirectory = path.join(projectRoot, 'private', 'assets', 'Planets');
        await mkdir(privateDirectory, { recursive: true });
        const existingDestination = path.join(privateDirectory, PLANET_FILES[0]);
        const userOwnedBytes = Buffer.from('preserve existing user-owned destination');
        await writeFile(existingDestination, userOwnedBytes);
        const publicBefore = new Map(
            await Promise.all(PLANET_FILES.map(async (filename) => [
                filename,
                await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', filename))
            ] as const))
        );

        await assert.rejects(
            migratePlanetAssetsPrivate({ projectRoot, apply: true }),
            /does not match its approved fingerprint/
        );

        assert.deepEqual(await readFile(existingDestination), userOwnedBytes);
        assert.deepEqual(
            (await readdir(privateDirectory)).sort(),
            [PLANET_FILES[0]]
        );
        for (const [filename, bytes] of publicBefore) {
            assert.deepEqual(
                await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', filename)),
                bytes
            );
        }
    });
});

test('partial no-overwrite publication rolls back only files installed by this migration', async () => {
    await createFixture(async (projectRoot) => {
        let links = 0;
        await assert.rejects(migratePlanetAssetsPrivate({
            projectRoot,
            apply: true,
            publishLink: async (source: string, destination: string) => {
                links += 1;
                if (links === 2) {
                    throw new Error('injected link failure');
                }
                const { link } = await import('node:fs/promises');
                await link(source, destination);
            }
        }), /injected link failure/);
        const privatePlanets = path.join(projectRoot, 'private', 'assets', 'Planets');
        assert.deepEqual(await readdir(privatePlanets), []);
        assert.equal((await readdir(path.join(projectRoot, 'private'))).some((name) => name.startsWith('.planet-asset-migration-')), false);
    });
});

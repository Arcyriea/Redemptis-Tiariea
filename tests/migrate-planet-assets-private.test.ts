import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migratePlanetAssetsPrivate } from '../scripts/migrate-planet-assets-private.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const PLANET_FILES = ['Map-111.png', 'Map-122.png', 'Map-692.png'];
const DEFERRED_FILES = ['Map-111-2.png', 'Map-122-2.png'];

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
    for (const filename of [...PLANET_FILES, ...DEFERRED_FILES]) {
        await writeFile(
            path.join(projectRoot, 'public', 'assets', 'Planets', filename),
            await readFile(path.join(REPOSITORY_ROOT, 'public', 'assets', 'Planets', filename))
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
        for (const filename of DEFERRED_FILES) {
            assert.equal(
                await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', filename))
                    .then((bytes) => bytes.length > 0),
                true
            );
        }
    });
});

test('migration copies exact hashes, keeps deferred PNGs public-only, and retries idempotently', async () => {
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
        for (const filename of DEFERRED_FILES) {
            assert.equal(
                await readFile(path.join(projectRoot, 'private', 'assets', 'Planets', filename))
                    .then(() => true, (error) => error.code !== 'ENOENT'),
                false
            );
            assert.equal(
                (await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', filename))).length > 0,
                true
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

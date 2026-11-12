import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeVerifiedPublicDuplicates } from '../scripts/remove-migrated-public-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

async function createFixture(run: (projectRoot: string) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'asset-removal-'));
    try {
        for (const relative of [
            'scripts/asset-registry.json',
            'scripts/planet-asset-approvals.json',
            'src/assets/planet-runtime-references.json',
            'src/generated/runtimeAssetContract.ts',
            'src/generated/publicSvgManifest.ts',
            'src/main.ts',
            'index.html'
        ]) {
            const destination = path.join(projectRoot, relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await cp(path.join(REPOSITORY_ROOT, relative), destination);
        }
        for (const relative of ['public/assets', 'private/assets']) {
            await cp(path.join(REPOSITORY_ROOT, relative), path.join(projectRoot, relative), { recursive: true });
        }
        const manifest = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'public', 'assets', 'asset-manifest.json'), 'utf8'));
        for (const asset of manifest.assets) {
            const source = path.join(projectRoot, 'private', 'assets', ...asset.logicalPath.split('/').slice(1));
            const destination = path.join(projectRoot, 'public', ...asset.logicalPath.split('/'));
            await mkdir(path.dirname(destination), { recursive: true });
            await cp(source, destination);
        }
        await run(projectRoot);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

test('removes only verified ship duplicates and preserves private sources and other categories', async () => {
    await createFixture(async (projectRoot) => {
        const source = path.join(projectRoot, 'private', 'assets', 'Ships', 'human-dreadnought.svg');
        const sourceBytes = await readFile(source);
        const result = await removeVerifiedPublicDuplicates({ projectRoot, category: 'ships', apply: true });
        assert.equal(result.removed.length, 10);
        await assert.rejects(readFile(path.join(projectRoot, 'public', 'assets', 'Ships', 'human-dreadnought.svg')));
        assert.deepEqual(await readFile(source), sourceBytes);
        await readFile(path.join(projectRoot, 'public', 'assets', 'Components', 'Aistiaria', '01_side_hull_angular.svg'));
        await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-111.png'));
    });
});

test('refuses public deletion when the canonical private source is missing', async () => {
    await createFixture(async (projectRoot) => {
        const source = path.join(projectRoot, 'private', 'assets', 'Ships', 'human-dreadnought.svg');
        const publicCopy = path.join(projectRoot, 'public', 'assets', 'Ships', 'human-dreadnought.svg');
        await rm(source);
        await assert.rejects(
            removeVerifiedPublicDuplicates({ projectRoot, category: 'ships', apply: true }),
            /Canonical private source is missing/
        );
        await readFile(publicCopy);
    });
});

test('refuses the whole category before deletion when one public hash differs', async () => {
    await createFixture(async (projectRoot) => {
        const changedPublic = path.join(projectRoot, 'public', 'assets', 'Ships', 'human-dreadnought.svg');
        await writeFile(changedPublic, '<svg />');
        await assert.rejects(
            removeVerifiedPublicDuplicates({ projectRoot, category: 'ships', apply: true }),
            /hashes differ/
        );
        await readFile(path.join(projectRoot, 'public', 'assets', 'Ships', 'alien-interceptor.svg'));
        await readFile(changedPublic);
    });
});

test('planet removal preserves the separate Map-111-2 and Map-122-2 public files', async () => {
    await createFixture(async (projectRoot) => {
        const planetRoot = path.join(projectRoot, 'public', 'assets', 'Planets');
        await mkdir(planetRoot, { recursive: true });
        for (const [variant, source] of [['Map-111-2.png', 'Map-111.png'], ['Map-122-2.png', 'Map-122.png']]) {
            await cp(
                path.join(projectRoot, 'private', 'assets', 'Planets', source),
                path.join(planetRoot, variant)
            );
        }
        const result = await removeVerifiedPublicDuplicates({ projectRoot, category: 'planets', apply: true });
        assert.equal(result.removed.length, 5);
        await assert.rejects(readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-111.png')));
        await assert.rejects(readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-122.png')));
        await assert.rejects(readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-692.png')));
        await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-111-2.png'));
        await readFile(path.join(projectRoot, 'public', 'assets', 'Planets', 'Map-122-2.png'));
    });
});

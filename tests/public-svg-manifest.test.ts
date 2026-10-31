import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPublicSvgManifest, generatePublicSvgManifest } from '../scripts/generate-public-svg-manifest.mjs';

async function withAssetsFixture(run: (root: string) => Promise<void>) {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'public-svg-manifest-'));
    const assetsRoot = path.join(fixtureRoot, 'assets');
    await mkdir(assetsRoot);

    try {
        await run(assetsRoot);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
}

async function addAsset(assetsRoot: string, relativePath: string) {
    const filePath = path.join(assetsRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '<svg/>');
}

test('discovers nested SVGs case-insensitively and excludes planets and raster files', async () => {
    await withAssetsFixture(async (assetsRoot) => {
        await addAsset(assetsRoot, 'Ships/nested/ship.SvG');
        await addAsset(assetsRoot, 'Components/part.svg');
        await addAsset(assetsRoot, 'Components/image.png');
        await addAsset(assetsRoot, 'Planets/orbit.svg');
        await addAsset(assetsRoot, 'Planets/nested/map.SVG');

        const assets = await createPublicSvgManifest(assetsRoot);
        assert.deepEqual(assets.map((asset) => asset.url), [
            '/assets/Components/part.svg',
            '/assets/Ships/nested/ship.SvG'
        ]);
    });
});

test('encodes public URLs and creates stable relative-path keys', async () => {
    await withAssetsFixture(async (assetsRoot) => {
        await addAsset(assetsRoot, 'Ships/a ship #1.svg');
        await addAsset(assetsRoot, 'Ships/nested/other.svg');

        const first = await createPublicSvgManifest(assetsRoot);
        await addAsset(assetsRoot, 'Weapons/new.svg');
        const second = await createPublicSvgManifest(assetsRoot);
        const firstShip = first.find((asset) => asset.url === '/assets/Ships/a%20ship%20%231.svg');
        const secondShip = second.find((asset) => asset.url === '/assets/Ships/a%20ship%20%231.svg');

        assert.equal(firstShip?.key, 'public-ships-a-ship-1');
        assert.equal(secondShip?.key, firstShip?.key);
    });
});

test('adds legacy aliases to their existing SVG assets without duplicate entries', async () => {
    await withAssetsFixture(async (assetsRoot) => {
        await addAsset(assetsRoot, 'Ships/human-dreadnought.svg');
        await addAsset(assetsRoot, 'Ships/alien-interceptor.svg');
        await addAsset(assetsRoot, 'Components/Aistiaria/01_side_hull_angular.svg');

        const assets = await createPublicSvgManifest(assetsRoot);
        assert.equal(assets.length, 3);
        assert.deepEqual(assets.map((asset) => asset.aliases), [
            ['central-hull'],
            ['alien-interceptor'],
            ['human-dreadnought']
        ]);
    });
});

test('resolves sanitized-key collisions deterministically and reports them', async () => {
    await withAssetsFixture(async (assetsRoot) => {
        await addAsset(assetsRoot, 'Ships/A B.svg');
        await addAsset(assetsRoot, 'Ships/A-B.svg');
        await addAsset(assetsRoot, 'Ships/common.svg');
        await addAsset(assetsRoot, 'Turrets/common.svg');
        const first = await createPublicSvgManifest(assetsRoot);
        const second = await createPublicSvgManifest(assetsRoot);
        const duplicateFilenames = first.filter((asset) => asset.url.endsWith('/common.svg'));

        assert.equal(new Set(first.map((asset) => asset.key.toLowerCase())).size, 4);
        assert.equal(new Set(duplicateFilenames.map((asset) => asset.key)).size, 2);
        assert.deepEqual(first.map((asset) => asset.key), second.map((asset) => asset.key));
        assert.ok(first
            .filter((asset) => asset.url.endsWith('/A%20B.svg') || asset.url.endsWith('/A-B.svg'))
            .every((asset) => /^public-ships-a-b-[a-f0-9]{10}$/.test(asset.key)));
    });
});

test('does not rewrite an unchanged generated manifest', async () => {
    await withAssetsFixture(async (assetsRoot) => {
        await addAsset(assetsRoot, 'Ships/ship.svg');
        const outputFile = path.join(path.dirname(assetsRoot), 'generated', 'manifest.ts');
        await generatePublicSvgManifest(assetsRoot, outputFile);
        const firstContent = await readFile(outputFile, 'utf8');
        const fixedTime = new Date('2020-01-01T00:00:00Z');
        await utimes(outputFile, fixedTime, fixedTime);
        const firstModified = (await stat(outputFile)).mtimeMs;
        await generatePublicSvgManifest(assetsRoot, outputFile);

        assert.equal(await readFile(outputFile, 'utf8'), firstContent);
        assert.equal((await stat(outputFile)).mtimeMs, firstModified);
    });
});

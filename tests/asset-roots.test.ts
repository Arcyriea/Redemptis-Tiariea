import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ASSET_ROOTS, ASSET_SOURCE_ROOTS, logicalPathToUrl, resolveAssetSourcePath, resolvePhysicalDir } from '../scripts/asset-roots.mjs';
import { readAssetRegistry } from '../scripts/asset-registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('ASSET_SOURCE_ROOTS is canonical while ASSET_ROOTS remains a compatible alias', () => {
    assert.equal(ASSET_ROOTS, ASSET_SOURCE_ROOTS);
    assert.deepEqual(ASSET_SOURCE_ROOTS.map(({ logical, urlPrefix, recursive }) => ({ logical, urlPrefix, recursive })), [
        { logical: 'assets', urlPrefix: '/assets', recursive: true },
        { logical: 'minimap', urlPrefix: '/minimap', recursive: true },
        { logical: '', urlPrefix: '', recursive: false }
    ]);
});

test('logical paths resolve to the intended runtime URL exactly once for every source root', () => {
    assert.equal(logicalPathToUrl('assets/Ships/human-dreadnought.svg'), '/assets/Ships/human-dreadnought.svg');
    assert.equal(logicalPathToUrl('assets/Components/Yutiarin/Part 1.svg'), '/assets/Components/Yutiarin/Part%201.svg');
    assert.equal(logicalPathToUrl('assets/Planets/Map-111.png'), '/assets/Planets/Map-111.png');
    assert.equal(logicalPathToUrl('minimap/Capital-Ship.svg'), '/minimap/Capital-Ship.svg');
    assert.equal(logicalPathToUrl('favicon.svg'), '/favicon.svg');
    assert.equal(logicalPathToUrl('icons.svg'), '/icons.svg');
    assert.equal(logicalPathToUrl('assets/../favicon.svg'), null);
    assert.equal(logicalPathToUrl('/assets/Ships/human-dreadnought.svg'), null);
    assert.equal(logicalPathToUrl('assets\\Ships\\human-dreadnought.svg'), null);
});

test('registered SVG and PNG logical identities resolve only under private/assets', async () => {
    const registry = await readAssetRegistry(ROOT);
    const svg = registry.assets.filter((asset) => asset.contentType === 'SVG');
    const png = ['Map-111.png', 'Map-122.png', 'Map-692.png'].map((fileName) => `assets/Planets/${fileName}`);
    assert.equal(svg.length, 31);
    assert.equal(png.length, 3);
    for (const asset of [...svg, ...png.map((logicalPath) => ({ logicalPath }))]) {
        const source = resolveAssetSourcePath(asset.logicalPath, ROOT);
        assert.ok(source, `No canonical source mapping for ${asset.logicalPath}`);
        assert.equal(source, path.join(ROOT, 'private', 'assets', ...asset.logicalPath.slice('assets/'.length).split('/')));
        assert.equal(resolvePhysicalDir(asset.logicalPath)?.logical, 'assets');
    }
    assert.equal(resolveAssetSourcePath('minimap/Capital-Ship.svg', ROOT), path.join(ROOT, 'public', 'minimap', 'Capital-Ship.svg'));
});

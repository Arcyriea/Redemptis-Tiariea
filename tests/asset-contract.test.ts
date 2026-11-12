import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivePlanetIdentity } from '../scripts/asset-contract.mjs';

test('legacy numeric planet names keep their established runtime identities', () => {
    assert.deepEqual(derivePlanetIdentity('Map-111.png'), {
        assetId: 'rt.planet-map.map-111',
        logicalPath: 'assets/Planets/Map-111.png',
        textureKey: 'planetMap111',
        aliases: [],
        contentType: 'PNG',
        bundleId: 'planets'
    });
});

test('proper planet names and numeric variants derive stable unique identities', () => {
    const named = derivePlanetIdentity('Hushanyia.png');
    assert.equal(named.assetId, 'rt.planet-map.hushanyia');
    assert.equal(named.logicalPath, 'assets/Planets/Hushanyia.png');
    assert.equal(named.textureKey, 'planetMapHushanyia');
    assert.equal(named.bundleId, 'planets');

    const variant = derivePlanetIdentity('Map-111-2.png');
    assert.equal(variant.assetId, 'rt.planet-map.map-111-2');
    assert.equal(variant.textureKey, 'planetMapMap1112');
});

test('planet name parsing rejects unsupported filename shapes and extension casing', () => {
    for (const fileName of ['Hushanyia.PNG', 'Hushanyia Map.png', '.png', '111.png', 'Hushanyia..png']) {
        assert.throws(() => derivePlanetIdentity(fileName), /Invalid planet filename/);
    }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWeaponMuzzles } from '../src/weapons/WeaponTransform';

function assertPoint(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
    assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `expected x=${expected.x}, received ${actual.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `expected y=${expected.y}, received ${actual.y}`);
}

test('ship-local hardpoint positions rotate clockwise around the ship origin at cardinal angles', () => {
    const expected = [
        { rotationDeg: 0, point: { x: 110, y: 200 } },
        { rotationDeg: 90, point: { x: 100, y: 210 } },
        { rotationDeg: 180, point: { x: 90, y: 200 } },
        { rotationDeg: 270, point: { x: 100, y: 190 } }
    ];

    for (const entry of expected) {
        const [muzzle] = resolveWeaponMuzzles({
            ship: { x: 100, y: 200, rotationDeg: entry.rotationDeg },
            mount: { position: { x: 10, y: 0 }, rotationDeg: 0 },
            attachment: { position: { x: 0, y: 0 }, rotationDeg: 0 },
            muzzles: [{ position: { x: 0, y: 0 }, directionDeg: 0 }]
        });

        assertPoint(muzzle, entry.point);
        assert.equal(muzzle.directionDeg, entry.rotationDeg);
    }
});

test('mount, attachment, and muzzle transforms compose in parent-to-child order', () => {
    const [muzzle] = resolveWeaponMuzzles({
        ship: { x: 100, y: 200, rotationDeg: 90 },
        mount: { position: { x: 10, y: 0 }, rotationDeg: 30 },
        attachment: { position: { x: 2, y: 0 }, rotationDeg: 0 },
        muzzles: [{ position: { x: 0, y: 4 }, directionDeg: 15 }]
    });

    assertPoint(muzzle, { x: 95.53589838486225, y: 209.73205080756887 });
    assert.equal(muzzle.directionDeg, 135);
});

test('multiple muzzle transforms preserve authored order and per-muzzle direction', () => {
    const muzzles = resolveWeaponMuzzles({
        ship: { x: 100, y: 200, rotationDeg: 90 },
        mount: { position: { x: 10, y: 0 }, rotationDeg: 0 },
        attachment: { position: { x: 0, y: 0 }, rotationDeg: 0 },
        muzzles: [
            { position: { x: 0, y: 0 }, directionDeg: 0 },
            { position: { x: 0, y: 4 }, directionDeg: -10 }
        ]
    });

    assert.equal(muzzles.length, 2);
    assertPoint(muzzles[0], { x: 100, y: 210 });
    assert.equal(muzzles[0].directionDeg, 90);
    assertPoint(muzzles[1], { x: 96, y: 210 });
    assert.equal(muzzles[1].directionDeg, 80);
});

test('empty muzzle geometry produces one origin muzzle and preserves accumulated angles', () => {
    const muzzles = resolveWeaponMuzzles({
        ship: { x: 100, y: 200, rotationDeg: -450 },
        mount: { position: { x: 10, y: 0 }, rotationDeg: -30 },
        attachment: { position: { x: 2, y: 0 }, rotationDeg: -15 },
        muzzles: []
    });

    assert.equal(muzzles.length, 1);
    assertPoint(muzzles[0], { x: 99, y: 188.26794919243113 });
    assert.equal(muzzles[0].directionDeg, -495);
});

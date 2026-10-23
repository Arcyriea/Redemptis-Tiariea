import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ObjectPool } from '../src/core/ObjectPool';
import { ShipManager } from '../src/managers/ShipManager';

function createConfiguredGame(): Game {
    const game = Object.create(Game.prototype) as Game;
    Game.instance = game;
    game.shipData = {};
    game.componentData = {};
    game.shipManager = new ShipManager(game);
    game.loadGameData();
    game.objectPool = new ObjectPool();
    return game;
}

test('player blueprint is catalogue-backed and separates gameplay from visuals', () => {
    const game = createConfiguredGame();
    const blueprint = game.shipManager!.getBlueprint('ship.player');

    assert.ok(blueprint);
    if (!blueprint) throw new Error('Expected player blueprint to be registered.');
    assert.equal(game.shipManager!.getBlueprintForSourceKey('player'), blueprint);
    assert.equal(blueprint.sourceKey, 'player');
    assert.equal(blueprint.isLoaded, true);
    assert.equal(blueprint.definition, blueprint.shipDefinition);
    assert.equal(game.shipData.player, undefined);
    assert.deepEqual(blueprint.shipDefinition?.gameplay.parts, [
        { name: 'central-hull', x: 0, y: 0, rotation: 0, isLoot: false }
    ]);
    assert.deepEqual(blueprint.shipDefinition?.gameplay.components, [
        { partIndex: 0, name: 'PlayerCannon' }
    ]);
    assert.deepEqual(blueprint.shipDefinition?.visual.sprites, [
        { textureKey: 'human-dreadnought', x: 0, y: 0, scale: 0.18 },
        { textureKey: 'ship-wing', x: -20, y: -25 },
        { textureKey: 'ship-wing', x: -20, y: 25 },
        { textureKey: 'hardpoint', x: 30, y: 0 },
        { textureKey: 'hardpoint', x: -10, y: -20 },
        { textureKey: 'hardpoint', x: -10, y: 20 }
    ]);
    assert.deepEqual(game.componentData.PlayerCannon, [
        'Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0
    ]);
});

test('Ship.init builds the player runtime ship and preserves its effective stats', () => {
    const game = createConfiguredGame();
    const ship = game.objectPool!.getShipObject('player', 'Ally');

    assert.ok(ship);
    if (!ship) throw new Error('Expected the player ship to be acquired.');
    assert.deepEqual(
        {
            type: ship.type,
            alignment: ship.alignment,
            superType: ship.superType,
            subType: ship.subType,
            name: ship.name,
            categoryType: ship.categoryType,
            maxHull: ship.maxHull,
            maxShell: ship.maxShell,
            maxEnergy: ship.maxEnergy,
            maxSpeed: ship.maxSpeed,
            acceleration: ship.acceleration,
            weight: ship.weight,
            radius: ship.radius,
            value: ship.value
        },
        {
            type: 'player',
            alignment: 'Ally',
            superType: 'Ship',
            subType: 'Player',
            name: 'Player Ship',
            categoryType: 'Air',
            maxHull: 25,
            maxShell: 50,
            maxEnergy: 100,
            maxSpeed: 5,
            acceleration: 0.5,
            weight: 10,
            radius: 20,
            value: 0
        }
    );

    assert.equal(ship.parts.length, 1);
    assert.deepEqual(
        {
            name: ship.parts[0].name,
            x: ship.parts[0].x,
            y: ship.parts[0].y,
            rotation: ship.parts[0].rotation,
            maxHull: ship.parts[0].maxHull
        },
        { name: 'central-hull', x: 0, y: 0, rotation: 0, maxHull: 100 }
    );
    assert.equal(ship.components.length, 1);
    assert.equal(ship.compWeapon.length, 1);
    assert.equal(ship.components[0], ship.compWeapon[0]);
    assert.equal(ship.compWeapon[0].subType, 'ProjectileArcade');
    assert.equal(ship.compWeapon[0].effect?.damage, 10);
    assert.equal(ship.compWeapon[0].effect?.range, 400);
    assert.equal(ship.compWeapon[0].effect?.projectileSpeed, 600);
    assert.equal(ship.compWeapon[0].cooldown, 0.15);
    assert.equal(ship.compWeapon[0].energyCost, 5);
});

test('legacy ship definitions remain available through the existing catalogue', () => {
    const game = createConfiguredGame();
    const legacyDefinition = [
        [['legacy-hull', 1, 2, 3, false]],
        [],
        'Ship',
        'Legacy',
        'Legacy Ship',
        'Air'
    ];
    game.shipData.legacy = legacyDefinition;

    assert.equal(game.shipManager!.syncFromGame(), 1);
    const blueprint = game.shipManager!.getBlueprintForSourceKey('legacy');
    assert.ok(blueprint);
    if (!blueprint) throw new Error('Expected the legacy ship blueprint to be registered.');
    assert.equal(blueprint.definition, legacyDefinition);

    const ship = game.objectPool!.getShipObject('legacy', 'Enemy');
    assert.ok(ship);
    if (!ship) throw new Error('Expected the legacy ship to be acquired.');
    assert.equal(ship.subType, 'Legacy');
    assert.equal(ship.parts.length, 1);
    assert.equal(ship.parts[0].x, 5);
    assert.equal(ship.parts[0].y, 10);
    assert.equal(ship.parts[0].rotation, 3);
});

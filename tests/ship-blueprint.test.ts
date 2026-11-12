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
    game.shipQueue = [];
    game.shipManager = new ShipManager(game);
    game.loadGameData();
    game.objectPool = new ObjectPool();
    return game;
}

test('player blueprint is catalogue-backed and uses canonical hull, loadout, and scene visuals', () => {
    const game = createConfiguredGame();
    const blueprint = game.shipManager!.getBlueprint('ship.player');

    assert.ok(blueprint);
    if (!blueprint) throw new Error('Expected player blueprint to be registered.');
    assert.equal(game.shipManager!.getBlueprintForSourceKey('player'), blueprint);
    assert.equal(blueprint.sourceKey, 'player');
    assert.equal(blueprint.isLoaded, true);
    assert.equal(blueprint.definition, blueprint.shipDefinition);
    assert.equal(game.shipData.player, undefined);
    assert.equal(game.componentData.PlayerCannon, undefined);
    assert.deepEqual(
        {
            hullId: blueprint.shipDefinition && 'hullId' in blueprint.shipDefinition
                ? blueprint.shipDefinition.hullId
                : undefined,
            loadoutId: blueprint.shipDefinition && 'loadoutId' in blueprint.shipDefinition
                ? blueprint.shipDefinition.loadoutId
                : undefined
        },
        { hullId: 'hull.player', loadoutId: 'loadout.player' }
    );

    const hull = game.hullDefinitions.get('hull.player');
    assert.ok(hull);
    assert.deepEqual(hull?.parts, [{
        id: 'part.player.central-hull',
        name: 'central-hull',
        position: { x: 0, y: 0 },
        rotationDeg: 0,
        isLoot: false
    }]);
    assert.deepEqual(hull?.weaponHardpoints, [{
        id: 'mount.player.spinal',
        position: { x: 0, y: 0 },
        rotationDeg: 0,
        accepts: ['spinal'],
        restrictions: {}
    }]);

    const loadout = game.shipLoadouts.get('loadout.player');
    assert.deepEqual(loadout?.installations, [{
        mountId: 'mount.player.spinal',
        componentId: 'PlayerCannon'
    }]);

    const playerCannon = game.componentDefinitions.get('PlayerCannon');
    assert.ok(playerCannon);
    assert.equal(playerCannon?.kind, 'weapon');
    assert.equal(playerCannon?.kind === 'weapon' ? playerCannon.configuration : undefined, 'spinal');
    assert.deepEqual(playerCannon?.kind === 'weapon' ? playerCannon.operation : undefined, {
        firingMode: 'ProjectileArcade',
        damage: 10,
        range: 400,
        cooldown: 0.15,
        energyCost: 5,
        projectileSpeed: 600,
        splashRadius: 0
    });
    assert.deepEqual(playerCannon?.kind === 'weapon' ? playerCannon.attachment : undefined, {
        position: { x: 0, y: 0 },
        attachmentRotationDeg: 0
    });
    assert.deepEqual(playerCannon?.kind === 'weapon' ? playerCannon.visuals.fixed : undefined, []);
    assert.deepEqual(playerCannon?.kind === 'weapon' ? playerCannon.geometry.muzzles : undefined, []);

    assert.deepEqual(game.playerVisualSprites, [
        { textureKey: 'human-dreadnought', x: 0, y: 0, scale: 0.18 },
        { textureKey: 'ship-wing', x: -20, y: -25 },
        { textureKey: 'ship-wing', x: -20, y: 25 },
        { textureKey: 'hardpoint', x: 30, y: 0 },
        { textureKey: 'hardpoint', x: -10, y: -20 },
        { textureKey: 'hardpoint', x: -10, y: 20 }
    ]);
});

test('Ship.init builds the player runtime ship and preserves its effective stats', () => {
    const game = createConfiguredGame();
    const ship = game.objectPool!.getShipObject('player');

    assert.ok(ship);
    if (!ship) throw new Error('Expected the player ship to be acquired.');
    assert.deepEqual(
        {
            type: ship.type,
            superType: ship.superType,
            subType: ship.subType,
            name: ship.name,
            categoryType: ship.categoryType,
            maxHull: ship.maxHull,
            maxShell: ship.maxShell,
            maxEnergy: ship.maxEnergy,
            regenEnergy: ship.regenEnergy,
            maxSpeed: ship.maxSpeed,
            acceleration: ship.acceleration,
            weight: ship.weight,
            radius: ship.radius,
            value: ship.value
        },
        {
            type: 'player',
            superType: 'Ship',
            subType: 'Player',
            name: 'Player Ship',
            categoryType: 'Air',
            maxHull: 25,
            maxShell: 50,
            maxEnergy: 100,
            regenEnergy: 20,
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
    assert.equal(ship.compWeapon[0].installationSource, 'loadout');
    assert.equal(ship.compWeapon[0].fixed, false);
    assert.deepEqual(
        [ship.compWeapon[0].shipPart.x, ship.compWeapon[0].shipPart.y, ship.compWeapon[0].shipPart.rotation],
        [0, 0, 0]
    );
    assert.equal(ship.subType, 'Player');
    assert.equal(ship.tractor?.ship, ship);
    assert.equal(game.shipQueue.includes(ship), false);
    assert.equal(ship.compWeapon[0].effect?.type, 'ProjectileArcade');
    assert.equal(ship.compWeapon[0].effect?.damage, 10);
    assert.equal(ship.compWeapon[0].effect?.range, 400);
    assert.equal(ship.compWeapon[0].effect?.projectileSpeed, 600);
    assert.equal(ship.compWeapon[0].cooldown, 0.15);
    assert.equal(ship.compWeapon[0].energyCost, 5);
});

test('blueprint regeneration defaults to 20 and preserves explicit overrides', () => {
    const defaultGame = createConfiguredGame();
    const defaultBlueprint = defaultGame.shipManager!.getBlueprint('ship.player')!;
    delete defaultBlueprint.shipDefinition!.stats.regenEnergy;
    const defaultShip = defaultGame.objectPool!.getShipObject('player');

    assert.ok(defaultShip);
    assert.equal(defaultShip.regenEnergy, 20);

    const overrideGame = createConfiguredGame();
    const overrideBlueprint = overrideGame.shipManager!.getBlueprint('ship.player')!;
    overrideBlueprint.shipDefinition!.stats.regenEnergy = 7;
    const overrideShip = overrideGame.objectPool!.getShipObject('player');

    assert.ok(overrideShip);
    assert.equal(overrideShip.regenEnergy, 7);
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

    const ship = game.objectPool!.getShipObject('legacy');
    assert.ok(ship);
    if (!ship) throw new Error('Expected the legacy ship to be acquired.');
    assert.equal(ship.subType, 'Legacy');
    assert.equal(ship.parts.length, 1);
    assert.equal(ship.parts[0].x, 5);
    assert.equal(ship.parts[0].y, 10);
    assert.equal(ship.parts[0].rotation, 3);
});

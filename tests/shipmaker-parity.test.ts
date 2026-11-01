import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ShipDataAdapter } from '../src/core/ShipDataAdapter';
import { Component } from '../src/entities/Component';
import { Ship } from '../src/entities/Ship';
import {
    ComponentDefinition,
    LegacyComponentTuple,
    toHullPartId,
    toHullPointId
} from '../src/types/Shipmaker';
import type { LegacyShipDefinition } from '../src/managers/ShipBlueprint';

function createLegacyGame(partX = 0, partY = 0): Game {
    const game = new Game();
    game.shipData = {
        legacy_fighter: [
            [['hull_main', partX, partY, 0, false, 100]],
            ['PlayerCannon'],
            'Ship',
            'Fighter',
            'Legacy Fighter',
            'Air'
        ]
    };
    game.componentData = {
        PlayerCannon: ['Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0]
    };
    ShipDataAdapter.ingestLegacyData(game);
    game.shipManager!.syncFromGame();
    return game;
}

function registerCanonicalBlueprint(game: Game): void {
    const hullId = 'hull.canonical';
    const loadoutId = 'loadout.canonical';
    const mountId = toHullPointId('nose');
    const weapon: ComponentDefinition = {
        id: 'CanonicalCannon',
        kind: 'weapon',
        configuration: 'spinal',
        operation: {
            firingMode: 'ProjectileArcade',
            damage: 10,
            range: 400,
            cooldown: 0.15,
            energyCost: 5,
            projectileSpeed: 600,
            splashRadius: 0
        },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        visuals: { fixed: [] },
        geometry: { muzzles: [] }
    };

    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [{
            id: toHullPartId('core'),
            name: 'main',
            position: { x: 20, y: 30 },
            rotationDeg: 0,
            isLoot: false,
            maxHull: 100
        }],
        sprites: [],
        weaponHardpoints: [{
            id: mountId,
            position: { x: 40, y: 50 },
            rotationDeg: 0,
            accepts: ['spinal'],
            restrictions: {}
        }],
        thrusterVents: [],
        utilitySockets: []
    });

    game.componentDefinitions.set(weapon.id, weapon);
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [{ mountId, componentId: weapon.id }]
    });
    game.shipManager!.registerBlueprint('ship.canonical', 'canonical', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Canonical Fighter',
        categoryType: 'Air',
        stats: {
            maxHull: 100,
            maxShell: 50,
            regenShell: 0,
            maxEnergy: 100,
            maxSpeed: 5,
            acceleration: 0.5,
            weight: 10,
            radius: 20,
            value: 100
        }
    });
}

test('legacy hull coordinates are converted to runtime pixels once and tuple indexes are preserved', () => {
    const game = createLegacyGame(10, -20);
    const ship = new Ship();
    ship.init('legacy_fighter');

    assert.deepEqual(
        [ship.parts[0].x, ship.parts[0].y, ship.parts[0].isLoot, ship.parts[0].maxHull],
        [50, -100, false, 100]
    );
    assert.equal(game.hullDefinitions.get('hull.legacy_fighter')?.parts[0].position.x, 50);
});

test('legacy compatibility maps part-index attachments to distinct hull points while preserving part origin', () => {
    const game = createLegacyGame();
    const ship = new Ship();
    ship.init('legacy_fighter');

    const attachment = game.legacyCompatibilityViews.get('legacy_fighter')?.legacyAttachments[0];
    assert.ok(attachment);
    assert.equal(
        attachment.mountId,
        game.hullDefinitions.get('hull.legacy_fighter')?.weaponHardpoints[0].id
    );
    assert.notEqual(attachment.mountId, game.hullDefinitions.get('hull.legacy_fighter')?.parts[0].id);
    assert.equal(ship.components.length, 1);
    assert.equal(ship.components[0].shipPart, ship.parts[0]);
});

test('legacy PlayerCannon operation values and player initialization behavior are preserved', () => {
    const game = new Game();
    const ship = new Ship();
    ship.init('player');

    const weapon = ship.compWeapon[0].effect;
    assert.ok(weapon);
    assert.deepEqual(
        [weapon.type, weapon.damage, weapon.range, weapon.cooldown, weapon.energyCost, weapon.projectileSpeed, weapon.splashRadius],
        ['ProjectileArcade', 10, 400, 0.15, 5, 600, 0]
    );
    assert.equal(ship.tractor?.ship, ship);
    assert.equal(game.shipQueue.includes(ship), false);
});

test('legacy Skill, Spawn, and Passive component categories retain their behavior', () => {
    const game = createLegacyGame();
    game.componentData = {
        PlayerCannon: ['Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0],
        SkillModule: ['Skill', 'SkillModule', 1, 2, 3, 'skill description'],
        SpawnModule: ['Spawn', 'SpawnModule', 1, 2, 3, 'spawn description'],
        PassiveModule: ['Passive', 'PassiveModule', 1, 2, 3, 'passive description']
    };
    const legacyDefinition: LegacyShipDefinition = [
        [
            ['skill-part', 0, 0, 0, false, 100],
            ['spawn-part', 1, 0, 0, false, 100],
            ['passive-part', 2, 0, 0, false, 100]
        ],
        ['SkillModule', 'SpawnModule', 'PassiveModule'],
        'Ship',
        'Worker',
        'Legacy Worker',
        'Air'
    ];
    game.shipData.legacy_worker = legacyDefinition;
    ShipDataAdapter.ingestLegacyData(game);
    game.shipManager!.syncFromGame();

    const ship = new Ship();
    ship.init('legacy_worker');
    assert.equal(ship.compSkill.length, 1);
    assert.equal(ship.compSpawn.length, 1);
    assert.equal(ship.compPassive.length, 1);
    assert.equal(ship.tractor?.ship, ship);
});

test('canonical geometry is used directly and loadout mounts resolve to declared hull points', () => {
    const game = new Game();
    registerCanonicalBlueprint(game);
    const ship = new Ship();
    ship.init('canonical');

    assert.deepEqual([ship.parts[0].x, ship.parts[0].y], [20, 30]);
    assert.equal(ship.components.length, 1);
    assert.deepEqual([ship.components[0].shipPart.x, ship.components[0].shipPart.y], [40, 50]);
    assert.equal(ship.compWeapon[0].effect?.damage, 10);
});

test('canonical invalid mounting points fail explicitly', () => {
    const game = new Game();
    registerCanonicalBlueprint(game);
    game.shipLoadouts.get('loadout.canonical')!.installations = [
        { mountId: toHullPointId('missing'), componentId: 'CanonicalCannon' }
    ];

    assert.throws(() => new Ship().init('canonical'), /Mount point "missing" not found/);
});

test('built-in components are materialized as fixed instances and reserve their points', () => {
    const game = new Game();
    registerCanonicalBlueprint(game);
    const hull = game.hullDefinitions.get('hull.canonical')!;
    const hardpoint = hull.weaponHardpoints[0];
    hull.weaponHardpoints = [{ ...hardpoint, builtInComponentId: 'CanonicalCannon' }];
    game.shipLoadouts.get('loadout.canonical')!.installations = [];

    const ship = new Ship();
    ship.init('canonical');
    assert.equal(ship.components.length, 1);
    assert.equal(ship.components[0].installationSource, 'built-in');
    assert.equal(ship.components[0].fixed, true);

    const conflictingGame = new Game();
    registerCanonicalBlueprint(conflictingGame);
    const conflictingHull = conflictingGame.hullDefinitions.get('hull.canonical')!;
    conflictingHull.weaponHardpoints = [{
        ...conflictingHull.weaponHardpoints[0],
        builtInComponentId: 'CanonicalCannon'
    }];
    assert.throws(
        () => new Ship().init('canonical'),
        /replaces built-in component/
    );
});

test('legacy component and weapon defaults apply to falsy and missing values in raw and adapted paths', () => {
    const tuples = {
        WeaponFalsy: ['Weapon', '', 0, 0, 0, 0, 0, 0] as LegacyComponentTuple,
        WeaponMissing: ['Weapon', 'ProjectileArcade'] as unknown as LegacyComponentTuple,
        PassiveFalsy: ['Passive', '', 0, 0, 0, ''] as LegacyComponentTuple,
        PassiveMissing: ['Passive'] as unknown as LegacyComponentTuple
    };

    const rawGame = Object.create(Game.prototype) as Game;
    rawGame.componentData = tuples;
    rawGame.componentDefinitions = new Map();
    rawGame.projectileManager = null;

    const verifyLegacyDefaults = (game: Game): void => {
        Game.instance = game;
        for (const id of ['WeaponFalsy', 'WeaponMissing']) {
            const component = new Component();
            component.init(id);
            assert.deepEqual(
                [
                    component.type,
                    component.subType,
                    component.value,
                    component.cooldown,
                    component.energyCost,
                    component.effect?.type,
                    component.effect?.damage,
                    component.effect?.range,
                    component.effect?.projectileSpeed,
                    component.effect?.splashRadius
                ],
                [
                    'Weapon',
                    id === 'WeaponMissing' ? 'ProjectileArcade' : id,
                    0,
                    1,
                    5,
                    id === 'WeaponMissing' ? 'ProjectileArcade' : 'Cannon',
                    10,
                    300,
                    10,
                    0
                ]
            );
        }

        for (const id of ['PassiveFalsy', 'PassiveMissing']) {
            const component = new Component();
            component.init(id);
            assert.deepEqual(
                [component.type, component.subType, component.value, component.cooldown, component.energyCost, component.description],
                ['Passive', id, 0, 1, 0, '']
            );
        }
    };

    verifyLegacyDefaults(rawGame);

    const adaptedGame = new Game();
    adaptedGame.shipData = {};
    adaptedGame.componentData = tuples;
    ShipDataAdapter.ingestLegacyData(adaptedGame);
    verifyLegacyDefaults(adaptedGame);
});

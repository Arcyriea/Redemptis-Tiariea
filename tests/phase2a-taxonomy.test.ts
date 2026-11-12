import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ShipDataAdapter } from '../src/core/ShipDataAdapter';
import { Component } from '../src/entities/Component';
import { Ship } from '../src/entities/Ship';
import {
    ComponentDefinition,
    toHullPartId,
    toHullPointId
} from '../src/types/Shipmaker';

function createTaxonomyGame(): Game {
    const game = new Game();
    game.shipData = {};
    game.componentData = {
        PlayerCannon: ['Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0],
        LegacySkill: ['Skill', 'LegacySkill', 1, 2, 3, 'desc'],
        LegacyPassive: ['Passive', 'LegacyPassive', 1, 2, 3, 'desc'],
        LegacySpawn: ['Spawn', 'LegacySpawn', 1, 2, 3, 'desc']
    };
    ShipDataAdapter.ingestLegacyData(game);
    game.shipManager!.syncFromGame();
    return game;
}

test('canonical Active Module retains distinct identity and is not classified as a legacy Skill', () => {
    const game = createTaxonomyGame();
    const activeModDef: ComponentDefinition = {
        id: 'CanonicalModule',
        kind: 'active-module',
        category: 'Tactical',
        operation: { cooldown: 10, energyCost: 20 },
        payload: { kind: 'resource_restore', shell: 0, hull: 0, energy: 0 },
        targeting: { kind: 'self' },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        sprites: []
    };
    game.componentDefinitions.set(activeModDef.id, activeModDef);

    const component = new Component();
    component.init(activeModDef);

    assert.equal(component.type, 'ActiveModule', 'Canonical Active Modules should have type "ActiveModule"');
    assert.notEqual(component.type, 'Skill', 'Canonical Active Modules should NOT be classified as legacy "Skill"');
    assert.equal(component.subType, 'Tactical');
    assert.equal(component.cooldown, 10);
    assert.equal(component.energyCost, 20);
});

test('ActiveModuleMount compatibility validation', () => {
    const game = createTaxonomyGame();
    const activeModDef: ComponentDefinition = {
        id: 'CanonicalModule',
        kind: 'active-module',
        category: 'Tactical',
        operation: { cooldown: 10, energyCost: 20 },
        payload: { kind: 'resource_restore', shell: 0, hull: 0, energy: 0 },
        targeting: { kind: 'self' },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        sprites: []
    };
    game.componentDefinitions.set(activeModDef.id, activeModDef);

    const hullId = 'hull.test';
    const mountId = toHullPointId('mod-mount');
    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [{ id: toHullPartId('p1'), name: 'm', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false }],
        sprites: [],
        weaponHardpoints: [],
        activeModuleMounts: [{
            id: mountId,
            position: { x: 0, y: 0 },
            rotationDeg: 0,
            acceptedCategories: ['Tactical'],
            restrictions: {}
        }],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: 0
    });

    const loadoutId = 'loadout.test';
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [{ mountId, componentId: activeModDef.id }]
    });

    game.shipManager!.registerBlueprint('ship.test', 'test', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ship',
        categoryType: 'Air',
        stats: { maxHull: 100, maxShell: 50, regenShell: 0, maxEnergy: 100, maxSpeed: 5, acceleration: 0.5, weight: 10, radius: 20, value: 100 }
    });

    const ship = new Ship();
    ship.init('test');
    assert.equal(ship.components.length, 1);
    assert.equal(ship.components[0].type, 'ActiveModule');
});

test('ActiveModuleMount compatibility fails for wrong category', () => {
    const game = createTaxonomyGame();
    const activeModDef: ComponentDefinition = {
        id: 'CanonicalModule',
        kind: 'active-module',
        category: 'Tactical',
        operation: { cooldown: 10, energyCost: 20 },
        payload: { kind: 'resource_restore', shell: 0, hull: 0, energy: 0 },
        targeting: { kind: 'self' },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        sprites: []
    };
    game.componentDefinitions.set(activeModDef.id, activeModDef);

    const hullId = 'hull.test';
    const mountId = toHullPointId('mod-mount');
    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [{ id: toHullPartId('p1'), name: 'm', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false }],
        sprites: [],
        weaponHardpoints: [],
        activeModuleMounts: [{
            id: mountId,
            position: { x: 0, y: 0 },
            rotationDeg: 0,
            acceptedCategories: ['Electronic'], // Different category
            restrictions: {}
        }],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: 0
    });

    const loadoutId = 'loadout.test';
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [{ mountId, componentId: activeModDef.id }]
    });

    game.shipManager!.registerBlueprint('ship.test', 'test', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ship',
        categoryType: 'Air',
        stats: { maxHull: 100, maxShell: 50, regenShell: 0, maxEnergy: 100, maxSpeed: 5, acceleration: 0.5, weight: 10, radius: 20, value: 100 }
    });

    assert.throws(() => new Ship().init('test'), /is incompatible with mounting point/);
});

test('duplicate mounting-point assignments fail explicitly', () => {
    const game = createTaxonomyGame();
    const weaponDef: ComponentDefinition = {
        id: 'Cannon',
        kind: 'weapon',
        configuration: 'spinal',
        operation: { firingMode: 'C', damage: 1, range: 1, cooldown: 1, energyCost: 1, projectileSpeed: 1, splashRadius: 0 },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        visuals: { fixed: [] },
        geometry: { muzzles: [] }
    };
    game.componentDefinitions.set(weaponDef.id, weaponDef);

    const hullId = 'hull.test';
    const mountId = toHullPointId('m1');
    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [{ id: toHullPartId('p1'), name: 'm', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false }],
        sprites: [],
        weaponHardpoints: [{ id: mountId, position: { x: 0, y: 0 }, rotationDeg: 0, accepts: ['spinal'], restrictions: {} }],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: 0
    });

    const loadoutId = 'loadout.test';
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [
            { mountId, componentId: weaponDef.id },
            { mountId, componentId: weaponDef.id }
        ]
    });

    game.shipManager!.registerBlueprint('ship.test', 'test', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ship',
        categoryType: 'Air',
        stats: { maxHull: 100, maxShell: 50, regenShell: 0, maxEnergy: 100, maxSpeed: 5, acceleration: 0.5, weight: 10, radius: 20, value: 100 }
    });

    assert.throws(() => new Ship().init('test'), /installs multiple components at/);
});

test('built-in mount reservation is preserved', () => {
    const game = createTaxonomyGame();
    const weaponDef: ComponentDefinition = {
        id: 'BuiltInCannon',
        kind: 'weapon',
        configuration: 'spinal',
        operation: { firingMode: 'C', damage: 1, range: 1, cooldown: 1, energyCost: 1, projectileSpeed: 1, splashRadius: 0 },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        visuals: { fixed: [] },
        geometry: { muzzles: [] }
    };
    game.componentDefinitions.set(weaponDef.id, weaponDef);

    const hullId = 'hull.test';
    const mountId = toHullPointId('m1');
    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [{ id: toHullPartId('p1'), name: 'm', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false }],
        sprites: [],
        weaponHardpoints: [{ id: mountId, position: { x: 0, y: 0 }, rotationDeg: 0, accepts: ['spinal'], restrictions: {}, builtInComponentId: weaponDef.id }],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: 0
    });

    const loadoutId = 'loadout.test';
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [{ mountId, componentId: weaponDef.id }]
    });

    game.shipManager!.registerBlueprint('ship.test', 'test', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ship',
        categoryType: 'Air',
        stats: { maxHull: 100, maxShell: 50, regenShell: 0, maxEnergy: 100, maxSpeed: 5, acceleration: 0.5, weight: 10, radius: 20, value: 100 }
    });

    assert.throws(() => new Ship().init('test'), /replaces built-in component/);
});

test('unverified legacy Skill, Passive, and Spawn remain in compatibility path and not in canonical loadout', () => {
    const game = createTaxonomyGame();
    const hullId = 'hull.legacy';
    const loadoutId = 'loadout.legacy';
    
    game.hullDefinitions.set(hullId, {
        id: hullId,
        parts: [
            { id: toHullPartId('p0'), name: 'm0', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false },
            { id: toHullPartId('p1'), name: 'm1', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false },
            { id: toHullPartId('p2'), name: 'm2', position: { x: 0, y: 0 }, rotationDeg: 0, isLoot: false }
        ],
        sprites: [],
        weaponHardpoints: [],
        activeModuleMounts: [],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: 0
    });

    // We simulate the ShipDataAdapter output: 
    // A ship that has legacy components but no canonical ones.
    game.shipLoadouts.set(loadoutId, {
        id: loadoutId,
        installations: [] // Should be empty for legacy-only components
    });

    game.legacyCompatibilityViews.set('legacy_ship', {
        hullId,
        loadoutId,
        legacyAttachments: [
            { partIndex: 0, mountId: toHullPointId('m1'), componentId: 'LegacySkill' },
            { partIndex: 1, mountId: toHullPointId('m2'), componentId: 'LegacyPassive' },
            { partIndex: 2, mountId: toHullPointId('m3'), componentId: 'LegacySpawn' }
        ]
    });

    game.shipManager!.registerBlueprint('ship.legacy', 'legacy_ship', {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Worker',
        name: 'Legacy Worker',
        categoryType: 'Air',
        stats: { maxHull: 100, maxShell: 50, regenShell: 0, maxEnergy: 100, maxSpeed: 5, acceleration: 0.5, weight: 10, radius: 20, value: 100 }
    });

    const ship = new Ship();
    ship.init('legacy_ship');
    
    assert.equal(ship.compSkill.length, 1);
    assert.equal(ship.compPassive.length, 1);
    assert.equal(ship.compSpawn.length, 1);
    assert.equal(ship.components.length, 3);
    
    // Ensure they aren't canonical components
    assert.equal(ship.components[0].installationSource, 'legacy');
});

test('no dangling canonical ShipLoadout installation references for legacy components', () => {
    const game = createTaxonomyGame();
    
    // Mock legacy data as if it was in Game
    game.shipData = {
        legacy_ship: [
            [
                ['p0', 0, 0, 0, false, 100],
                ['p1', 0, 0, 0, false, 100],
                ['p2', 0, 0, 0, false, 100]
            ],
            ['LegacySkill', 'LegacyPassive'],
            'Ship', 'Fighter', 'Legacy Ship', 'Air'
        ]
    };
    
    ShipDataAdapter.ingestLegacyData(game);
    
    const loadout = game.shipLoadouts.get('loadout.legacy_ship');
    assert.ok(loadout);
    assert.equal(loadout.installations.length, 0, 'Canonical loadout should not contain legacy components');
});

test('PlayerCannon uses canonical records registered after legacy ingestion', () => {
    const game = new Game();
    const ship = new Ship();
    ship.init('player');

    assert.equal(game.componentData.PlayerCannon, undefined);
    assert.equal(game.componentDefinitions.get('PlayerCannon')?.kind, 'weapon');
    assert.equal(game.hullDefinitions.has('hull.player'), true);
    assert.equal(game.shipLoadouts.has('loadout.player'), true);
    assert.equal(ship.compWeapon.length, 1);
    assert.equal(ship.compWeapon[0].type, 'Weapon');
    assert.equal(ship.compWeapon[0].installationSource, 'loadout');
    assert.equal(ship.compWeapon[0].fixed, false);
});

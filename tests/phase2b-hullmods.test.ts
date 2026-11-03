import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ShipDataAdapter } from '../src/core/ShipDataAdapter';
import { Ship } from '../src/entities/Ship';
import {
    HullDefinition,
    HullModificationDefinition,
    HullModificationId,
    ShipBlueprintDefinition,
    ShipBlueprintStats,
    StatModifier,
    StatModifierType,
    toHullModificationId,
    toHullPartId
} from '../src/types/Shipmaker';

const BASE_STATS: ShipBlueprintStats = {
    maxHull: 100,
    maxShell: 50,
    regenShell: 2,
    maxEnergy: 100,
    regenEnergy: 5,
    maxSpeed: 10,
    acceleration: 2,
    weight: 20,
    radius: 8,
    value: 100
};

function createGame(): Game {
    const game = new Game();
    game.shipData = {};
    game.componentData = {};
    ShipDataAdapter.ingestLegacyData(game);
    return game;
}

function registerCanonicalShip(
    game: Game,
    sourceKey: string,
    capacity: number,
    stats: ShipBlueprintStats = BASE_STATS
): { ship: Ship; hull: HullDefinition } {
    const hullId = `hull.${sourceKey}`;
    const loadoutId = `loadout.${sourceKey}`;
    const hull: HullDefinition = {
        id: hullId,
        parts: [{
            id: toHullPartId(`${sourceKey}.part`),
            name: 'Core',
            position: { x: 0, y: 0 },
            rotationDeg: 0,
            isLoot: false
        }],
        sprites: [],
        weaponHardpoints: [],
        activeModuleMounts: [],
        thrusterVents: [],
        utilitySockets: [],
        hullModCapacity: capacity
    };
    const definition: ShipBlueprintDefinition = {
        hullId,
        loadoutId,
        superType: 'Ship',
        subType: 'Fighter',
        name: sourceKey,
        categoryType: 'Air',
        stats: { ...stats }
    };
    game.hullDefinitions.set(hullId, hull);
    game.shipLoadouts.set(loadoutId, { id: loadoutId, installations: [] });
    game.shipManager!.registerBlueprint(`ship.${sourceKey}`, sourceKey, definition);

    const ship = new Ship();
    ship.init(sourceKey);
    return { ship, hull };
}

function registerMod(
    game: Game,
    key: string,
    modifiers: readonly StatModifier[],
    conflicts?: readonly HullModificationId[]
): HullModificationId {
    const id = toHullModificationId(key);
    const definition: HullModificationDefinition = {
        id,
        name: key,
        description: key,
        modifiers,
        ...(conflicts === undefined ? {} : { conflicts })
    };
    game.hullModificationDefinitions.set(id, definition);
    return id;
}

function statsOf(ship: Ship): ShipBlueprintStats {
    return {
        maxHull: ship.maxHull,
        maxShell: ship.maxShell,
        regenShell: ship.regenShell,
        maxEnergy: ship.maxEnergy,
        regenEnergy: ship.regenEnergy,
        maxSpeed: ship.maxSpeed,
        acceleration: ship.acceleration,
        weight: ship.weight,
        radius: ship.radius,
        value: ship.value
    };
}

function resourcesOf(ship: Ship): number[] {
    return [ship.currentHull, ship.currentShell, ship.currentEnergy];
}

function stateOf(ship: Ship): {
    mods: HullModificationId[];
    stats: ShipBlueprintStats;
    resources: number[];
} {
    return {
        mods: Array.from(ship.hullMods),
        stats: statsOf(ship),
        resources: resourcesOf(ship)
    };
}

function additive(stat: StatModifier['stat'], value: number): StatModifier {
    return { stat, type: StatModifierType.Additive, value };
}

function multiplicative(stat: StatModifier['stat'], value: number): StatModifier {
    return { stat, type: StatModifierType.Multiplicative, value };
}

test('canonical initialization captures the complete no-mod baseline and its hull', () => {
    const game = createGame();
    const { ship, hull } = registerCanonicalShip(game, 'baseline', 2);

    assert.deepEqual(statsOf(ship), BASE_STATS);
    const baseStats = Reflect.get(ship, 'baseStats');
    assert.ok(baseStats);
    assert.equal(baseStats.maxHull, BASE_STATS.maxHull);
    assert.equal(Reflect.get(ship, 'hullDefinition'), hull);
    assert.deepEqual(Array.from(ship.hullMods), []);
});

test('single additive and multiplicative modifiers change only their declared statistic', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'single', 2);
    const addId = registerMod(game, 'mod.single-add', [additive('maxHull', 25)]);
    const multiplyId = registerMod(game, 'mod.single-multiply', [multiplicative('maxSpeed', 1.5)]);

    assert.equal(ship.addHullMod(addId), true);
    assert.equal(ship.maxHull, 125);
    assert.equal(ship.maxShell, BASE_STATS.maxShell);
    assert.equal(ship.maxSpeed, BASE_STATS.maxSpeed);
    assert.equal(ship.removeHullMod(addId), true);
    assert.equal(ship.addHullMod(multiplyId), true);
    assert.equal(ship.maxSpeed, 15);
    assert.equal(ship.maxHull, BASE_STATS.maxHull);
});

test('multiple mods and mixed modifier types use additive-then-multiplicative stacking', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'formula', 4);
    const combined = registerMod(game, 'mod.b-combined', [
        additive('maxHull', 10),
        multiplicative('maxHull', 1.5)
    ]);
    const additiveId = registerMod(game, 'mod.a-additive', [additive('maxHull', 20)]);
    const multiplyId = registerMod(game, 'mod.c-multiply', [multiplicative('maxHull', 2)]);

    assert.equal(ship.addHullMod(combined), true);
    assert.equal(ship.addHullMod(additiveId), true);
    assert.equal(ship.addHullMod(multiplyId), true);
    assert.equal(ship.maxHull, (100 + 10 + 20) * 1.5 * 2);
});

test('installation order does not affect the calculated result', () => {
    const game = createGame();
    const first = registerCanonicalShip(game, 'order-first', 3).ship;
    const second = registerCanonicalShip(game, 'order-second', 3).ship;
    const addId = registerMod(game, 'mod.order-add', [
        additive('maxHull', 10),
        additive('maxHull', 5)
    ]);
    const multiplyId = registerMod(game, 'mod.order-multiply', [
        multiplicative('maxHull', 1.25)
    ]);
    const otherAddId = registerMod(game, 'mod.order-other-add', [
        additive('maxHull', 30)
    ]);

    for (const id of [addId, multiplyId, otherAddId]) assert.equal(first.addHullMod(id), true);
    for (const id of [otherAddId, addId, multiplyId]) assert.equal(second.addHullMod(id), true);

    assert.equal(first.maxHull, 145 * 1.25);
    assert.deepEqual(statsOf(first), statsOf(second));
});

test('repeated candidate recalculations and install/remove cycles do not accumulate stats', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'stable', 1);
    const id = registerMod(game, 'mod.stable', [additive('maxHull', 12)]);
    assert.equal(ship.addHullMod(id), true);
    const expected = statsOf(ship);
    const calculateStats = Reflect.get(ship, 'calculateStats');

    for (let iteration = 0; iteration < 5; iteration++) {
        const candidate = Reflect.apply(calculateStats, ship, [new Set(ship.hullMods)]);
        assert.deepEqual(candidate, expected);
        assert.deepEqual(statsOf(ship), expected);
    }

    for (let iteration = 0; iteration < 3; iteration++) {
        assert.equal(ship.removeHullMod(id), true);
        assert.deepEqual(statsOf(ship), BASE_STATS);
        assert.equal(ship.addHullMod(id), true);
        assert.deepEqual(statsOf(ship), expected);
    }
});

test('installation, removal, unknown IDs, duplicates, and absent removal use public APIs', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'api', 2);
    const id = registerMod(game, 'mod.api', [additive('maxHull', 10)]);
    const unknownId = toHullModificationId('mod.unknown');

    assert.equal(ship.addHullMod(unknownId), false);
    assert.equal(ship.removeHullMod(id), false);
    assert.equal(ship.addHullMod(id), true);
    assert.equal(ship.addHullMod(id), false);
    assert.equal(ship.removeHullMod(id), true);
    assert.deepEqual(Array.from(ship.hullMods), []);
    assert.deepEqual(statsOf(ship), BASE_STATS);
});

test('capacity belongs to the assigned canonical hull and prevents overflow', () => {
    const game = createGame();
    const { ship, hull } = registerCanonicalShip(game, 'capacity', 1);
    const first = registerMod(game, 'mod.capacity-first', []);
    const second = registerMod(game, 'mod.capacity-second', []);

    assert.equal(ship.addHullMod(first), true);
    assert.equal(ship.addHullMod(second), false);
    assert.deepEqual(Array.from(ship.hullMods), [first]);
    assert.equal(Reflect.get(ship, 'hullDefinition'), hull);
});

test('missing, fractional, negative, NaN, and infinite capacity reject installation', () => {
    const invalidCapacities: Array<number | undefined> = [
        undefined,
        0.5,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY
    ];

    for (const [index, capacity] of invalidCapacities.entries()) {
        const game = createGame();
        const { ship, hull } = registerCanonicalShip(game, `invalid-capacity-${index}`, 1);
        const id = registerMod(game, `mod.invalid-capacity-${index}`, []);
        if (capacity === undefined) {
            Reflect.deleteProperty(hull, 'hullModCapacity');
        } else {
            Reflect.set(hull, 'hullModCapacity', capacity);
        }

        assert.equal(ship.addHullMod(id), false);
        assert.deepEqual(Array.from(ship.hullMods), []);
    }
});

test('conflicts declared by either installed or incoming mods reject without replacing mods', () => {
    const game = createGame();
    const firstShip = registerCanonicalShip(game, 'conflict-existing', 3).ship;
    const incomingConflict = toHullModificationId('mod.conflict-incoming');
    const installedConflict = registerMod(game, 'mod.conflict-installed', [], [incomingConflict]);
    registerMod(game, 'mod.conflict-incoming', []);

    assert.equal(firstShip.addHullMod(installedConflict), true);
    const priorState = stateOf(firstShip);
    assert.equal(firstShip.addHullMod(incomingConflict), false);
    assert.deepEqual(stateOf(firstShip), priorState);

    const secondShip = registerCanonicalShip(game, 'conflict-incoming', 3).ship;
    const existing = toHullModificationId('mod.conflict-existing');
    registerMod(game, 'mod.conflict-existing', []);
    const incoming = registerMod(game, 'mod.conflict-new-declares', [], [existing]);
    assert.equal(secondShip.addHullMod(existing), true);
    assert.equal(secondShip.addHullMod(incoming), false);
    assert.deepEqual(Array.from(secondShip.hullMods), [existing]);
});

test('defensive hullMods getter cannot mutate the authoritative selection', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'getter', 2);
    const id = registerMod(game, 'mod.getter', []);

    assert.equal(ship.addHullMod(id), true);
    const exposed = ship.hullMods as Set<HullModificationId>;
    exposed.clear();
    exposed.add(toHullModificationId('mod.injected'));

    assert.deepEqual(Array.from(ship.hullMods), [id]);
});

test('invalid definitions and modifiers are rejected without changing ship state', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'invalid-mod', 5);
    const id = registerMod(game, 'mod.malformed', [additive('maxHull', 10)]);
    const definition = game.hullModificationDefinitions.get(id)!;
    const before = stateOf(ship);

    Reflect.set(definition, 'id', toHullModificationId('mod.wrong-id'));
    assert.equal(ship.addHullMod(id), false);
    Reflect.set(definition, 'id', id);
    Reflect.set(definition, 'modifiers', null);
    assert.equal(ship.addHullMod(id), false);
    Reflect.set(definition, 'modifiers', [{ stat: 'unsupported', type: StatModifierType.Additive, value: 1 }]);
    assert.equal(ship.addHullMod(id), false);
    Reflect.set(definition, 'modifiers', [{ stat: 'maxHull', type: 99, value: 1 }]);
    assert.equal(ship.addHullMod(id), false);
    Reflect.set(definition, 'modifiers', [{ stat: 'maxHull', type: StatModifierType.Additive, value: Number.NaN }]);
    assert.equal(ship.addHullMod(id), false);
    Reflect.set(definition, 'modifiers', [{ stat: 'maxHull', type: StatModifierType.Multiplicative, value: -1 }]);
    assert.equal(ship.addHullMod(id), false);
    assert.deepEqual(stateOf(ship), before);
});

test('overflowing modifier calculations and asymmetric invalid conflicts fail atomically', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'overflow', 3);
    const first = registerMod(game, 'mod.overflow-first', [
        additive('maxHull', Number.MAX_VALUE)
    ]);
    const second = registerMod(game, 'mod.overflow-second', [
        additive('maxHull', Number.MAX_VALUE)
    ]);

    assert.equal(ship.addHullMod(first), true);
    const before = stateOf(ship);
    assert.equal(ship.addHullMod(second), false);
    assert.deepEqual(stateOf(ship), before);

    const invalidConflicts = registerMod(game, 'mod.invalid-conflicts', []);
    const invalidDefinition = game.hullModificationDefinitions.get(invalidConflicts)!;
    Reflect.set(invalidDefinition, 'conflicts', 'not-an-array');
    assert.equal(ship.addHullMod(invalidConflicts), false);
    assert.deepEqual(stateOf(ship), before);
});

test('increased maxima preserve all current resources and reduced maxima clamp only excess', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'resources', 3);
    const increase = registerMod(game, 'mod.resources-increase', [
        additive('maxHull', 50),
        additive('maxShell', 50),
        additive('maxEnergy', 50)
    ]);
    const modestDecrease = registerMod(game, 'mod.resources-modest-decrease', [
        additive('maxHull', -20),
        additive('maxShell', -20),
        additive('maxEnergy', -20)
    ]);
    const furtherDecrease = registerMod(game, 'mod.resources-further-decrease', [
        additive('maxHull', -60),
        additive('maxShell', -60),
        additive('maxEnergy', -60)
    ]);
    ship.currentHull = 60;
    ship.currentShell = 45;
    ship.currentEnergy = 70;

    assert.equal(ship.addHullMod(increase), true);
    assert.deepEqual(resourcesOf(ship), [60, 45, 70]);
    assert.equal(ship.addHullMod(modestDecrease), true);
    assert.deepEqual(resourcesOf(ship), [60, 45, 70]);

    ship.currentHull = 140;
    ship.currentShell = 90;
    ship.currentEnergy = 140;
    assert.equal(ship.addHullMod(furtherDecrease), true);
    assert.deepEqual(resourcesOf(ship), [70, 20, 70]);
});

test('failed installation preserves selection, effective stats, and all current resources', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'failed-install', 3);
    const installed = registerMod(game, 'mod.install-valid', [additive('maxHull', 10)]);
    const malformed = registerMod(game, 'mod.install-malformed', [additive('maxShell', 10)]);
    assert.equal(ship.addHullMod(installed), true);
    ship.currentHull = 37;
    ship.currentShell = 22;
    ship.currentEnergy = 61;
    const before = stateOf(ship);
    Reflect.set(game.hullModificationDefinitions.get(malformed)!.modifiers[0], 'value', Number.POSITIVE_INFINITY);

    assert.equal(ship.addHullMod(malformed), false);
    assert.deepEqual(stateOf(ship), before);
});

test('failed removal preserves selection, effective stats, and resources', () => {
    const game = createGame();
    const { ship } = registerCanonicalShip(game, 'failed-remove', 3);
    const first = registerMod(game, 'mod.remove-first', [additive('maxHull', 10)]);
    const retained = registerMod(game, 'mod.remove-retained', [additive('maxShell', 10)]);
    assert.equal(ship.addHullMod(first), true);
    assert.equal(ship.addHullMod(retained), true);
    ship.currentHull = 45;
    ship.currentShell = 30;
    ship.currentEnergy = 65;
    const before = stateOf(ship);
    Reflect.set(game.hullModificationDefinitions.get(retained)!.modifiers[0], 'value', Number.NaN);

    assert.equal(ship.removeHullMod(first), false);
    assert.deepEqual(stateOf(ship), before);
});

test('legacy initialization retains adapter baseline and its explicit zero-capacity hull', () => {
    const game = createGame();
    game.shipData = {
        legacy_hullmod: [
            [['legacy-core', 0, 0, 0, false, 80]],
            [],
            'Ship',
            'Fighter',
            'Legacy Hull',
            'Air'
        ]
    };
    ShipDataAdapter.ingestLegacyData(game);
    game.shipManager!.syncFromGame();

    const ship = new Ship();
    ship.init('legacy_hullmod');
    const hull = game.hullDefinitions.get('hull.legacy_hullmod');
    assert.ok(hull);
    assert.equal(hull.hullModCapacity, 0);
    assert.equal(Reflect.get(ship, 'hullDefinition'), hull);
    assert.equal(ship.maxHull, 20);
    assert.equal(ship.maxShell, 40);
    assert.equal(ship.weight, 10);
    assert.equal(ship.addHullMod(registerMod(game, 'mod.legacy', [])), false);
});

test('reset and pooled reuse clear prior modifications, baseline, and hull ownership', () => {
    const game = createGame();
    const { hull } = registerCanonicalShip(game, 'pooled', 1);
    const id = registerMod(game, 'mod.pooled', [additive('maxHull', 25)]);
    const ship = game.objectPool!.getShipObject('pooled')!;
    assert.equal(Reflect.get(ship, 'hullDefinition'), hull);
    assert.equal(ship.addHullMod(id), true);
    assert.equal(ship.maxHull, BASE_STATS.maxHull + 25);

    game.objectPool!.disposeShipObject(ship);
    assert.deepEqual(Array.from(ship.hullMods), []);
    assert.equal(Reflect.get(ship, 'baseStats'), null);
    assert.equal(Reflect.get(ship, 'hullDefinition'), null);
    assert.equal(ship.addHullMod(id), false);

    const reused = game.objectPool!.getShipObject('pooled');
    assert.equal(reused, ship);
    assert.deepEqual(Array.from(reused!.hullMods), []);
    assert.deepEqual(statsOf(reused!), BASE_STATS);
    assert.equal(Reflect.get(reused!, 'hullDefinition'), hull);
});

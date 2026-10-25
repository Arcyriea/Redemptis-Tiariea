import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ObjectPool } from '../src/core/ObjectPool';
import { Ability } from '../src/abilities/Ability';
import { Entity } from '../src/entities/Entity';
import { EntityManager } from '../src/managers/EntityManager';
import {
    AISTIARIA,
    FactionManager,
    YUTIARINALIA,
    RESERVED_FACTIONS,
    createFactionId
} from '../src/managers/FactionManager';
import { ShipManager } from '../src/managers/ShipManager';

function createFactionManager(): FactionManager {
    return new FactionManager();
}

function createGame(): Game {
    const game = Object.create(Game.prototype) as Game;
    Game.instance = game;
    game.shipData = {};
    game.componentData = {};
    game.objectPool = new ObjectPool();
    game.entityManager = new EntityManager();
    game.factionManager = new FactionManager();
    game.shipManager = new ShipManager(game);
    game.queueAlly = [];
    game.queueEnemy = [];
    game.queueTanks = [];
    game.queueStations = [];
    game.shipQueue = [];
    game.effectsQueue = [];
    game.queueResource = [];
    game.pupQueue = [];
    game.spawnQueue = [];
    game.respawnQueue = [];
    game.objectPool.getEffect = () => null;
    return game;
}

function entity(): Entity {
    return { active: true, removeIt: false };
}

test('registers built-in factions and initializes their relationship', () => {
    const manager = createFactionManager();

    assert.equal(manager.factionCount(), 2 + RESERVED_FACTIONS.length);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, AISTIARIA), 'Enemy');
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, YUTIARINALIA), 'Ally');
    assert.equal(manager.getFactionRelationship(AISTIARIA, AISTIARIA), 'Ally');
});

test('registers every README faction as reserved with no configured relationships', () => {
    const manager = createFactionManager();

    assert.equal(new Set(RESERVED_FACTIONS).size, RESERVED_FACTIONS.length);
    assert.deepEqual(RESERVED_FACTIONS, [
        'Verdania Principality',
        'Harmonica',
        'Imperica',
        'Evangelista',
        'Divinica',
        'Amethysca',
        'Yinyalista',
        'Caliphista',
        'Doraniaca',
        'Isilica',
        'Sulmakaraik',
        'Kulsirakyil',
        'Ulthyriakyiai',
        'Caliphathic Eden',
        'Astral Union',
        'Jurisdictate Council',
        'United Galactic Federation',
        'Elven Ijyiakaryai',
        'Free Innomini'
    ]);
    for (const faction of RESERVED_FACTIONS) {
        assert.equal(manager.isFactionRegistered(faction), true);
        assert.equal(manager.getRelationshipScore(YUTIARINALIA, faction), 0);
        assert.equal(manager.getFactionRelationship(YUTIARINALIA, faction), 'Neutral');
    }
});
test('creates faction IDs and rejects invalid IDs', () => {
    assert.equal(createFactionId('Zurg'), 'Zurg');
    assert.throws(() => createFactionId(''));
    assert.throws(() => createFactionId('   '));
    assert.throws(() => createFactionId(123 as never));
});

test('registerFaction is idempotent and relationship pairs default to neutral', () => {
    const manager = createFactionManager();
    const zurg = createFactionId('Zurg');

    manager.registerFaction(zurg);
    manager.registerFaction(zurg);

    assert.equal(manager.factionCount(), 3 + RESERVED_FACTIONS.length);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, zurg), 0);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, zurg), 'Neutral');
    assert.equal(manager.isFactionNeutral(YUTIARINALIA, zurg), true);
});

test('derives exact inclusive relationship thresholds', () => {
    const manager = createFactionManager();
    const faction = createFactionId('Threshold');
    manager.registerFaction(faction);

    manager.setRelationshipScore(YUTIARINALIA, faction, -50);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, faction), 'Enemy');
    manager.setRelationshipScore(YUTIARINALIA, faction, -49);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, faction), 'Neutral');
    manager.setRelationshipScore(YUTIARINALIA, faction, 49);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, faction), 'Neutral');
    manager.setRelationshipScore(YUTIARINALIA, faction, 50);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, faction), 'Ally');
});

test('validates score values, faction registration, and self-relationships', () => {
    const manager = createFactionManager();
    const unregistered = createFactionId('Missing');

    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, AISTIARIA, 150));
    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, AISTIARIA, -150));
    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, AISTIARIA, Number.NaN));
    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, AISTIARIA, Number.POSITIVE_INFINITY));
    assert.throws(() => manager.adjustRelationshipScore(YUTIARINALIA, AISTIARIA, Number.NaN));
    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, YUTIARINALIA, 1));
    assert.throws(() => manager.adjustRelationshipScore(YUTIARINALIA, YUTIARINALIA, 1));
    assert.throws(() => manager.setRelationshipScore(YUTIARINALIA, unregistered, 0));
    assert.throws(() => manager.adjustRelationshipScore(YUTIARINALIA, unregistered, 1));
});

test('adjusts with clamping and keeps faction-pair relationships symmetric', () => {
    const manager = createFactionManager();
    const zurg = createFactionId('Zurg');
    manager.registerFaction(zurg);

    manager.adjustRelationshipScore(YUTIARINALIA, zurg, 200);
    assert.equal(manager.getRelationshipScore(zurg, YUTIARINALIA), 100);
    assert.equal(manager.isFactionAlly(zurg, YUTIARINALIA), true);

    manager.adjustRelationshipScore(zurg, YUTIARINALIA, -300);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, zurg), -100);
    assert.equal(manager.isFactionEnemy(YUTIARINALIA, zurg), manager.isFactionEnemy(zurg, YUTIARINALIA));
});

test('relationship state changes as the faction-pair score crosses thresholds', () => {
    const manager = createFactionManager();

    assert.equal(manager.getFactionRelationship(YUTIARINALIA, AISTIARIA), 'Enemy');
    manager.adjustRelationshipScore(YUTIARINALIA, AISTIARIA, 60);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -40);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, AISTIARIA), 'Neutral');
    manager.adjustRelationshipScore(YUTIARINALIA, AISTIARIA, 90);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, AISTIARIA), 50);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, AISTIARIA), 'Ally');
});

test('tracks and clears entity membership safely', () => {
    const manager = createFactionManager();
    const ship = entity();
    const missingFaction = createFactionId('Missing');

    assert.equal(manager.getFaction(ship), undefined);
    assert.equal(manager.hasFaction(ship), false);
    assert.equal(manager.getFaction(null), undefined);
    assert.equal(manager.hasFaction(undefined), false);
    manager.clearFaction(null);
    manager.clearFaction(undefined);
    assert.throws(() => manager.setFaction(ship, missingFaction));

    manager.setFaction(ship, YUTIARINALIA);
    assert.equal(manager.size, 1);
    assert.equal(manager.getFaction(ship), YUTIARINALIA);
    assert.equal(manager.hasFaction(ship), true);
    manager.clearFaction(ship);
    assert.equal(manager.size, 0);
    assert.equal(manager.hasFaction(ship), false);
});

test('supports entity-to-entity and entity-to-faction relationship queries', () => {
    const manager = createFactionManager();
    const zurg = createFactionId('Zurg');
    manager.registerFaction(zurg);
    manager.setRelationshipScore(YUTIARINALIA, zurg, 49);

    const allyA = entity();
    const allyB = entity();
    const enemy = entity();
    const neutral = entity();
    manager.setFaction(allyA, YUTIARINALIA);
    manager.setFaction(allyB, YUTIARINALIA);
    manager.setFaction(enemy, AISTIARIA);
    manager.setFaction(neutral, zurg);

    assert.equal(manager.getRelationship(allyA, allyB), 'Ally');
    assert.equal(manager.isAlly(allyA, allyB), true);
    assert.equal(manager.isEnemy(allyA, enemy), true);
    assert.equal(manager.isNeutral(allyA, neutral), true);
    assert.equal(manager.isEnemyOfFaction(enemy, YUTIARINALIA), true);
    assert.equal(manager.isAllyOfFaction(allyA, YUTIARINALIA), true);
    assert.equal(manager.isNeutralTowardFaction(neutral, YUTIARINALIA), true);

    const factionless = entity();
    assert.equal(manager.getRelationship(allyA, factionless), undefined);
    assert.equal(manager.isAlly(allyA, factionless), false);
    assert.equal(manager.isEnemy(allyA, factionless), false);
    assert.equal(manager.isNeutral(allyA, factionless), false);
    assert.equal(manager.isEnemyOfFaction(factionless, YUTIARINALIA), false);
});

test('clear removes memberships but preserves faction-pair scores', () => {
    const manager = createFactionManager();
    const ship = entity();
    manager.setFaction(ship, AISTIARIA);

    manager.clear();

    assert.equal(manager.size, 0);
    assert.equal(manager.getFaction(ship), undefined);
    assert.equal(manager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    assert.equal(manager.getFactionRelationship(YUTIARINALIA, AISTIARIA), 'Enemy');
});

test('ships retain legacy queue routing while faction overrides only membership', () => {
    const game = createGame();
    const zurg = createFactionId('Zurg');
    game.factionManager.registerFaction(zurg);

    const ally = game.shipManager!.createShip('ship', 'Ally', 0, 0, { randomOffset: 0 });
    const enemy = game.shipManager!.createShip('ship', 'Enemy', 0, 0, {
        randomOffset: 0,
        faction: zurg
    });

    assert.equal(game.factionManager.getFaction(ally), YUTIARINALIA);
    assert.equal(game.factionManager.getFaction(enemy), zurg);
    assert.equal(enemy.alignment, 'Enemy');
    assert.deepEqual(game.queueAlly, [ally]);
    assert.deepEqual(game.queueEnemy, [enemy]);
    assert.throws(
        () => game.shipManager!.createShip('ship', 'Zurg', 0, 0, { faction: zurg }),
        /Unsupported alignment label/
    );
    assert.equal(game.queueAlly.length, 1);
    assert.equal(game.queueEnemy.length, 1);
});

test('pooled ship reuse clears its old faction and assigns the new faction', () => {
    const game = createGame();
    const ship = game.shipManager!.createShip('ship', 'Ally', 0, 0, { randomOffset: 0 });
    assert.ok(ship);
    if (!ship) throw new Error('Expected the ally ship to be created.');
    const firstId = ship.id;
    game.queueAlly.splice(game.queueAlly.indexOf(ship), 1);
    game.shipManager!.disposeShip(ship);

    assert.equal(game.factionManager.getFaction(ship), undefined);
    const reusedShip = game.shipManager!.createShip('ship', 'Enemy', 0, 0, { randomOffset: 0 });

    assert.equal(reusedShip, ship);
    assert.notEqual(reusedShip!.id, firstId);
    assert.equal(game.factionManager.getFaction(reusedShip), AISTIARIA);
    assert.deepEqual(game.queueEnemy, [ship]);
});

test('ability targeting and destruction rewards use faction relationships, not alignment', () => {
    const game = createGame();
    const zurg = createFactionId('Zurg');
    game.factionManager.registerFaction(zurg);
    game.factionManager.setRelationshipScore(YUTIARINALIA, zurg, 50);
    const ally = game.shipManager!.createShip('ship', 'Ally', 0, 0, { randomOffset: 0 });
    const sameFaction = game.shipManager!.createShip('ship', 'Enemy', 0, 0, {
        randomOffset: 0,
        faction: zurg
    });
    assert.ok(ally);
    assert.ok(sameFaction);
    if (!ally || !sameFaction) throw new Error('Expected both test ships to be created.');

    const ability = new Ability();
    ability.ship = ally;
    ability.canTargetAlly = true;
    assert.equal(ability.activate(sameFaction), true);
    assert.deepEqual(ability.targetedShips, [sameFaction]);

    game.factionManager.setRelationshipScore(YUTIARINALIA, zurg, -50);
    game.credits = 0;
    game.uiManager = { updateCredits: () => undefined } as Game['uiManager'];
    game.spawnPowerUp = () => null;
    const originalRandom = Math.random;
    Math.random = () => 1;
    try {
        sameFaction.value = 10000;
        sameFaction.explode();
        assert.equal(game.credits, 10);

        const alliedFactionEnemyAlignment = game.shipManager!.createShip('ship', 'Enemy', 0, 0, {
            randomOffset: 0,
            faction: YUTIARINALIA
        });
        assert.ok(alliedFactionEnemyAlignment);
        if (!alliedFactionEnemyAlignment) throw new Error('Expected the ally-faction ship to be created.');
        alliedFactionEnemyAlignment.value = 10000;
        alliedFactionEnemyAlignment.explode();
        assert.equal(game.credits, 10);
    } finally {
        Math.random = originalRandom;
    }
});

test('spawn failure rolls back queues, entity registration, and faction membership', () => {
    const game = createGame();
    let failedShip: import('../src/entities/Ship').Ship | undefined;
    const push = game.queueAlly.push.bind(game.queueAlly);
    game.queueAlly.push = (...ships) => {
        failedShip = ships[0];
        push(...ships);
        throw new Error('queue insertion failed');
    };

    assert.throws(
        () => game.shipManager!.createShip('ship', 'Ally', 0, 0, { randomOffset: 0 }),
        /queue insertion failed/
    );
    assert.ok(failedShip);
    Reflect.deleteProperty(game.queueAlly, 'push');
    assert.deepEqual(game.queueAlly, []);
    assert.equal(game.entityManager!.has(failedShip!), false);
    assert.equal(game.entityManager!.size, 0);
    assert.equal(game.factionManager.getFaction(failedShip), undefined);
    assert.equal(failedShip!.active, false);
});

test('ship creation rejects unregistered factions and a missing faction manager', () => {
    const game = createGame();
    const zurg = createFactionId('Zurg');

    assert.throws(
        () => game.shipManager!.createShip('ship', 'Ally', 0, 0, { faction: zurg }),
        /not registered/
    );
    game.factionManager = undefined!;
    assert.throws(
        () => game.shipManager!.createShip('ship', 'Ally', 0, 0),
        /FactionManager/
    );
});

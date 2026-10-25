import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ObjectPool } from '../src/core/ObjectPool';
import { EntityManager } from '../src/managers/EntityManager';
import { ShipManager } from '../src/managers/ShipManager';
import { Ship } from '../src/entities/Ship';
import { AISTIARIA, FactionManager, YUTIARINALIA } from '../src/managers/FactionManager';

function createGame(): Game {
    // This harness bypasses Game's constructor and initSystems(). It supplies
    // the state used by the Game methods under test; it does not test system
    // initialization or Phaser scene integration.
    const game = Object.create(Game.prototype) as Game;
    Game.instance = game;

    game.shipData = {};
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
    game.numAlly = 0;
    game.numEnemy = 0;

    // Spawn effects are outside the ship lifecycle exercised here.
    game.objectPool.getEffect = () => null;
    return game;
}

test('EntityManager registration is idempotent and pooled re-registration gets a fresh ID', () => {
    const game = createGame();
    const ship = game.shipManager!.createShip('undefined-type', 'Ally', 12, 34, { randomOffset: 0 });

    assert.ok(ship);
    const firstId = ship.id;
    game.entityManager!.register(ship, 'ship');
    game.entityManager!.register(ship, 'ship');
    assert.equal(game.entityManager!.size, 1);
    assert.equal(game.entityManager!.get(firstId!), ship);

    // disposeShip() expects its caller to remove the ship from its update queue.
    game.queueAlly.splice(game.queueAlly.indexOf(ship), 1);
    game.shipManager!.disposeShip(ship);
    assert.equal(game.factionManager.getFaction(ship), undefined);
    assert.equal(game.factionManager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    game.shipManager!.createShip('undefined-type', 'Ally', 0, 0);
    const reusedShip = game.queueAlly[0];

    assert.equal(reusedShip, ship);
    assert.notEqual(reusedShip.id, firstId);
    assert.equal(game.factionManager.getFaction(reusedShip), YUTIARINALIA);
    assert.equal(game.entityManager!.size, 1);
    assert.equal(game.entityManager!.get(reusedShip.id!), reusedShip);
});

test('processSpawnQueue initializes once per acquisition and routes/registers ships once', (t) => {
    const game = createGame();
    const originalInit = Ship.prototype.init;
    let initCalls = 0;
    Ship.prototype.init = function (this: Ship, type: string, alignment: string) {
        initCalls++;
        return originalInit.call(this, type, alignment);
    };
    t.after(() => {
        Ship.prototype.init = originalInit;
    });

    game.spawnQueue.push(
        ['undefined-type', 2, 'Ally', 100, 200],
        ['undefined-type', 1, 'Enemy', 300, 400]
    );
    game.processSpawnQueue();

    assert.equal(initCalls, 3);
    assert.equal(game.spawnQueue.length, 0);
    assert.equal(game.queueAlly.length, 2);
    assert.equal(game.queueEnemy.length, 1);
    assert.equal(game.entityManager!.size, 3);
    assert.equal(new Set([...game.queueAlly, ...game.queueEnemy]).size, 3);
    for (const ship of [...game.queueAlly, ...game.queueEnemy]) {
        assert.equal(game.entityManager!.get(ship.id!), ship);
    }

    game.processSpawnQueue();
    assert.equal(initCalls, 3);
    assert.equal(game.queueAlly.length, 2);
    assert.equal(game.queueEnemy.length, 1);
    assert.equal(game.entityManager!.size, 3);
});

test('normal removal unregisters and removes the ship once before pool reuse', () => {
    const game = createGame();
    const ally = game.spawnShip('undefined-type', 'Ally', 12, 34);
    const enemy = game.spawnShip('undefined-type', 'Enemy', 56, 78);
    const pool = game.objectPool!;
    const dispose = pool.disposeShipObject.bind(pool);
    let disposeCalls = 0;
    pool.disposeShipObject = (removedShip) => {
        disposeCalls++;
        dispose(removedShip);
    };

    ally.removeIt = true;
    enemy.removeIt = true;
    game.updateQueues();

    assert.deepEqual(game.queueAlly, []);
    assert.deepEqual(game.queueEnemy, []);
    assert.equal(game.entityManager!.has(ally), false);
    assert.equal(game.entityManager!.has(enemy), false);
    assert.equal(game.factionManager.hasFaction(ally), false);
    assert.equal(game.factionManager.hasFaction(enemy), false);
    assert.equal(game.factionManager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    assert.equal(game.entityManager!.size, 0);
    assert.equal(ally.active, false);
    assert.equal(enemy.active, false);
    assert.equal(disposeCalls, 2);

    game.updateQueues();
    assert.equal(disposeCalls, 2);
    assert.equal(game.entityManager!.size, 0);
});

test('pooled reuse restores scalar state reset by Ship.resetIt', () => {
    const game = createGame();
    const ship = game.shipManager!.createShip('undefined-type', 'Ally', 0, 0, {
        randomOffset: 0
    });
    assert.ok(ship);
    ship.moving = true;
    ship.immobile = true;
    ship.currentHull = 1;
    ship.currentShell = 1;
    ship.currentEnergy = 1;
    ship.removeIt = true;
    game.updateQueues();

    const reusedShip = game.spawnShip('undefined-type', 'Ally', 30, 40);
    assert.equal(reusedShip, ship);
    assert.deepEqual(
        {
            moving: reusedShip.moving,
            immobile: reusedShip.immobile,
            currentHull: reusedShip.currentHull,
            currentShell: reusedShip.currentShell,
            currentEnergy: reusedShip.currentEnergy
        },
        {
            moving: false,
            immobile: false,
            currentHull: reusedShip.maxHull,
            currentShell: reusedShip.maxShell,
            currentEnergy: reusedShip.maxEnergy
        }
    );
    // parts/components are built from shipData by Ship.init(); no definitions
    // are available here to verify their expected contents on pooled reuse.
});

test('characterizes current respawnQueue disposal behavior (not a respawn contract)', () => {
    const game = createGame();
    const ship = game.spawnShip('undefined-type', 'Ally', 0, 0);
    const firstId = ship.id;
    game.respawnQueue.push(ship);

    game.processRespawnQueue();

    assert.deepEqual(game.respawnQueue, []);
    assert.equal(game.entityManager!.has(ship), false);
    assert.equal(ship.active, false);
    assert.equal(game.queueAlly[0], ship);

    const reusedShip = game.spawnShip('undefined-type', 'Ally', 5, 6);
    assert.equal(reusedShip, ship);
    assert.notEqual(reusedShip.id, firstId);
    assert.deepEqual(game.queueAlly, [ship, ship]);
    assert.equal(game.entityManager!.size, 1);
});

test('characterizes faction counters: spawn does not increment, removal decrements', () => {
    const game = createGame();
    const ally = game.spawnShip('undefined-type', 'Ally', 0, 0);
    const enemy = game.spawnShip('undefined-type', 'Enemy', 0, 0);

    assert.deepEqual([game.numAlly, game.numEnemy], [0, 0]);

    ally.removeIt = true;
    enemy.removeIt = true;
    game.updateQueues();

    // Characterizes the current code only; no counter-to-queue invariant is
    // established by the existing implementation.
    assert.deepEqual([game.numAlly, game.numEnemy], [-1, -1]);
});

test('pooled reuse clears and rebuilds parts, components, subtype lists, and waypoints', () => {
    const game = createGame();
    game.shipData.player = [
        [['central-hull', 0, 0, 0, false]],
        [['PlayerCannon']],
        'Ship',
        'TestShip',
        'Test Ship',
        'Air'
    ];
    game.componentData = {
        PlayerCannon: ['Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0]
    };

    const ship = game.shipManager!.createShip('player', 'Ally', 0, 0, {
        randomOffset: 0,
        waypoints: [[10, 20]]
    });
    assert.ok(ship);
    if (!ship) throw new Error('Expected the configured test ship to be created.');
    assert.equal(ship.parts.length, 1);
    assert.equal(ship.components.length, 1);
    assert.equal(ship.compWeapon.length, 1);
    assert.equal(ship.compSkill.length, 0);
    assert.equal(ship.compSpawn.length, 0);
    assert.equal(ship.compPassive.length, 0);

    const oldPart = ship.parts[0];
    const oldComponent = ship.components[0];
    const oldWeapon = oldComponent.effect;
    oldComponent.ready = false;
    ship.removeIt = true;
    game.updateQueues();

    assert.deepEqual(ship.parts, []);
    assert.deepEqual(ship.components, []);
    assert.deepEqual(ship.compWeapon, []);
    assert.deepEqual(ship.compSkill, []);
    assert.deepEqual(ship.compSpawn, []);
    assert.deepEqual(ship.compPassive, []);
    assert.deepEqual(ship.waypoints, []);

    const reusedShip = game.spawnShip('player', 'Ally', 30, 40);

    assert.equal(reusedShip, ship);
    if (!reusedShip) throw new Error('Expected the disposed ship to be reused.');
    assert.equal(reusedShip.parts.length, 1);
    assert.notEqual(reusedShip.parts[0], oldPart);
    assert.equal(reusedShip.components.length, 1);
    assert.equal(reusedShip.compWeapon.length, 1);
    assert.equal(reusedShip.compSkill.length, 0);
    assert.equal(reusedShip.compSpawn.length, 0);
    assert.equal(reusedShip.compPassive.length, 0);
    assert.equal(reusedShip.components[0], reusedShip.compWeapon[0]);
    assert.notEqual(reusedShip.components[0], oldComponent);
    assert.notEqual(reusedShip.compWeapon[0].effect, oldWeapon);
    assert.equal(reusedShip.compWeapon[0].ready, true);
    assert.deepEqual(reusedShip.waypoints, []);
});

test('clearCurrentSector clears queues, registry, and pool safely when repeated', () => {
    const game = createGame();
    const ally = game.spawnShip('ally-type', 'Ally', 0, 0);
    const enemy = game.spawnShip('enemy-type', 'Enemy', 0, 0);
    game.spawnQueue.push(['queued-type', 1, 'Ally', 0, 0]);
    game.respawnQueue.push(enemy);
    const pool = game.objectPool!;
    const dispose = pool.disposeShipObject.bind(pool);
    let disposeCalls = 0;
    pool.disposeShipObject = (ship) => {
        disposeCalls++;
        dispose(ship);
    };

    game.clearCurrentSector();
    assert.deepEqual(game.shipQueue, []);
    assert.deepEqual(game.queueAlly, []);
    assert.deepEqual(game.queueEnemy, []);
    assert.deepEqual(game.queueTanks, []);
    assert.deepEqual(game.queueStations, []);
    assert.deepEqual(game.effectsQueue, []);
    assert.deepEqual(game.queueResource, []);
    assert.deepEqual(game.pupQueue, []);
    assert.deepEqual(game.spawnQueue, []);
    assert.deepEqual(game.respawnQueue, []);
    assert.equal(game.entityManager!.size, 0);
    assert.equal(game.factionManager.size, 0);
    assert.equal(game.factionManager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    assert.equal(ally.active, false);
    assert.equal(enemy.active, false);
    assert.equal(disposeCalls, 2);

    game.clearCurrentSector();
    assert.equal(game.entityManager!.size, 0);
    assert.equal(game.factionManager.size, 0);
    assert.equal(game.factionManager.getRelationshipScore(YUTIARINALIA, AISTIARIA), -100);
    assert.equal(disposeCalls, 2);
});

test('empty spawn processing and missing object pool do not create ships', () => {
    const game = createGame();
    game.processSpawnQueue();
    assert.equal(game.entityManager!.size, 0);

    game.objectPool = null;
    game.spawnQueue.push(['undefined-type', 1, 'Ally', 0, 0]);
    game.processSpawnQueue();

    assert.equal(game.spawnQueue.length, 0);
    assert.deepEqual(game.queueAlly, []);
    assert.equal(game.entityManager!.size, 0);
});

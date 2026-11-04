import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { Component } from '../src/entities/Component';
import { Ship } from '../src/entities/Ship';
import { AISTIARIA, YUTIARINALIA } from '../src/managers/FactionManager';
import type {
    ActiveModuleDefinition,
    ActiveModulePayload,
    ActiveModuleTargeting,
    LegacyComponentDef
} from '../src/types/Shipmaker';

interface ModuleOptions {
    targeting: ActiveModuleTargeting;
    payload?: ActiveModulePayload;
    cooldown?: number;
    energyCost?: number;
    chargeTime?: number;
}

let definitionId = 0;

function createShip(
    game: Game,
    faction = YUTIARINALIA,
    x = 0,
    y = 0
): Ship {
    const ship = new Ship();
    ship.game = game;
    ship.active = true;
    ship.removeIt = false;
    ship.x = x;
    ship.y = y;
    ship.currentShell = 0;
    ship.maxShell = 50;
    ship.currentHull = 0;
    ship.maxHull = 100;
    ship.currentEnergy = 100;
    ship.maxEnergy = 100;
    game.entityManager!.register(ship, 'ship');
    game.factionManager.setFaction(ship, faction);
    return ship;
}

function createModule(game: Game, ship: Ship, options: ModuleOptions): Component {
    const id = `phase2c-module-${++definitionId}`;
    const definition: ActiveModuleDefinition = {
        id,
        kind: 'active-module',
        category: 'test',
        operation: {
            cooldown: options.cooldown ?? 2,
            energyCost: options.energyCost ?? 10,
            ...(options.chargeTime === undefined ? {} : { chargeTime: options.chargeTime })
        },
        payload: options.payload ?? { kind: 'resource_restore', shell: 5, hull: 10, energy: 15 },
        targeting: options.targeting,
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        sprites: []
    };
    const component = new Component();
    component.init(definition, ship);
    return component;
}

test('canonical components own independent typed runtimes and self-target without faction lookup', async () => {
    const game = new Game();
    const firstShip = createShip(game);
    const secondShip = createShip(game);
    const targeting: ActiveModuleTargeting = { kind: 'self' };
    const first = createModule(game, firstShip, { targeting, chargeTime: 1 });
    const second = createModule(game, secondShip, { targeting, chargeTime: 1 });

    assert.equal(first.type, 'ActiveModule');
    assert.ok(first.activeModuleRuntime);
    assert.notEqual(first.activeModuleRuntime, second.activeModuleRuntime);
    assert.equal(await first.activate(), true);
    assert.equal(first.ready, false);
    assert.equal(second.ready, true);

    first.update(1000);
    assert.equal(firstShip.currentShell, 5);
    assert.equal(secondShip.currentShell, 0);
    assert.equal(first.ready, false);
});

test('canonical resource_restore preserves Boost-style restoration clamping', async () => {
    const game = new Game();
    const ship = createShip(game);
    ship.currentShell = 45;
    ship.currentHull = 95;
    ship.currentEnergy = 40;
    const component = createModule(game, ship, {
        targeting: { kind: 'self' },
        payload: { kind: 'resource_restore', shell: 20, hull: 20, energy: 25 }
    });

    assert.equal(await component.activate(), true);
    assert.deepEqual(
        [ship.currentShell, ship.currentHull, ship.currentEnergy],
        [50, 100, 55]
    );
});

test('single targeting enforces Ally and Enemy relationship filters', async () => {
    const game = new Game();
    const owner = createShip(game);
    const ally = createShip(game);
    const enemy = createShip(game, AISTIARIA);
    const allyModule = createModule(game, owner, {
        targeting: { kind: 'single', allowed: ['Ally'] }
    });
    const enemyModule = createModule(game, owner, {
        targeting: { kind: 'single', allowed: ['Enemy'] }
    });

    assert.equal(await allyModule.activate(enemy), false);
    assert.equal(owner.currentEnergy, 100);
    assert.equal(await allyModule.activate(ally), true);
    assert.equal(ally.currentShell, 5);
    assert.equal(await enemyModule.activate(enemy), true);
    assert.equal(enemy.currentShell, 5);
});

test('single target is retained during charging and revalidated at trigger time', async () => {
    const game = new Game();
    const owner = createShip(game);
    const selected = createShip(game);
    const other = createShip(game);
    const component = createModule(game, owner, {
        targeting: { kind: 'single', allowed: ['Ally'] },
        chargeTime: 1
    });

    assert.equal(await component.activate(selected), true);
    assert.equal(await component.activate(other), false);
    component.update(1000);

    assert.equal(selected.currentShell, 5);
    assert.equal(other.currentShell, 0);
});

test('invalid single target at trigger refunds energy without payload or cooldown', async () => {
    const game = new Game();
    const owner = createShip(game);
    owner.currentEnergy = 50;
    const selected = createShip(game);
    const component = createModule(game, owner, {
        targeting: { kind: 'single', allowed: ['Ally'] },
        chargeTime: 1
    });

    assert.equal(await component.activate(selected), true);
    assert.equal(owner.currentEnergy, 40);
    selected.active = false;
    component.update(1000);

    assert.equal(owner.currentEnergy, 50);
    assert.equal(selected.currentShell, 0);
    assert.equal(component.ready, true);
    assert.equal(component.activeModuleRuntime?.isOnCooldown, false);
});

test('area targeting recalculates at the current position and discovers registered player ships', async () => {
    const game = new Game();
    const npc = createShip(game, YUTIARINALIA, 0, 0);
    const departed = createShip(game, AISTIARIA, 10, 0);
    const player = createShip(game, AISTIARIA, 100, 0);
    assert.equal(game.shipQueue.includes(player), false);

    const component = createModule(game, npc, {
        targeting: { kind: 'area', allowed: ['Enemy'], radius: 25, includeSelf: true },
        chargeTime: 1
    });
    assert.equal(await component.activate(), true);

    npc.x = 100;
    departed.x = 0;
    player.x = 110;
    assert.equal(game.shipQueue.includes(player), false);
    component.update(1000);

    assert.equal(npc.currentShell, 5);
    assert.equal(departed.currentShell, 0);
    assert.equal(player.currentShell, 5);
});

test('area activation with no trigger-time targets refunds energy and applies no cooldown', async () => {
    const game = new Game();
    const owner = createShip(game);
    owner.currentEnergy = 50;
    const component = createModule(game, owner, {
        targeting: { kind: 'area', allowed: ['Enemy'], radius: 20, includeSelf: false },
        chargeTime: 1
    });

    assert.equal(await component.activate(), true);
    assert.equal(owner.currentEnergy, 40);
    component.update(1000);
    assert.equal(owner.currentEnergy, 50);
    assert.equal(owner.currentShell, 0);
    assert.equal(component.ready, true);
    assert.equal(component.activeModuleRuntime?.isOnCooldown, false);

    const instant = createModule(game, owner, {
        targeting: { kind: 'area', allowed: ['Enemy'], radius: 20, includeSelf: false },
        cooldown: 5
    });
    assert.equal(await instant.activate(), false);
    assert.equal(owner.currentEnergy, 50);
    assert.equal(instant.ready, true);
});

test('area results deduplicate queue and registry candidates', async () => {
    const game = new Game();
    const owner = createShip(game);
    const enemy = createShip(game, AISTIARIA, 5, 0);
    const secondEnemy = createShip(game, AISTIARIA, 8, 0);
    const inactiveEnemy = createShip(game, AISTIARIA, 12, 0);
    inactiveEnemy.active = false;
    game.shipQueue.push(enemy);
    game.shipQueue.push(enemy, secondEnemy, inactiveEnemy);
    const component = createModule(game, owner, {
        targeting: { kind: 'area', allowed: ['Enemy'], radius: 20, includeSelf: false },
        payload: { kind: 'resource_restore', shell: 5, hull: 0, energy: 0 }
    });

    assert.equal(await component.activate(), true);
    assert.equal(enemy.currentShell, 5);
    assert.equal(secondEnemy.currentShell, 5);
    assert.equal(inactiveEnemy.currentShell, 0);
});

test('charging and cooldown advance from millisecond deltas against second-based configuration', async () => {
    const game = new Game();
    const owner = createShip(game);
    const component = createModule(game, owner, {
        targeting: { kind: 'self' },
        chargeTime: 1,
        cooldown: 2
    });

    assert.equal(await component.activate(), true);
    component.update(999);
    assert.equal(owner.currentShell, 0);
    component.update(1);
    assert.equal(owner.currentShell, 5);
    assert.equal(component.ready, false);
    component.update(1999);
    assert.equal(component.ready, false);
    component.update(1);
    assert.equal(component.ready, true);
});

test('insufficient energy fails without changing resources or runtime state', async () => {
    const game = new Game();
    const owner = createShip(game);
    owner.currentEnergy = 9;
    const component = createModule(game, owner, {
        targeting: { kind: 'self' },
        energyCost: 10
    });

    assert.equal(await component.activate(), false);
    assert.equal(owner.currentEnergy, 9);
    assert.equal(component.ready, true);
    assert.equal(owner.currentShell, 0);
});

test('explicit cancellation refunds once and applies neither payload nor cooldown', async () => {
    const game = new Game();
    const owner = createShip(game);
    const component = createModule(game, owner, {
        targeting: { kind: 'self' },
        chargeTime: 2
    });

    assert.equal(await component.activate(), true);
    assert.equal(owner.currentEnergy, 90);
    assert.equal(component.cancelActivation(), true);
    assert.equal(component.cancelActivation(), false);
    component.reset();

    assert.equal(owner.currentEnergy, 100);
    assert.equal(owner.currentShell, 0);
    assert.equal(component.ready, true);
    assert.equal(component.activeModuleRuntime?.isOnCooldown, false);
});

test('NPC updates propagate delta to canonical components', async () => {
    const game = new Game();
    const npc = createShip(game);
    const component = createModule(game, npc, {
        targeting: { kind: 'self' },
        chargeTime: 1
    });
    npc.components.push(component);
    game.shipQueue.push(npc);

    assert.equal(await component.activate(), true);
    game.updateQueues(500);
    assert.equal(npc.currentShell, 0);
    game.updateQueues(500);
    assert.equal(npc.currentShell, 5);
});

test('player component update path updates every installed component exactly once', () => {
    const game = new Game();
    const player = createShip(game);
    const weapon = new Component();
    const module = new Component();
    const weaponDeltas: number[] = [];
    const moduleDeltas: number[] = [];
    weapon.update = (delta?: number) => weaponDeltas.push(delta ?? 0);
    module.update = (delta?: number) => moduleDeltas.push(delta ?? 0);
    player.components.push(weapon, module);
    player.compWeapon.push(weapon);

    player.updateComponents(33);

    assert.deepEqual(weaponDeltas, [33]);
    assert.deepEqual(moduleDeltas, [33]);
});

test('ship reset and reinitialization cancel charging before component references are discarded', async () => {
    const game = new Game();
    const ship = createShip(game);
    ship.currentEnergy = 50;
    const component = createModule(game, ship, {
        targeting: { kind: 'self' },
        chargeTime: 10
    });
    ship.components.push(component);

    assert.equal(await component.activate(), true);
    assert.equal(ship.currentEnergy, 40);
    ship.resetIt();

    assert.equal(ship.components.length, 0);
    assert.equal(component.ready, true);
    assert.equal(ship.currentEnergy, ship.maxEnergy);
    ship.currentEnergy = 17;
    assert.equal(component.cancelActivation(), false);
    assert.equal(ship.currentEnergy, 17);

    const reinitialized = createShip(game);
    const staleComponent = createModule(game, reinitialized, {
        targeting: { kind: 'self' },
        chargeTime: 10
    });
    reinitialized.components.push(staleComponent);
    assert.equal(await staleComponent.activate(), true);
    reinitialized.init('unregistered-ship');
    reinitialized.currentEnergy = 23;

    assert.equal(reinitialized.components.length, 0);
    assert.equal(staleComponent.ready, true);
    assert.equal(staleComponent.cancelActivation(), false);
    assert.equal(reinitialized.currentEnergy, 23);
});

test('pooled ship reuse does not retain canonical charging or target state', async () => {
    const game = new Game();
    const ship = game.objectPool!.getShipObject('phase2c-pooled-ship')!;
    const component = createModule(game, ship, {
        targeting: { kind: 'self' },
        chargeTime: 10
    });
    ship.components.push(component);

    assert.equal(await component.activate(), true);
    game.objectPool!.disposeShipObject(ship);
    ship.currentEnergy = 12;

    assert.equal(component.ready, true);
    assert.equal(component.cancelActivation(), false);
    assert.equal(ship.currentEnergy, 12);

    const reused = game.objectPool!.getShipObject('phase2c-pooled-ship');
    assert.equal(reused, ship);
    assert.equal(reused?.components.length, 0);
});

test('legacy Skill and Spawn continue delegating activation to their separate Ability path', async () => {
    const game = new Game();
    const ship = createShip(game);
    const definitions: LegacyComponentDef[] = [
        {
            kind: 'legacy',
            id: 'legacy-skill',
            category: 'Skill',
            subType: 'LegacySkill',
            value: 1,
            cooldown: 2,
            energyCost: 3,
            description: ''
        },
        {
            kind: 'legacy',
            id: 'legacy-spawn',
            category: 'Spawn',
            subType: 'LegacySpawn',
            value: 1,
            cooldown: 2,
            energyCost: 3,
            description: ''
        }
    ];

    for (const definition of definitions) {
        const component = new Component();
        component.init(definition, ship);
        assert.ok(component.ability);
        assert.equal(component.activeModuleRuntime, null);
        const abilityType = component.ability.type;
        component.ability.activate = () => true;

        assert.equal(await component.activate(), true);
        assert.equal(component.type, definition.category);
        assert.equal(component.ability.type, abilityType);
        assert.equal(component.ready, false);
    }

    assert.equal(ship.currentEnergy, 94);
});

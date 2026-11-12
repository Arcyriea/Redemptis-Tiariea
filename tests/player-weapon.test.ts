import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { Component } from '../src/entities/Component';
import { Ship } from '../src/entities/Ship';
import type { ProjectileSpawnConfig } from '../src/managers/ProjectileManager';
import type { ProjectileConfig } from '../src/physics/PhysicsProjectile';
import { YUTIARINALIA } from '../src/managers/FactionManager';
import { ManagedWeapon } from '../src/weapons/ManagedWeapon';
import { Weapon } from '../src/weapons/Weapon';

class CapturedProjectile {
    static lastCreated: CapturedProjectile | null = null;
    public velocity = { x: 0, y: 0 };
    public drag = 0;

    constructor(public readonly config: ProjectileConfig) {
        CapturedProjectile.lastCreated = this;
    }

    setVelocity(x: number, y: number): this {
        this.velocity = { x, y };
        return this;
    }

    setDrag(value: number): this {
        this.drag = value;
        return this;
    }
}

class CapturingWeapon extends Weapon {
    protected async loadPhysicsProjectileConstructor(): Promise<
        typeof import('../src/physics/PhysicsProjectile').PhysicsProjectile
    > {
        return CapturedProjectile as unknown as typeof import('../src/physics/PhysicsProjectile').PhysicsProjectile;
    }
}

function attachPlayerFiringState(game: Game, ship: Ship): void {
    ship.x = 100;
    ship.y = 200;
    ship.rotation = 90;
    ship.phaserScene = { playerProjectiles: { add: () => undefined } };
    ship.phaserBody = { velocity: { x: 5, y: 7 } };
    game.entityManager!.register(ship, 'ship');
    game.factionManager.setFaction(ship, YUTIARINALIA);
}

function createPlayerCannon() {
    const game = Object.create(Game.prototype) as Game;
    game.componentData = {
        PlayerCannon: ['Weapon', 'ProjectileArcade', 10, 400, 0.15, 5, 600, 0],
        LegacyPassive: ['Passive', 'LegacyPassive', 7, 2, 3, 'legacy description']
    };
    Game.instance = game;

    const ship = Object.create(Ship.prototype) as Ship;
    ship.currentEnergy = 100;
    ship.subType = 'Player';

    const component = new Component();
    component.init('PlayerCannon', ship, { x: 0, y: 0 });
    return { component, ship };
}

test('weapon tuple configures component and weapon stats without changing legacy component tuples', () => {
    const { component, ship } = createPlayerCannon();
    const weapon = component.effect!;

    assert.deepEqual(
        {
            componentCooldown: component.cooldown,
            componentEnergyCost: component.energyCost,
            damage: weapon.damage,
            range: weapon.range,
            projectileSpeed: weapon.projectileSpeed,
            weaponCooldown: weapon.cooldown
        },
        {
            componentCooldown: 0.15,
            componentEnergyCost: 5,
            damage: 10,
            range: 400,
            projectileSpeed: 600,
            weaponCooldown: 0.15
        }
    );

    const passive = new Component();
    passive.init('LegacyPassive', ship);
    assert.deepEqual(
        [passive.value, passive.cooldown, passive.energyCost, passive.description],
        [7, 2, 3, 'legacy description']
    );
});

test('canonical PlayerCannon fires from the ship origin through ManagedWeapon once per activation', async () => {
    const game = new Game();
    const ship = game.objectPool!.getShipObject('player');
    assert.ok(ship);
    if (!ship) throw new Error('Expected the player ship to be acquired.');
    attachPlayerFiringState(game, ship);

    const component = ship.compWeapon[0];
    const weapon = component?.effect;
    assert.ok(weapon instanceof ManagedWeapon);
    assert.deepEqual(
        [weapon.type, weapon.damage, weapon.range, weapon.cooldown, weapon.energyCost, weapon.projectileSpeed, weapon.splashRadius],
        ['ProjectileArcade', 10, 400, 0.15, 5, 600, 0]
    );

    const spawns: ProjectileSpawnConfig[] = [];
    game.projectileManager!.spawn = async (config) => {
        spawns.push(config);
        return null;
    };

    assert.equal(await component.activate(), true);
    assert.equal(spawns.length, 1);
    assert.deepEqual(
        [spawns[0].x, spawns[0].y, spawns[0].angle, spawns[0].muzzleVelocity],
        [100, 200, Math.PI / 2, 600]
    );
    assert.deepEqual([spawns[0].shooterVelocityX, spawns[0].shooterVelocityY], [5, 7]);
    assert.deepEqual(spawns[0].attribution, {
        sourceEntityId: ship.id,
        sourceFactionId: YUTIARINALIA
    });
    assert.equal(ship.currentEnergy, 95);
    component.update(149);
    assert.equal(component.ready, false);
    component.update(1);
    assert.equal(component.ready, true);
});

test('managed multi-muzzle firing emits ordered projectiles but consumes energy and cooldown once', async () => {
    const game = new Game();
    const ship = game.objectPool!.getShipObject('player');
    assert.ok(ship);
    if (!ship) throw new Error('Expected the player ship to be acquired.');
    attachPlayerFiringState(game, ship);

    const component = ship.compWeapon[0];
    const definition = component.spinalWeaponDefinition;
    assert.ok(definition);
    if (!definition) throw new Error('Expected a canonical spinal weapon definition.');
    component.spinalWeaponDefinition = {
        ...definition,
        geometry: {
            muzzles: [
                { position: { x: 0, y: 0 }, directionDeg: 0 },
                { position: { x: 0, y: 4 }, directionDeg: -10 }
            ]
        }
    };

    const spawns: ProjectileSpawnConfig[] = [];
    game.projectileManager!.spawn = async (config) => {
        spawns.push(config);
        return null;
    };

    assert.equal(await component.activate(), true);
    assert.equal(spawns.length, 2);
    assert.deepEqual(
        spawns.map(({ x, y, angle }) => [x, y, angle]),
        [
            [100, 200, Math.PI / 2],
            [96, 200, Math.PI * 80 / 180]
        ]
    );
    assert.equal(ship.currentEnergy, 95);
    component.update(149);
    assert.equal(component.ready, false);
    component.update(1);
    assert.equal(component.ready, true);
});

test('legacy fallback firing keeps normalized part origin and ignores part rotation', async () => {
    const { component, ship } = createPlayerCannon();
    ship.x = 100;
    ship.y = 200;
    ship.rotation = 90;
    ship.phaserScene = { playerProjectiles: { add: () => undefined } };
    ship.phaserBody = { velocity: { x: 5, y: 7 } };
    component.shipPart = { x: 10, y: 5, rotation: 45 };

    const weapon = new CapturingWeapon();
    weapon.init('PlayerCannon', component);
    component.effect = weapon;

    assert.equal(await component.activate(), true);
    const captured = CapturedProjectile.lastCreated;
    assert.ok(captured);
    if (!captured) throw new Error('Expected the fallback weapon to create a projectile.');
    assert.deepEqual(
        [captured.config.x, captured.config.y, captured.config.angle, captured.config.muzzleVelocity],
        [95, 210, Math.PI / 2, 600]
    );
    assert.ok(Math.abs(captured.velocity.x - 5) < 1e-9);
    assert.ok(Math.abs(captured.velocity.y - 607) < 1e-9);
    assert.equal(ship.currentEnergy, 95);
});

test('failed async weapon activation does not spend energy or start cooldown', async () => {
    const { component, ship } = createPlayerCannon();
    component.effect!.activate = async () => false;

    assert.equal(await component.activate(), false);
    assert.equal(ship.currentEnergy, 100);
    assert.equal(component.ready, true);
});

test('successful async activation starts one 150 ms component cooldown', async () => {
    const { component, ship } = createPlayerCannon();
    let resolveActivation!: (result: boolean) => void;
    component.effect!.activate = () =>
        new Promise<boolean>((resolve) => {
            resolveActivation = resolve;
        });

    const activation = component.activate();
    assert.equal(component.ready, false);
    assert.equal(await component.activate(), false);

    resolveActivation(true);
    assert.equal(await activation, true);
    assert.equal(ship.currentEnergy, 95);

    component.update(149);
    assert.equal(component.ready, false);
    component.update(1);
    assert.equal(component.ready, true);
});

test('arcade weapon activation fails when its Phaser scene is unavailable', async () => {
    const { component, ship } = createPlayerCannon();

    assert.equal(await component.activate(), false);
    assert.equal(ship.currentEnergy, 100);
    assert.equal(component.ready, true);
});

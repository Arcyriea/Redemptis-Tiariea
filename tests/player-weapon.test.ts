import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { Component } from '../src/entities/Component';
import { Ship } from '../src/entities/Ship';

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

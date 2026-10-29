import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { Ship } from '../src/entities/Ship';
import { EntityManager } from '../src/managers/EntityManager';
import {
    AISTIARIA,
    createFactionId,
    FactionManager,
    RESERVED_FACTIONS,
    YUTIARINALIA
} from '../src/managers/FactionManager';
import { ProjectileManager } from '../src/managers/ProjectileManager';

function createScene() {
    const listeners = new Map<string, () => void>();
    const worldBodies = new Set<object>();
    const enableBodyCalls: object[] = [];
    const world = {
        enableBody(child: { body?: { enable: boolean } }) {
            if (child.body) {
                enableBodyCalls.push(child.body);
                worldBodies.add(child.body);
                child.body.enable = true;
            }
        },
        disableBody(body: { enable: boolean; physicsType?: number }) {
            if (body.physicsType === 1) {
                worldBodies.delete(body);
            }
            body.enable = false;
        }
    };
    const scene = {
        events: {
            once(event: string, listener: () => void) {
                listeners.set(event, listener);
            },
            emit(event: string) {
                const listener = listeners.get(event);
                listeners.delete(event);
                listener?.();
            }
        },
        physics: {
            world,
            add: {
                group() {
                    return createGroup({}, world);
                }
            }
        }
    };

    return {
        scene,
        emit: (event: string) => scene.events.emit(event),
        worldBodies,
        enableBodyCalls
    };
}

function createGroup(scene: object, world?: { disableBody(child: any): void }) {
    const children = new Set<object>();
    return {
        scene,
        add(child: object) {
            children.add(child);
            (child as { setVelocity?: (x: number, y: number) => void }).setVelocity?.(0, 0);
        },
        contains(child: object) {
            return children.has(child);
        },
        remove(child: object) {
            children.delete(child);
            world?.disableBody(child);
        }
    };
}

function createManagedGame() {
    const game = Object.create(Game.prototype) as Game;
    game.entityManager = new EntityManager();
    game.factionManager = new FactionManager();
    const manager = new ProjectileManager(game);
    game.projectileManager = manager;
    return { game, manager };
}

function createShip(game: Game, faction: ReturnType<typeof createFactionId>, x: number): Ship {
    const ship = Object.create(Ship.prototype) as Ship;
    Object.assign(ship, {
        game,
        x,
        y: 0,
        radius: 5,
        active: true,
        removeIt: false,
        exploding: false,
        invulnerable: false,
        currentShell: 100,
        currentHull: 100,
        maxShell: 100,
        maxHull: 100
    });
    game.entityManager!.register(ship, 'ship');
    game.factionManager.setFaction(ship, faction);
    return ship;
}

function createProjectile(
    scene: object,
    startX: number,
    endX: number,
    attribution: { sourceEntityId: string | null; sourceFactionId: string | null },
    lifespanMs = 2000
) {
    return {
        scene,
        isDestroyed: false,
        active: true,
        removeIt: false,
        ageMs: 0,
        lifespanMs,
        damage: 10,
        attribution,
        previousX: startX,
        previousY: 0,
        body: {
            physicsType: 1,
            center: { x: endX, y: 0 },
            position: { x: endX, y: 0 },
            prev: { x: endX, y: 0 },
            prevFrame: { x: endX, y: 0 },
            velocity: { x: 0, y: 0 },
            drag: { x: 0, y: 0 },
            halfWidth: 2,
            halfHeight: 2,
            width: 4,
            height: 4,
            enable: true,
            resetCount: 0,
            reset(x: number, y: number) {
                this.resetCount++;
                this.center.x = x;
                this.center.y = y;
                this.position.x = x;
                this.position.y = y;
                this.prev.x = x;
                this.prev.y = y;
                this.prevFrame.x = x;
                this.prevFrame.y = y;
                this.velocity.x = 0;
                this.velocity.y = 0;
            }
        },
        resetCount: 0,
        destroyCount: 0,
        setActive(value: boolean) {
            this.active = value;
        },
        setVisible(_value: boolean) {},
        setPosition(x: number, y: number) {
            this.body.center.x = x;
            this.body.center.y = y;
        },
        setRotation(_value: number) {},
        setVelocity(x: number, y: number) {
            this.body.velocity.x = x;
            this.body.velocity.y = y;
        },
        setDrag(value: number) {
            this.body.drag.x = value;
            this.body.drag.y = value;
        },
        reset() {
            this.resetCount++;
            this.previousX = 0;
            this.previousY = 0;
            this.removeIt = false;
            this.active = false;
            this.body.enable = false;
        },
        destroy() {
            this.destroyCount++;
            this.isDestroyed = true;
        }
    };
}

function addActiveProjectile(
    manager: ProjectileManager,
    projectile: ReturnType<typeof createProjectile>
): void {
    Object.assign(manager, { active: [projectile] });
}

function spawnConfig(source: Ship, x: number) {
    return {
        x,
        y: 0,
        angle: 0,
        muzzleVelocity: 100,
        shooterVelocityX: 0,
        shooterVelocityY: 0,
        damage: 10,
        texture: 'bullet',
        attribution: {
            sourceEntityId: source.id!,
            sourceFactionId: YUTIARINALIA
        }
    };
}

test('clear is idempotent, avoids duplicate pool entries, and skips destroyed projectiles', () => {
    const { manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);

    const liveProjectile = createProjectile(scene, 0, 0, { sourceEntityId: null, sourceFactionId: null });
    const destroyedProjectile = {
        ...createProjectile(scene, 0, 0, { sourceEntityId: null, sourceFactionId: null }),
        isDestroyed: true
    };
    Object.assign(manager, { active: [liveProjectile, liveProjectile, destroyedProjectile] });

    manager.clear();
    manager.clear();

    assert.equal(manager.activeCount, 0);
    assert.equal(manager.poolSize, 1);
    assert.equal(liveProjectile.resetCount, 1);
    assert.equal(destroyedProjectile.resetCount, 0);
});

test('scene shutdown disposes active and pooled projectiles and permits scene rebinding', () => {
    const { game, manager } = createManagedGame();
    const first = createScene();
    manager.bindScene(first.scene as Phaser.Scene);

    const activeProjectile = createProjectile(
        first.scene,
        0,
        0,
        { sourceEntityId: null, sourceFactionId: null }
    );
    const pooledProjectile = createProjectile(
        first.scene,
        0,
        0,
        { sourceEntityId: null, sourceFactionId: null }
    );
    Object.assign(manager, { active: [activeProjectile], pool: [pooledProjectile] });

    first.emit('shutdown');

    assert.equal(activeProjectile.destroyCount, 1);
    assert.equal(pooledProjectile.destroyCount, 1);
    assert.equal(manager.activeCount, 0);
    assert.equal(manager.poolSize, 0);
    assert.equal(game.projectileManager, manager);

    const restarted = createScene();
    assert.doesNotThrow(() => manager.bindScene(restarted.scene as Phaser.Scene));
    assert.doesNotThrow(() => manager.bindScene(restarted.scene as Phaser.Scene, createGroup({})));

    const replacement = createScene();
    assert.doesNotThrow(() => game.bindScene(replacement.scene as Phaser.Scene));
});

test('destroy can be repeated without detaching the Game-owned manager', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);

    const projectile = createProjectile(scene, 0, 0, { sourceEntityId: null, sourceFactionId: null });
    Object.assign(manager, { pool: [projectile] });

    manager.destroy();
    manager.destroy();

    assert.equal(projectile.destroyCount, 1);
    assert.equal(manager.poolSize, 0);
    assert.equal(game.projectileManager, manager);
    assert.doesNotThrow(() => game.bindScene(scene as Phaser.Scene));
});

test('swept collision damages an eligible hostile once and pools the projectile for reuse', async () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const hostile = createShip(game, AISTIARIA, 50);
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);
    manager.update(16);

    assert.equal(hostile.currentShell, 90);
    assert.equal(projectile.removeIt, true);
    assert.equal(projectile.previousX, 100);
    assert.equal(manager.cleanup(), 1);
    assert.equal(manager.poolSize, 1);
    assert.equal(projectile.previousX, 0);
    assert.equal(projectile.previousY, 0);

    const reused = await manager.spawn(spawnConfig(source, 25));
    assert.equal(reused, projectile);
    assert.equal(manager.poolSize, 0);
    assert.equal(manager.activeCount, 1);
    assert.equal(projectile.previousX, 25);
    assert.equal(projectile.previousY, 0);
});

test('repeated projectile reuse restores its Arcade body, spawn history, velocity, and direction', async () => {
    const { game, manager } = createManagedGame();
    const { scene, worldBodies, enableBodyCalls } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const projectile = createProjectile(scene, 0, 500, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    const body = projectile.body;
    Object.assign(manager, { pool: [projectile] });

    const firstConfig = { ...spawnConfig(source, 10), y: 15, drag: 14, lifespanMs: 5 };
    const firstSpawn = await manager.spawn(firstConfig);

    assert.equal(firstSpawn, projectile);
    assert.equal(projectile.body, body);
    assert.equal(projectile.active, true);
    assert.equal(body.enable, true);
    assert.equal(worldBodies.size, 1);
    assert.deepEqual(enableBodyCalls, [body]);
    assert.equal(body.center.x, 10);
    assert.equal(body.center.y, 15);
    assert.equal(projectile.previousX, 10);
    assert.equal(projectile.previousY, 15);
    assert.equal(body.prevFrame.x, 10);
    assert.equal(body.prevFrame.y, 15);
    assert.equal(body.velocity.x, 100);
    assert.equal(body.velocity.y, 0);
    assert.equal(body.drag.x, 14);
    assert.equal(body.drag.y, 14);

    body.center.x += body.velocity.x * 0.016;
    assert.ok(body.center.x > 10, 'first spawn should move right');
    manager.update(6);
    assert.equal(manager.cleanup(), 1);
    assert.equal(body.enable, false);
    assert.equal(worldBodies.size, 0);
    assert.equal(manager.poolSize, 1);

    const secondConfig = {
        ...spawnConfig(source, 80),
        angle: Math.PI,
        shooterVelocityX: 5,
        drag: 7,
        lifespanMs: 5
    };
    const secondSpawn = await manager.spawn(secondConfig);

    assert.equal(secondSpawn, projectile);
    assert.equal(projectile.body, body);
    assert.equal(body.enable, true);
    assert.equal(worldBodies.size, 1);
    assert.equal(enableBodyCalls.length, 2);
    assert.equal(enableBodyCalls[1], body);
    assert.equal(body.center.x, 80);
    assert.equal(projectile.previousX, 80);
    assert.equal(body.prevFrame.x, 80);
    assert.ok(body.velocity.x < 0, 'reused projectile should receive the new leftward velocity');
    assert.equal(body.velocity.x, -95);
    assert.ok(Math.abs(body.velocity.y) < 1e-10);
    assert.equal(body.drag.x, 7);
    assert.equal(body.drag.y, 7);

    body.center.x += body.velocity.x * 0.016;
    assert.ok(body.center.x < 80, 'reused projectile should move left');
    manager.update(6);
    assert.equal(manager.cleanup(), 1);
    assert.equal(worldBodies.size, 0);
    assert.equal(manager.poolSize, 1);

    const thirdConfig = {
        ...spawnConfig(source, 200),
        y: 30,
        angle: -Math.PI / 2,
        shooterVelocityY: 5,
        drag: 3,
        lifespanMs: 5
    };
    const thirdSpawn = await manager.spawn(thirdConfig);

    assert.equal(thirdSpawn, projectile);
    assert.equal(body.enable, true);
    assert.equal(worldBodies.size, 1);
    assert.equal(enableBodyCalls.length, 3);
    assert.equal(enableBodyCalls[2], body);
    assert.equal(body.center.x, 200);
    assert.equal(body.center.y, 30);
    assert.equal(projectile.previousX, 200);
    assert.equal(projectile.previousY, 30);
    assert.equal(body.prevFrame.x, 200);
    assert.equal(body.prevFrame.y, 30);
    assert.ok(body.velocity.y < 0, 'reused projectile should receive the new upward velocity');
    assert.equal(body.velocity.y, -95);
    assert.equal(body.drag.x, 3);
    assert.equal(body.drag.y, 3);

    body.center.y += body.velocity.y * 0.016;
    assert.ok(body.center.y < 30, 'reused projectile should move upward');
    manager.update(6);
    assert.equal(manager.cleanup(), 1);
    assert.equal(worldBodies.size, 0);
    assert.equal(manager.poolSize, 1);
    assert.equal(body.resetCount, 3);
});

test('swept collision excludes the source and still hits a later hostile', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, 20);
    const hostile = createShip(game, AISTIARIA, 75);
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);

    assert.equal(source.currentShell, 100);
    assert.equal(hostile.currentShell, 90);
});

test('ally and neutral contacts do not consume a projectile before a hostile', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const allyFaction = createFactionId('TestAlly');
    game.factionManager.registerFaction(allyFaction);
    game.factionManager.setRelationshipScore(YUTIARINALIA, allyFaction, 100);
    const source = createShip(game, YUTIARINALIA, -100);
    const ally = createShip(game, allyFaction, 25);
    const neutral = createShip(game, RESERVED_FACTIONS[0], 50);
    const hostile = createShip(game, AISTIARIA, 75);
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);

    assert.equal(ally.currentShell, 100);
    assert.equal(neutral.currentShell, 100);
    assert.equal(hostile.currentShell, 90);
    assert.equal(projectile.removeIt, true);
});

test('earliest hostile contact wins regardless of entity registration order', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const fartherHostile = createShip(game, AISTIARIA, 75);
    const nearerHostile = createShip(game, AISTIARIA, 35);
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);

    assert.equal(nearerHostile.currentShell, 90);
    assert.equal(fartherHostile.currentShell, 100);
});

test('missing source attribution or target faction fails safely', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const hostileWithoutFaction = Object.create(Ship.prototype) as Ship;
    Object.assign(hostileWithoutFaction, {
        game,
        x: 50,
        y: 0,
        radius: 5,
        active: true,
        removeIt: false,
        exploding: false,
        currentShell: 100
    });
    game.entityManager!.register(hostileWithoutFaction, 'ship');

    const missingSource = createProjectile(scene, 0, 100, {
        sourceEntityId: null,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, missingSource);
    manager.update(16);
    assert.equal(hostileWithoutFaction.currentShell, 100);
    assert.equal(missingSource.removeIt, false);

    const missingTargetFaction = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    Object.assign(manager, { active: [missingTargetFaction] });
    manager.update(16);

    assert.equal(hostileWithoutFaction.currentShell, 100);
    assert.equal(missingTargetFaction.removeIt, false);
});

test('inactive, destroyed, exploding, and removed ships are ignored', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const inactive = createShip(game, AISTIARIA, 25);
    inactive.active = false;
    const destroyed = createShip(game, AISTIARIA, 40);
    destroyed.isDestroyed = true;
    const exploding = createShip(game, AISTIARIA, 50);
    exploding.exploding = true;
    const removed = createShip(game, AISTIARIA, 75);
    removed.removeIt = true;
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);

    assert.equal(inactive.currentShell, 100);
    assert.equal(destroyed.currentShell, 100);
    assert.equal(exploding.currentShell, 100);
    assert.equal(removed.currentShell, 100);
    assert.equal(projectile.removeIt, false);
});

test('projectile collision radius uses the Arcade body bounds', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const hostile = createShip(game, AISTIARIA, 50);
    hostile.y = 7.5;
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    });
    addActiveProjectile(manager, projectile);

    manager.update(16);

    assert.equal(hostile.currentShell, 90);
});

test('lifespan expiration still skips collision and returns the projectile to the pool', () => {
    const { game, manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);
    const source = createShip(game, YUTIARINALIA, -100);
    const hostile = createShip(game, AISTIARIA, 50);
    const projectile = createProjectile(scene, 0, 100, {
        sourceEntityId: source.id!,
        sourceFactionId: YUTIARINALIA
    }, 10);
    addActiveProjectile(manager, projectile);

    manager.update(11);

    assert.equal(hostile.currentShell, 100);
    assert.equal(projectile.removeIt, true);
    assert.equal(manager.cleanup(), 1);
    assert.equal(manager.poolSize, 1);
});

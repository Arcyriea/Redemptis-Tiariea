import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../src/core/Game';
import { ProjectileManager } from '../src/managers/ProjectileManager';

function createScene() {
    const listeners = new Map<string, () => void>();
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
            add: {
                group() {
                    return createGroup({});
                }
            }
        }
    };

    return { scene, emit: (event: string) => scene.events.emit(event) };
}

function createGroup(scene: object) {
    const children = new Set<object>();
    return {
        scene,
        add(child: object) {
            children.add(child);
        },
        contains(child: object) {
            return children.has(child);
        },
        remove(child: object) {
            children.delete(child);
        }
    };
}

function createManagedGame() {
    const game = Object.create(Game.prototype) as Game;
    const manager = new ProjectileManager(game);
    game.projectileManager = manager;
    return { game, manager };
}

function createProjectile(scene: object) {
    return {
        scene,
        isDestroyed: false,
        resetCount: 0,
        destroyCount: 0,
        reset() {
            this.resetCount++;
        },
        destroy() {
            this.destroyCount++;
            this.isDestroyed = true;
        }
    };
}

test('clear is idempotent, avoids duplicate pool entries, and skips destroyed projectiles', () => {
    const { manager } = createManagedGame();
    const { scene } = createScene();
    manager.bindScene(scene as Phaser.Scene);

    const liveProjectile = createProjectile(scene);
    const destroyedProjectile = { ...createProjectile(scene), isDestroyed: true };
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

    const activeProjectile = createProjectile(first.scene);
    const pooledProjectile = createProjectile(first.scene);
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

    const projectile = createProjectile(scene);
    Object.assign(manager, { pool: [projectile] });

    manager.destroy();
    manager.destroy();

    assert.equal(projectile.destroyCount, 1);
    assert.equal(manager.poolSize, 0);
    assert.equal(game.projectileManager, manager);
    assert.doesNotThrow(() => game.bindScene(scene as Phaser.Scene));
});

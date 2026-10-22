import Phaser from 'phaser';
import { Game } from './core/Game';
import { MiniMap } from './ui/MiniMap';
import { PlanetBackground, PlanetShader } from './entities/background/Planet';
import { SpaceBackground } from './entities/background/SpaceBackground';

// Scene to handle loading and generating dummy textures
class BootScene extends Phaser.Scene {
    constructor() {
        super('BootScene');
    }

    preload() {
        // Load actual planet textures from public folder
        this.load.image('planetMap111', '/assets/Planets/Map-111.png');
        this.load.image('planetMap122', '/assets/Planets/Map-122.png');
        this.load.image('planetMap692', '/assets/Planets/Map-692.png');

        // Load SVG sprites (rasterized to textures by the Loader).
        // These are blueprint-scale drawings, so a scale factor keeps them
        // crisp at a usable in-game resolution without losing vector detail.
        this.load.svg('human-dreadnought', '/assets/Ships/human-dreadnought.svg', { scale: 0.5 });
        this.load.svg('alien-interceptor', '/assets/Ships/alien-interceptor.svg', { scale: 0.5 });
        this.load.svg('central-hull', '/assets/Components/01_central_hull.svg', { scale: 0.5 });

        // Generate dummy textures using graphics
        this.createDummyTextures();
    }

    create() {
        // Register custom planet shader pipeline
        // In Phaser 4, we use the Shader Game Object directly, so custom pipelines
        // are often unnecessary for simple shaders.
        // We will remove the manual pipeline registration.

        this.scene.start('GameScene');
    }

    createDummyTextures() {
        // 1. Core Ship Hull (Blue Rectangle with a triangle front)
        const core = this.make.graphics({ x: 0, y: 0, add: false });
        core.fillStyle(0x3366ff, 1);
        core.fillRect(0, 10, 40, 40); // Body
        core.fillTriangle(40, 10, 40, 50, 60, 30); // Nose
        core.lineStyle(2, 0xffffff, 1);
        core.strokeRect(0, 10, 40, 40);
        core.strokeTriangle(40, 10, 40, 50, 60, 30);
        core.generateTexture('ship-core', 60, 60);

        // 2. Wing/Hull Expansion (Lighter blue)
        const wing = this.make.graphics({ x: 0, y: 0, add: false });
        wing.fillStyle(0x6699ff, 1);
        wing.fillRect(0, 0, 30, 20);
        wing.lineStyle(1, 0xffffff, 1);
        wing.strokeRect(0, 0, 30, 20);
        wing.generateTexture('ship-wing', 30, 20);

        // 3. Hardpoint (Grey circle)
        const hp = this.make.graphics({ x: 0, y: 0, add: false });
        hp.fillStyle(0x888888, 1);
        hp.fillCircle(5, 5, 5);
        hp.lineStyle(1, 0x000000, 1);
        hp.strokeCircle(5, 5, 5);
        hp.generateTexture('hardpoint', 10, 10);

        // 4. Projectile (Yellow circle)
        const bullet = this.make.graphics({ x: 0, y: 0, add: false });
        bullet.fillStyle(0xffff00, 1);
        bullet.fillCircle(3, 3, 3);
        bullet.generateTexture('bullet', 6, 6);

        // 5. Enemy Core (Red)
        const enemy = this.make.graphics({ x: 0, y: 0, add: false });
        enemy.fillStyle(0xff3333, 1);
        enemy.fillRect(0, 0, 40, 40);
        enemy.lineStyle(2, 0xffffff, 1);
        enemy.strokeRect(0, 0, 40, 40);
        enemy.generateTexture('enemy-core', 40, 40);
    }
}

// Main Game Scene
class GameScene extends Phaser.Scene {
    private engine!: Game;
    private player!: Phaser.GameObjects.Container;
    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: {
        up: Phaser.Input.Keyboard.Key;
        down: Phaser.Input.Keyboard.Key;
        left: Phaser.Input.Keyboard.Key;
        right: Phaser.Input.Keyboard.Key;
    };
    private nextFireTime = 0;
    private shiftKey!: Phaser.Input.Keyboard.Key;
    private zoomKeyIn!: Phaser.Input.Keyboard.Key;
    private zoomKeyOut!: Phaser.Input.Keyboard.Key;
    private gameZoom: number = 1.0;
    private minGameZoom: number = 0.3;
    private maxGameZoom: number = 2.5;
    private zoomStep: number = 0.1;
    private gameWheelListener: (event: WheelEvent) => void;
    private projectiles!: Phaser.Physics.Arcade.Group;
    private playerProjectiles!: Phaser.Physics.Arcade.Group; // Exposed for Weapon.fireArcadeProjectile
    private playerShip: any = null; // Ship instance linked to player Container
    private infoText!: Phaser.GameObjects.Text;
    private planetBackground!: PlanetBackground;
    private spaceBackground!: SpaceBackground;
    private backgroundCamera!: Phaser.Cameras.Scene2D.Camera;
    private uiCamera!: Phaser.Cameras.Scene2D.Camera;

    constructor() {
        super('GameScene');
        this.engine = new Game();
    }

    create() {
        // Misty space background: nebula gradient + twinkling stars (no grid).
        // Drawn behind everything with a slow parallax scroll.
        this.spaceBackground = new SpaceBackground(this, {
            x: 0,
            y: 0,
            width: 2000,
            height: 2000,
            starCount: 450,
            starMaxRadius: 1.6,
            nebulaColor: 0x1a2a6c,
            nebulaStrength: 0.5,
            scrollFactorX: 0.05,
            scrollFactorY: 0.05
        });

        // Planet Background System
        this.planetBackground = new PlanetBackground(this, 0, 0);
        // Add first planet with actual map texture
        this.planetBackground.addPlanet({
            x: 400,
            y: 300,
            radius: 150,
            texture: 'planetMap692',
            shader: 'PlanetShader',
            depth: -10,
            rotationSpeed: 0.05,
            parallaxX: 0.03,
            parallaxY: 0.03
        });
        // Add second planet
        this.planetBackground.addPlanet({
            x: 100,
            y: 100,
            radius: 100,
            texture: 'planetMap122',
            shader: 'PlanetShader',
            depth: -5,
            rotationSpeed: -0.03,
            parallaxX: 0.02,
            parallaxY: 0.02
        });
        // Add third planet
        this.planetBackground.addPlanet({
            x: 700,
            y: 500,
            radius: 120,
            texture: 'planetMap111',
            shader: 'PlanetShader',
            depth: -15,
            rotationSpeed: 0.07,
            parallaxX: 0.04,
            parallaxY: 0.04
        });

        // Physics group for player projectiles (Integrated Physics)
        this.projectiles = this.physics.add.group();

        // Create a modular player ship using Container.
        // The central hull uses an SVG component texture (loaded via this.load.svg),
        // demonstrating vector sprites in the modular pipeline.
        this.player = this.add.container(400, 300);
        const coreSprite = this.add.sprite(0, 0, 'human-dreadnought');
        coreSprite.setScale(0.18); // SVG rasterized at 400x310 -> ~72x56 in-game
        this.player.add(coreSprite);

        // Add modular wings (hull expansions)
        const leftWing = this.add.sprite(-20, -25, 'ship-wing');
        const rightWing = this.add.sprite(-20, 25, 'ship-wing');
        this.player.add([leftWing, rightWing]);

        // Add preset hardpoints
        const hp1 = this.add.sprite(30, 0, 'hardpoint'); // Front
        const hp2 = this.add.sprite(-10, -20, 'hardpoint'); // Left wing
        const hp3 = this.add.sprite(-10, 20, 'hardpoint'); // Right wing
        this.player.add([hp1, hp2, hp3]);

        // Physics for player container
        this.physics.add.existing(this.player);
        (this.player.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(false);
        (this.player.body as Phaser.Physics.Arcade.Body).setDrag(200);

        // Input
        this.cursors = this.input.keyboard.createCursorKeys();
        this.wasd = {
            up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
            down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
            left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
            right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D)
        };
        this.shiftKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

        // Game camera zoom
        this.zoomKeyIn = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.EQUALS); // = key
        this.zoomKeyOut = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);   // - key
        this.gameZoom = 1.0;
        this.minGameZoom = 0.3;
        this.maxGameZoom = 2.5;
        this.zoomStep = 0.1;

        // Mouse wheel zoom for game (when not over minimap)
        this.gameWheelListener = (event: WheelEvent) => {
            // Don't zoom if pointer is over minimap area
            const minimap = this.engine.miniMap;
            if (minimap && this.isPointerOverMinimap(event.clientX, event.clientY)) {
                return;
            }
            event.preventDefault();
            if (event.deltaY < 0) {
                this.setGameZoom(this.gameZoom + this.zoomStep);
            } else {
                this.setGameZoom(this.gameZoom - this.zoomStep);
            }
        };
        window.addEventListener('wheel', this.gameWheelListener, { passive: false });

        // CREATE PLAYER SHIP VIA OBJECT POOL (Step 3)
        const pool = this.engine.objectPool;
        if (pool) {
            this.playerShip = pool.getShipObject("player", "Ally");

            if (this.playerShip) {
                // Position at container's location
                this.playerShip.x = this.player.x;
                this.playerShip.y = this.player.y;
                this.playerShip.rotation = this.player.rotation * (180 / Math.PI); // rad → deg

                // Link Phaser body and scene reference for Weapon.fireArcadeProjectile
                this.playerShip.phaserBody = this.player.body as Phaser.Physics.Arcade.Body;
                this.playerShip.phaserScene = this;  // Direct GameScene reference

                // Expose projectiles group as playerProjectiles for Weapon.fireArcadeProjectile
                this.playerProjectiles = this.projectiles;

                // Register with EntityManager (stable ID, NO queue insertion)
                this.engine.entityManager?.register(this.playerShip, 'ship');

                // Assign sprite reference (for any visual sync)
                this.playerShip.sprite = this.player;
            }
        }

        this.manageCamera();

        // SHUTDOWN cleanup for player Ship (Step 5)
        this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.cleanupPlayerShip();
        });
    }

    private cleanupPlayerShip(): void {
        if (!this.playerShip) return;

        // 1. Unregister from EntityManager (idempotent - safe to call multiple times)
        this.engine.entityManager?.unregister(this.playerShip);

        // 2. Return to pool via ObjectPool (handles active=false, removeIt=true, resetIt, tractor cleanup)
        this.engine.objectPool?.disposeShipObject(this.playerShip);

        // 3. Clear back-references to prevent retaining scene/physics body
        this.playerShip.phaserScene = null;
        this.playerShip.phaserBody = null;
        this.playerShip.sprite = null;

        // 4. Null out our reference
        this.playerShip = null;

        // 5. Clear projectiles group - Phaser scene shutdown destroys physics world,
        // but explicit clear ensures no dangling references
        if (this.projectiles) {
            this.projectiles.clear(true, true); // destroy children, remove from physics
        }
    }

    update(time, delta) {
        const body = this.player.body as Phaser.Physics.Arcade.Body;
        const acceleration = 600;
        const rotateSpeed = 4;
        const maxSpeed = 300;
        const isShiftDown = this.shiftKey.isDown || this.cursors.shift.isDown;

        // Helper booleans for input combining Arrows + WASD
        const isUp = this.cursors.up.isDown || this.wasd.up.isDown;
        const isDown = this.cursors.down.isDown || this.wasd.down.isDown;
        const isLeft = this.cursors.left.isDown || this.wasd.left.isDown;
        const isRight = this.cursors.right.isDown || this.wasd.right.isDown;

        // 1. Aiming / Rotation Mode
        if (isShiftDown) {
            // Smoothly rotate towards mouse pointer using rotateSpeed
            const pointer = this.input.activePointer;
            const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
            const targetAngle = Phaser.Math.Angle.Between(this.player.x, this.player.y, worldPoint.x, worldPoint.y);

            // Smooth angle interpolation (Phaser's Angle.RotateTo or linear interpolation wrapped for angles)
            const currentAngle = this.player.rotation;
            const angleDiff = Phaser.Math.Angle.Wrap(targetAngle - currentAngle);
            const maxStep = Phaser.Math.DegToRad(rotateSpeed * (delta / 16.66)); // frame-rate independent step

            if (Math.abs(angleDiff) < maxStep) {
                this.player.rotation = targetAngle;
            } else {
                this.player.rotation += Math.sign(angleDiff) * maxStep;
            }
        } else {
            // Classic keyboard steering (frame-rate independent rotation speed)
            const turnSpeedDeg = rotateSpeed * 60 * (delta / 1000);
            if (isLeft) {
                this.player.angle -= turnSpeedDeg;
            } else if (isRight) {
                this.player.angle += turnSpeedDeg;
            }
        }

        // 2. Relative Direction Vectors (based on ship's current orientation)
        const forwardX = Math.cos(this.player.rotation);
        const forwardY = Math.sin(this.player.rotation);
        // Perpendicular vector for strafing right (90 degrees clockwise)
        const rightX = -forwardY;
        const rightY = forwardX;

        let accelX = 0;
        let accelY = 0;

        // Forward / Backward Thrust
        if (isUp) {
            accelX += forwardX * acceleration;
            accelY += forwardY * acceleration;
        } else if (isDown) {
            accelX -= forwardX * (acceleration * 0.5);
            accelY -= forwardY * (acceleration * 0.5);
        }

        // Sideways Strafing (Only while holding Shift)
        if (isShiftDown) {
            const strafeAcceleration = acceleration * 0.8;
            if (isLeft) {
                // Strafe Left (-right vector)
                accelX -= rightX * strafeAcceleration;
                accelY -= rightY * strafeAcceleration;
            } else if (isRight) {
                // Strafe Right (+right vector)
                accelX += rightX * strafeAcceleration;
                accelY += rightY * strafeAcceleration;
            }
        }

        // Clamp diagonal acceleration magnitude to prevent moving faster diagonally
        const accelMag = Math.hypot(accelX, accelY);
        if (accelMag > acceleration) {
            accelX = (accelX / accelMag) * acceleration;
            accelY = (accelY / accelMag) * acceleration;
        }

        body.setAcceleration(accelX, accelY);

        // Limit top speed
        body.setMaxVelocity(maxSpeed);

        // Sync Container → Ship (before engine.update so EntityManager queries see current state)
        if (this.playerShip) {
            this.playerShip.x = this.player.x;
            this.playerShip.y = this.player.y;
            this.playerShip.rotation = this.player.rotation * (180 / Math.PI); // rad → deg
            this.playerShip.moveX = body.velocity.x;
            this.playerShip.moveY = body.velocity.y;
        }

        // Fire via compWeapon iteration (replaces manual fireProjectile)
        if (this.input.activePointer.leftButtonDown() && time >= this.nextFireTime) {
            if (this.playerShip && this.playerShip.phaserBody && this.playerShip.phaserScene) {
                for (const comp of this.playerShip.compWeapon) {
                    if (comp.ready) {
                        comp.activate();
                    }
                }
            }
            this.nextFireTime = time + 150; // 150ms cooldown matches prototype
        }

        // Update Planet Background positions & Parallax
        if (this.planetBackground) {
            this.planetBackground.update(delta);
        }

        // Update misty space background (nebula + twinkling stars)
        if (this.spaceBackground) {
            this.spaceBackground.update(delta);
        }

        // Run engine update logic (reverse-engineered from AS3)
        this.engine.update(time, delta);

        // Game camera zoom input (keyboard)
        if (Phaser.Input.Keyboard.JustDown(this.zoomKeyIn)) {
            this.setGameZoom(this.gameZoom + this.zoomStep);
        } else if (Phaser.Input.Keyboard.JustDown(this.zoomKeyOut)) {
            this.setGameZoom(this.gameZoom - this.zoomStep);
        }

        for (const bullet of this.projectiles.getChildren() as Phaser.Physics.Arcade.Sprite[]) {
            this.backgroundCamera.ignore(bullet); // Background camera ignores projectiles
        }
    }

    /** Set game camera zoom with clamping. */
    private setGameZoom(zoom: number): void {
        this.gameZoom = Phaser.Math.Clamp(zoom, this.minGameZoom, this.maxGameZoom);
        this.cameras.main.setZoom(this.gameZoom);
    }

    /** Check if pointer is over minimap area (to avoid zoom conflict). */
    private isPointerOverMinimap(clientX: number, clientY: number): boolean {
        const minimap = this.engine.miniMap;
        if (!minimap) return false;
        const canvas = this.game.canvas;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const localX = (clientX - rect.left) * scaleX;
        const localY = (clientY - rect.top) * scaleY;

        // Minimap position (it uses setScrollFactor(0) so it's at screen coords)
        const mmX = minimap.x;
        const mmY = minimap.y;
        const mmW = minimap.borderWidth || 160;
        const mmH = minimap.borderHeight || 160;
        return localX >= mmX && localX <= mmX + mmW &&
               localY >= mmY && localY <= mmY + mmH;
    }

    fireProjectile() {
        if (!this.player || !this.player.body) return;

        // Create projectile with relative velocity from ship (Real world physics)
        const bullet = this.physics.add.sprite(this.player.x, this.player.y, 'bullet');
        this.projectiles.add(bullet);

        const bulletSpeed = 600;
        const shipVelocity = (this.player.body as Phaser.Physics.Arcade.Body).velocity;

        // Final velocity = Projectile Speed + Ship relative velocity
        this.physics.velocityFromRotation(this.player.rotation, bulletSpeed, bullet.body.velocity);
        bullet.body.velocity.x += shipVelocity.x;
        bullet.body.velocity.y += shipVelocity.y;

        bullet.setRotation(this.player.rotation);
        bullet.setDrag(10); // Minimal air resistance

        // Destroy after 2 seconds
        this.time.delayedCall(2000, () => {
            if (bullet.active) {
                this.projectiles.remove(bullet);
                bullet.destroy();
            }
        });
    }

    manageCamera() {
        // Camera
        this.cameras.main.startFollow(this.player, false, 0.1, 0.1);
        this.cameras.main.setZoom(this.gameZoom);

        // Dedicated background camera (fixed zoom=1, fixed scroll=0, renders behind main)
        this.backgroundCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height);
        this.backgroundCamera.setZoom(1);
        this.backgroundCamera.setScroll(0, 0);

        const cameras = this.cameras.cameras;
        cameras.splice(cameras.indexOf(this.backgroundCamera), 1);
        cameras.unshift(this.backgroundCamera);

        // UI Text (created early so it can be ignored by background camera)
        this.infoText = this.add.text(10, 10, 'Arrows/WASD: Move/Turn | Hold SHIFT: Aim with Mouse & Strafe | Hold Left Mouse: Fire', { color: '#ffffff' }).setScrollFactor(0);

        // Background camera ignores all world objects (renders only space background)
        // Note: projectiles are in a Group (not GameObject), omitted from ignore list.
        // Since background camera is fixed at world origin, projectiles only appear if near (0,0).
        this.backgroundCamera.ignore(this.player);
        this.backgroundCamera.ignore(this.planetBackground.container);
        this.backgroundCamera.ignore(this.infoText);
        this.backgroundCamera.ignore(this.projectiles);

        // ShellCore-style MiniMap HUD (Fixed on top-right)
        const minimap = new MiniMap(this, 640, 10);
        minimap.setScrollFactor(0);
        this.engine.miniMap = minimap;

        this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height);
        this.uiCamera.setZoom(1);
        this.uiCamera.setScroll(0, 0);
        this.uiCamera.ignore(this.children.list.filter(
            gameObject => gameObject !== minimap && gameObject !== this.infoText
        ));
        this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, (gameObject: Phaser.GameObjects.GameObject) => {
            if (gameObject !== minimap && gameObject !== this.infoText) {
                this.uiCamera.ignore(gameObject);
            }
        });

        this.backgroundCamera.ignore(minimap);
        // Main camera ignores space background (rendered by background camera)
        this.cameras.main.ignore(this.spaceBackground.graphics);
        this.cameras.main.ignore(minimap);
        this.cameras.main.ignore(this.infoText);
    }
}

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: '100%',
    height: '100%',
    parent: 'app',
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: 0 },
            debug: false,
            fixedStep: false
        }
    },
    scene: [BootScene, GameScene]
};

const phaserGame = new Phaser.Game(config);

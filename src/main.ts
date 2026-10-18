import Phaser from 'phaser';
import { Game } from './core/Game';
import { MiniMap } from './ui/MiniMap';

// Scene to handle loading and generating dummy textures
class BootScene extends Phaser.Scene {
    constructor() {
        super('BootScene');
    }

    preload() {
        // Generate dummy textures using graphics
        this.createDummyTextures();
    }

    create() {
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
    private fireKey!: Phaser.Input.Keyboard.Key;
    private shiftKey!: Phaser.Input.Keyboard.Key;
    private projectiles!: Phaser.Physics.Arcade.Group;
    private infoText!: Phaser.GameObjects.Text;

    constructor() {
        super('GameScene');
        this.engine = new Game();
    }

    create() {
        // Background Grid
        this.add.grid(0, 0, 2000, 2000, 50, 50, 0x111111).setOrigin(0);

        // Physics group for projectiles (Integrated Physics)
        this.projectiles = this.physics.add.group();

        // Create a modular player ship using Container
        this.player = this.add.container(400, 300);
        const coreSprite = this.add.sprite(0, 0, 'ship-core');
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
        (this.player.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);
        (this.player.body as Phaser.Physics.Arcade.Body).setDrag(200);

        // Input
        this.cursors = this.input.keyboard.createCursorKeys();
        this.wasd = {
            up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
            down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
            left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
            right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D)
        };
        this.fireKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
        this.shiftKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

        // Camera
        this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

        // UI Text
        this.infoText = this.add.text(10, 10, 'Arrows/WASD: Move/Turn | Hold SHIFT: Aim with Mouse & Strafe | Space: Fire', { color: '#ffffff' }).setScrollFactor(0);

        // ShellCore-style MiniMap HUD (Fixed on top-right)
        const minimap = new MiniMap(this, 640, 10);
        minimap.setScrollFactor(0);
        this.engine.miniMap = minimap;
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
            // Classic keyboard steering
            if (isLeft) {
                this.player.angle -= rotateSpeed;
            } else if (isRight) {
                this.player.angle += rotateSpeed;
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

        // Firing with integrated physics
        if (Phaser.Input.Keyboard.JustDown(this.fireKey)) {
            this.fireProjectile();
        }

        // Run engine update logic (reverse-engineered from AS3)
        this.engine.update(time, delta);
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
            if (bullet.active) bullet.destroy();
        });
    }
}

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent: 'app',
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: 0 },
            debug: false
        }
    },
    scene: [BootScene, GameScene]
};

const phaserGame = new Phaser.Game(config);

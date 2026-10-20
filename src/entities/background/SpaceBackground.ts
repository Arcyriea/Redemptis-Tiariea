import Phaser from 'phaser';

export interface Star {
    x: number;
    y: number;
    radius: number;
    alpha: number;
    twinkleSpeed: number;
    twinklePhase: number;
}

export interface SpaceBackgroundOptions {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    starCount?: number;
    starMaxRadius?: number;
    nebulaColor?: number;
    nebulaStrength?: number;
    twinkleSpeed?: number;
    scrollFactorX?: number;
    scrollFactorY?: number;
}

/**
 * A misty space background: a soft radial nebula gradient plus a field of
 * twinkling stars. Built from a single Graphics object so it renders in one
 * draw call and can scroll with the camera via parallax.
 *
 * Stars are stored as plain data (not individual game objects) and drawn each
 * frame into the Graphics command buffer, which is far cheaper than creating
 * thousands of Sprites.
 *
 * Mirrors PlanetBackground's API: call `update(delta)` from your Scene's
 * update loop rather than relying on the Graphics object's own update hook.
 */
export class SpaceBackground {
    public graphics: Phaser.GameObjects.Graphics;
    private scene: Phaser.Scene;
    private width: number;
    private height: number;
    private stars: Star[] = [];
    private twinkleSpeed: number;
    private nebulaColor: number;
    private nebulaStrength: number;

    constructor(scene: Phaser.Scene, options: SpaceBackgroundOptions = {}) {
        this.scene = scene;
        this.width = options.width ?? 2000;
        this.height = options.height ?? 2000;
        this.twinkleSpeed = options.twinkleSpeed ?? 1.5;
        this.nebulaColor = options.nebulaColor ?? 0x1a2a6c;
        this.nebulaStrength = options.nebulaStrength ?? 0.5;

        this.graphics = scene.add.graphics({ x: options.x ?? 0, y: options.y ?? 0, add: true });

        if (options.scrollFactorX !== undefined) {
            this.graphics.setScrollFactor(options.scrollFactorX, options.scrollFactorY ?? options.scrollFactorX);
        }

        this.generateStars(options.starCount ?? 400, options.starMaxRadius ?? 1.6);
        this.drawFrame();
    }

    /** Seed the star field with randomized positions, sizes, and twinkle phases. */
    private generateStars(count: number, maxRadius: number): void {
        this.stars = [];
        for (let i = 0; i < count; i++) {
            this.stars.push({
                x: Math.random() * this.width,
                y: Math.random() * this.height,
                radius: Math.random() * maxRadius + 0.2,
                alpha: Math.random(),
                twinkleSpeed: Math.random() * this.twinkleSpeed + 0.2,
                twinklePhase: Math.random() * Math.PI * 2
            });
        }
    }

    /** Clear the buffer and redraw nebula + stars. Called every frame. */
    private drawFrame(): void {
        this.graphics.clear();

        // Misty nebula: soft 4-corner gradient, darker at the corners.
        this.graphics.fillGradientStyle(
            this.nebulaColor, this.nebulaColor, this.nebulaColor, this.nebulaColor,
            0, this.nebulaStrength, this.nebulaStrength, 0
        );
        this.graphics.fillRect(0, 0, this.width, this.height);

        // Twinkling star field.
        for (const s of this.stars) {
            const alpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(s.twinklePhase));
            this.graphics.fillStyle(0xffffff, alpha);
            this.graphics.fillCircle(s.x, s.y, s.radius);
        }
    }

    update(delta: number): void {
        // Advance each star's twinkle phase independently.
        for (const s of this.stars) {
            s.twinklePhase += s.twinkleSpeed * (delta / 1000);
        }
        this.drawFrame();
    }

    destroy(): void {
        this.stars = [];
        this.graphics.destroy();
    }
}
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
 * An infinite/screen-locked misty space background.
 * Renders on a dedicated background camera (fixed zoom=1, fixed scroll=0).
 * Nebula gradient fills screen; stars twinkle and wrap at screen edges.
 */
export class SpaceBackground {
    public graphics: Phaser.GameObjects.Graphics;
    private scene: Phaser.Scene;
    private stars: Star[] = [];
    private starCount: number;
    private starMaxRadius: number;
    private twinkleSpeed: number;
    private nebulaColor: number;
    private nebulaStrength: number;

    constructor(scene: Phaser.Scene, options: SpaceBackgroundOptions = {}) {
        this.scene = scene;
        this.starCount = options.starCount ?? 500;
        this.starMaxRadius = options.starMaxRadius ?? 1.6;
        this.twinkleSpeed = options.twinkleSpeed ?? 1.5;
        this.nebulaColor = options.nebulaColor ?? 0x1a2a6c;
        this.nebulaStrength = options.nebulaStrength ?? 0.5;

        // Lock graphics to screen (scrollFactor 0) so it always covers the viewport
        this.graphics = scene.add.graphics({ x: 0, y: 0, add: true });
        this.graphics.setScrollFactor(0, 0);

        this.generateStars(this.starCount, this.starMaxRadius);
        this.drawFrame();
    }

    /** Seed stars across the current screen dimensions. */
    private generateStars(count: number, maxRadius: number): void {
        // Use scene scale dimensions (screen size) since background camera is fixed at zoom=1
        const w = this.scene.scale.width || 800;
        const h = this.scene.scale.height || 600;

        this.stars = [];
        for (let i = 0; i < count; i++) {
            this.stars.push({
                x: Math.random() * w,
                y: Math.random() * h,
                radius: Math.random() * maxRadius + 0.2,
                alpha: Math.random(),
                twinkleSpeed: Math.random() * this.twinkleSpeed + 0.2,
                twinklePhase: Math.random() * Math.PI * 2
            });
        }
    }

    /** Clear and redraw nebula gradient + screen-locked star field. */
    private drawFrame(): void {
        this.graphics.clear();

        // Use scene scale dimensions (screen size) since background camera is fixed at zoom=1
        const w = this.scene.scale.width || 800;
        const h = this.scene.scale.height || 600;

        // Misty nebula gradient filling the screen viewport
        this.graphics.fillGradientStyle(
            this.nebulaColor, this.nebulaColor, this.nebulaColor, this.nebulaColor,
            0, this.nebulaStrength, this.nebulaStrength, 0
        );
        this.graphics.fillRect(0, 0, w, h);

        // Twinkling stars
        for (const s of this.stars) {
            const alpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(s.twinklePhase));
            this.graphics.fillStyle(0xffffff, alpha);
            this.graphics.fillCircle(s.x, s.y, s.radius);
        }
    }

    update(delta: number): void {
        // Use scene scale dimensions (screen size) since background camera is fixed at zoom=1
        const w = this.scene.scale.width || 800;
        const h = this.scene.scale.height || 600;

        // Update star twinkle phases
        for (const s of this.stars) {
            s.twinklePhase += s.twinkleSpeed * (delta / 1000);
        }

        // Screen wrapping so stars never run out (fixed camera, no parallax drift)
        for (const s of this.stars) {
            if (s.x < 0) s.x += w;
            else if (s.x > w) s.x -= w;

            if (s.y < 0) s.y += h;
            else if (s.y > h) s.y -= h;
        }

        this.drawFrame();
    }

    destroy(): void {
        this.stars = [];
        this.graphics.destroy();
    }
}
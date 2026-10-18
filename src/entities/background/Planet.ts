import Phaser from 'phaser';

export interface PlanetBackgroundOptions {
    x?: number;
    y?: number;
    radius?: number;
    texture?: string;
    tint?: number;
    alpha?: number;
    depth?: number;
    rotationSpeed?: number;
    parallaxX?: number;
    parallaxY?: number;
    shader?: string;
}

interface PlanetEntry {
    planet: Phaser.GameObjects.Image;
    config: PlanetBackgroundOptions;
}

export class PlanetBackground {
    public scene: Phaser.Scene;
    public container: Phaser.GameObjects.Container;
    private planets: PlanetEntry[] = [];

    constructor(scene: Phaser.Scene, x: number = 0, y: number = 0) {
        this.scene = scene;
        this.container = scene.add.container(x, y);
    }

    addPlanet(options: PlanetBackgroundOptions = {}): Phaser.GameObjects.Image {
        const radius = options.radius ?? 128;
        const texture = options.texture ?? 'planetMap';

        const planet = this.scene.add.image(options.x ?? 0, options.y ?? 0, texture);
        planet.setDisplaySize(radius * 2, radius * 2);
        planet.setAlpha(options.alpha ?? 1);

        if (options.tint !== undefined) {
            planet.setTint(options.tint);
        }

        if (options.depth !== undefined) {
            planet.setDepth(options.depth);
        }

        if (options.shader) {
            planet.setPipeline(options.shader);
        }

        const config: PlanetBackgroundOptions = {
            ...options,
            x: options.x ?? 0,
            y: options.y ?? 0,
            radius,
            texture,
            rotationSpeed: options.rotationSpeed ?? 0,
            parallaxX: options.parallaxX ?? 0.08,
            parallaxY: options.parallaxY ?? 0.08
        };

        planet.setData('planetBaseX', config.x);
        planet.setData('planetBaseY', config.y);

        this.container.add(planet);
        this.planets.push({ planet, config });

        return planet;
    }

    update(delta: number): void {
        const camera = this.scene.cameras.main;

        for (const entry of this.planets) {
            const { planet, config } = entry;

            const baseX = planet.getData('planetBaseX') ?? config.x ?? planet.x;
            const baseY = planet.getData('planetBaseY') ?? config.y ?? planet.y;

            planet.rotation += (config.rotationSpeed ?? 0) * (delta / 1000);

            const targetX = baseX - camera.scrollX * (config.parallaxX ?? 0.08);
            const targetY = baseY - camera.scrollY * (config.parallaxY ?? 0.08);

            planet.x += (targetX - planet.x) * 0.08;
            planet.y += (targetY - planet.y) * 0.08;
        }
    }

    destroy(): void {
        for (const entry of this.planets) {
            entry.planet.destroy();
        }

        this.planets = [];
        this.container.destroy();
    }
}
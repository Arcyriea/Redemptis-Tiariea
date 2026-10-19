import Phaser from 'phaser';
import fragmentShader from '../../shaders/planets.glsl?raw';

export class PlanetShader extends Phaser.GameObjects.Shader {
    constructor(
        scene: Phaser.Scene,
        x: number,
        y: number,
        width: number,
        height: number,
        textureKey?: string
    ) {
        const config = {
            name: 'planetSphere',
            fragmentSource: fragmentShader,
            initialUniforms: {
                uMainSampler: 0
            },
            setupUniforms: (setUniform: (name: string, value: number) => void) => {
                setUniform('time', scene.time.now * 0.001);
            }
        };

        super(
            scene,
            config,
            x,
            y,
            width,
            height,
            textureKey ? [textureKey] : []
        );
    }
}

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
    planet: Phaser.GameObjects.Shader;
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

    addPlanet(options: PlanetBackgroundOptions = {}): Phaser.GameObjects.Shader {
        const radius = options.radius ?? 128;
        const texture = options.texture ?? 'planetMap';

        // In Phaser 4, we use the Shader Game Object directly
        const planet = new PlanetShader(this.scene, options.x ?? 0, options.y ?? 0, radius * 2, radius * 2, texture);

        planet.setAlpha(options.alpha ?? 1);

        if (options.depth !== undefined) {
            planet.setDepth(options.depth);
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
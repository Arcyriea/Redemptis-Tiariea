import Phaser from 'phaser';

export class PlanetShader extends Phaser.GameObjects.Shader {
    constructor(scene: Phaser.Scene, x: number, y: number, width: number, height: number) {
        const fragmentShader = `
precision mediump float;
uniform sampler2D uMainSampler;
varying vec2 outTexCoord;
uniform float time;
uniform vec2 uResolution;

void main() {
    vec2 p = (gl_FragCoord.xy / uResolution.xy) * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) {
        discard;
    }
    float z = sqrt(1.0 - r);
    float pi = 3.14159265359;
    float lat = asin(p.y);
    float lon = atan(p.x, z);
    vec2 uv = vec2((lon / (2.0 * pi)) + 0.5 + (time * 0.05), (lat / pi) + 0.5);
    gl_FragColor = texture2D(uMainSampler, uv);
}
        `;

        super(scene, x, y, width, height, fragmentShader);

        this.setUniform('time', 0);
        this.setUniform('uResolution', [width, height]);
    }

    preUpdate(time: number, delta: number) {
        this.setUniform('time', time * 0.001);
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
        const planet = new PlanetShader(this.scene, options.x ?? 0, options.y ?? 0, radius * 2, radius * 2);

        // Apply the texture as a uniform
        planet.setUniform('uMainSampler', texture);

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
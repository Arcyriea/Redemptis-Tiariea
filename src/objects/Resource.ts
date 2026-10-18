import { Game } from '../core/Game';
import { PowerUp } from './PowerUp';

export class Resource {
    public game: Game;
    public x: number = 0;
    public y: number = 0;
    public type: string = "Resource";
    public active: boolean = true;
    public removeIt: boolean = false;
    public counter: number = 0;
    public powerUps: number = 0;
    public sprite: any = null;
    public dot: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(type: string = "Resource") {
        this.type = type;
        this.counter = 0;
        this.removeIt = false;
        this.active = true;
        this.powerUps = 0;
    }

    update() {
        if (this.removeIt) return;

        this.counter += 3;

        // Periodically spawn power-ups or materials
        if (this.counter >= 200) {
            const roll = Math.random();
            if (roll > 0.9) {
                const pup = this.game.spawnPowerUp("Material", this.x, this.y);
                if (pup) (pup as any).resource = this;
            } else {
                const pup = this.game.spawnPowerUp("Multi", this.x, this.y);
                if (pup) {
                    (pup as any).resource = this;
                    this.powerUps++;
                }
            }
            this.counter = 0;
        }
    }
}
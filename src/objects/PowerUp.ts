import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';

export class PowerUp {
    public game: Game;
    public x: number = 0;
    public y: number = 0;
    public moveX: number = 0;
    public moveY: number = 0;
    public type: string = "Multi";
    public active: boolean = true;
    public removeIt: boolean = false;
    public counter: number = 0;
    public tractoredBy: Ship | null = null;

    // Stats given on pickup
    public power: number = 20;
    public shield: number = 100;
    public hull: number = 200;
    public energy: number = 25;
    public sprite: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(type: string = "Multi") {
        this.type = type;
        this.counter = 0;
        this.removeIt = false;
        this.active = true;
        this.tractoredBy = null;

        // Random drift speed initially
        this.moveX = (Math.random() - 0.5) * 12;
        this.moveY = (Math.random() - 0.5) * 12;
    }

    update() {
        if (this.removeIt) return;

        this.counter += 3;

        // Despawn lifetime check
        if (this.counter >= 620) {
            this.removeIt = true;
        } else if (this.counter < 50) {
            // Decelerate drift
            this.moveX *= 0.8;
            this.moveY *= 0.8;
            this.x += this.moveX * this.game.deltaTime;
            this.y += this.moveY * this.game.deltaTime;
        }
    }
}
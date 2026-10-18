import { Game } from '../core/Game';

export class Effect {
    public game: Game;
    public x: number = 0;
    public y: number = 0;
    public type: string = "";
    public active: boolean = true;
    public removeIt: boolean = false;
    public counter: number = 0;
    public counterDelta: number = -1;
    public sprite: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(type: string, x: number, y: number) {
        this.type = type;
        this.x = x;
        this.y = y;
        this.active = true;
        this.removeIt = false;
        this.counter = 0;
        this.counterDelta = -1;
    }

    update() {
        if (this.removeIt) return;

        // Default animation frame progression (like ActionScript AnimatedSprite)
        this.counterDelta += this.game.deltaTime;
        if (int(this.counterDelta) > this.counter) {
            this.counter++;
            // If animation frames exceed, mark for removal
            if (this.counter > 15) { // Assuming 15 frames per effect
                this.removeIt = true;
            }
        }
    }
}

function int(val: number): number {
    return Math.floor(val);
}
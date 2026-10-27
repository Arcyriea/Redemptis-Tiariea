import { Game } from '../core/Game';

export type MiniMap = import('./MiniMap').MiniMap;

export class UIManager {
    public game: Game;
    public notificationText: string = "";
    public notificationTimer: number = 0;

    constructor() {
        this.game = Game.instance;
    }

    update() {
        if (this.notificationTimer > 0) {
            this.notificationTimer--;
            if (this.notificationTimer <= 0) {
                this.notificationText = "";
            }
        }
    }

    updateCredits() {
        // Update credits display element
    }

    showNotification(msg: string) {
        this.notificationText = msg;
        this.notificationTimer = 180; // ~3 seconds at 60 FPS
    }
}
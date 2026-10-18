import { Game } from '../core/Game';

export class MiniMap {
    public game: Game;
    public x: number = 0;
    public y: number = 0;
    public width: number = 150;
    public height: number = 150;
    public scaleFactor: number = 0.05; // Matches AS3 scale ratio
    public graphics: any = null;

    constructor() {
        this.game = Game.instance;
    }

    update() {
        // Redraw dots on Phaser graphics context
        if (!this.graphics) return;

        this.graphics.clear();

        // Draw minimap background
        this.graphics.fillStyle(0x000000, 0.5);
        this.graphics.fillRect(this.x, this.y, this.width, this.height);

        // Draw border
        this.graphics.lineStyle(1, 0x444444, 1);
        this.graphics.strokeRect(this.x, this.y, this.width, this.height);

        // Draw ally dots
        this.graphics.fillStyle(0x00ff00, 1);
        for (const ship of this.game.queueAlly) {
            if (ship.removeIt) continue;
            const px = this.x + (ship.x * this.scaleFactor) % this.width;
            const py = this.y + (ship.y * this.scaleFactor) % this.height;
            this.graphics.fillCircle(px, py, 2);
        }

        // Draw enemy dots
        this.graphics.fillStyle(0xff0000, 1);
        for (const ship of this.game.queueEnemy) {
            if (ship.removeIt) continue;
            const px = this.x + (ship.x * this.scaleFactor) % this.width;
            const py = this.y + (ship.y * this.scaleFactor) % this.height;
            this.graphics.fillCircle(px, py, 2);
        }

        // Draw player indicator
        const player = this.game.queueAlly.find(s => s.subType === "Player");
        if (player) {
            this.graphics.fillStyle(0x00ffff, 1);
            const px = this.x + (player.x * this.scaleFactor) % this.width;
            const py = this.y + (player.y * this.scaleFactor) % this.height;
            this.graphics.fillCircle(px, py, 3);
        }
    }
}

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
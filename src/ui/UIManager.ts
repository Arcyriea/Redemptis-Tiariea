import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';

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

        const player = this.game.entityManager?.getAll()
            .find((entity): entity is Ship => entity instanceof Ship && entity.subType === 'Player');
        const relationshipColors = [
            { relationship: 'Neutral' as const, color: 0xaaaaaa },
            { relationship: 'Enemy' as const, color: 0xff0000 },
            { relationship: 'Ally' as const, color: 0x00ff00 }
        ];
        for (const { relationship, color } of relationshipColors) {
            this.graphics.fillStyle(color, 1);
            for (const ship of this.game.shipQueue) {
                if (ship.removeIt || ship === player ||
                    this.game.factionManager.getRelationship(player, ship) !== relationship) continue;
                const px = this.x + (ship.x * this.scaleFactor) % this.width;
                const py = this.y + (ship.y * this.scaleFactor) % this.height;
                this.graphics.fillCircle(px, py, 2);
            }
        }

        // Draw player indicator
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
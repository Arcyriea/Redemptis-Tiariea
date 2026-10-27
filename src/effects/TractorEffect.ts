import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';
import { PowerUp } from '../objects/PowerUp';

export class TractorEffect {
    public game: Game;
    public ship: Ship | null = null;
    public targeted: any = null;
    public removeIt: boolean = false;
    public active: boolean = true;
    public range: number = 150;

    // Phaser visual reference
    public sprite: any = null;
    public impactHit: any = null;
    public impactMiss: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init() {
        this.removeIt = false;
        this.targeted = null;
    }

    update() {
        if (!this.ship || this.removeIt) return;

        // If we have a targeted object (PowerUp, Resource, or enemy drone), pull it toward the ship
        if (this.targeted) {
            const dx = this.ship.x - this.targeted.x;
            const dy = this.ship.y - this.targeted.y;
            const distSq = dx * dx + dy * dy;

            // Check out of range drop
            if (distSq > this.range * this.range * 2) {
                this.dropTarget();
                return;
            }

            // Pull object towards ship
            const angle = Math.atan2(dy, dx);
            const pullSpeed = 8.0;
            this.targeted.x += Math.cos(angle) * pullSpeed * this.game.deltaTime;
            this.targeted.y += Math.sin(angle) * pullSpeed * this.game.deltaTime;

            // Collect if close enough
            if (distSq < 400) { // Within 20 pixels
                this.collectTarget();
            }
        } else {
            // Scan for targets in range (PowerUps, Resources)
            this.scanForTargets();
        }
    }

    scanForTargets() {
        if (!this.ship) return;

        // Scan power-ups queue
        for (const pup of this.game.pupQueue) {
            if (!pup || pup.removeIt || pup.tractoredBy) continue;

            const dx = pup.x - this.ship.x;
            const dy = pup.y - this.ship.y;
            const distSq = dx * dx + dy * dy;

            if (distSq <= this.range * this.range) {
                this.targeted = pup;
                pup.tractoredBy = this.ship;
                break;
            }
        }
    }

    collectTarget() {
        if (!this.targeted || !this.ship) return;

        // Handle collection based on target type
        if (this.targeted instanceof PowerUp) {
            // Apply power-up benefits
            this.ship.currentShell = Math.min(this.ship.maxShell, this.ship.currentShell + this.targeted.shield);
            this.ship.currentHull = Math.min(this.ship.maxHull, this.ship.currentHull + this.targeted.hull);
            this.ship.currentEnergy = Math.min(this.ship.maxEnergy, this.ship.currentEnergy + this.targeted.energy);

            this.game.credits += this.targeted.power || 10;
            if (this.game.uiManager) {
                this.game.uiManager.updateCredits();
            }
            this.game.playSound("PowerUp");

            this.targeted.removeIt = true;
        }

        this.targeted = null;
    }

    dropTarget() {
        if (this.targeted) {
            this.targeted.tractoredBy = null;
            this.targeted = null;
        }
    }
}
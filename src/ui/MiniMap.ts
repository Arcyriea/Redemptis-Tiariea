import Phaser from 'phaser';
import { Game } from '../core/Game';
import { Camera } from '../utils/Camera';

/**
 * Replicated MiniMap from ShellCore.
 * Manages sector boundaries, unit dots, and objective pointers.
 */
export class MiniMap extends Phaser.GameObjects.Container {
    public gameInstance: Game;
    private dotsContainer: Phaser.GameObjects.Container;
    private sectorsGraphics: Phaser.GameObjects.Graphics;
    private dotsGraphics: Phaser.GameObjects.Graphics;
    private arrowSprite: Phaser.GameObjects.Sprite;

    private rectWidth: number = 122;
    private rectHeight: number = 119;
    private scaleFactor: number = 0.05; // 0.05 from AS3 code

    constructor(scene: Phaser.Scene, x: number, y: number) {
        super(scene, x, y);
        this.gameInstance = Game.instance;

        // Background & Sectors
        this.sectorsGraphics = scene.add.graphics();
        this.add(this.sectorsGraphics);

        // Container for dynamic elements (dots, arrow) that will be clipped
        this.dotsContainer = scene.add.container(18, 7);
        this.add(this.dotsContainer);

        // Graphics for drawing unit dots
        this.dotsGraphics = scene.add.graphics();
        this.dotsContainer.add(this.dotsGraphics);

        // Task arrow pointer
        this.arrowSprite = scene.add.sprite(0, 0, 'hardpoint'); // Temporary texture
        this.arrowSprite.setVisible(false);
        this.dotsContainer.add(this.arrowSprite);

        // Setup clipping mask for the minimap window
        const maskGraphics = scene.make.graphics({});
        maskGraphics.fillStyle(0xffffff);
        maskGraphics.fillRect(x + 18, y + 7, this.rectWidth, this.rectHeight);
        const mask = maskGraphics.createGeometryMask();
        this.dotsContainer.setMask(mask);

        scene.add.existing(this);
    }

    /**
     * Draw static sector rectangles.
     */
    public init() {
        this.sectorsGraphics.clear();
        this.sectorsGraphics.lineStyle(1, 0x999999, 1);

        // Draw all known sectors from game data
        // Expecting gameInstance.knownSectors to be a list of keys in gameInstance.shipData or similar
        for (const sectorName of this.gameInstance.knownSectors) {
            // This assumes sector data is registered in Game
            const sector = this.gameInstance.shipData[sectorName];
            if (sector && sector.coordinates && sector.size) {
                this.drawSector(sector);
            }
        }
    }

    private drawSector(sector: any) {
        const x = sector.coordinates[0] * this.scaleFactor;
        const y = sector.coordinates[1] * this.scaleFactor;
        const w = sector.size[0] * this.scaleFactor;
        const h = sector.size[1] * this.scaleFactor;
        this.sectorsGraphics.strokeRect(x, y, w, h);
    }

    /**
     * Main update loop for the minimap.
     */
    public update() {
        if (!this.gameInstance) return;

        const cam = Camera.instance;
        const camX = cam.x * this.scaleFactor;
        const camY = cam.y * this.scaleFactor;

        // AS3 logic: rect.x = camX - 60; rect.y = camY - 60;
        // In Phaser, we move the container inversely to simulate scrolling.
        this.dotsContainer.x = 18 + 60 - camX;
        this.dotsContainer.y = 7 + 60 - camY;

        // Draw Unit Dots
        this.dotsGraphics.clear();

        // Player Dot (Cyan)
        const pS = this.gameInstance.shipQueue.find(s => s.subType === 'Player');
        if (pS) {
            this.dotsGraphics.fillStyle(0x00ffff, 1);
            this.dotsGraphics.fillCircle(pS.x * this.scaleFactor, pS.y * this.scaleFactor, 3);
        }

        // Ally Dots (Green)
        this.dotsGraphics.fillStyle(0x00ff00, 1);
        for (const ship of this.gameInstance.queueAlly) {
            if (ship.removeIt || ship.subType === 'Player') continue;
            this.dotsGraphics.fillCircle(ship.x * this.scaleFactor, ship.y * this.scaleFactor, 1.5);
        }

        // Enemy Dots (Red)
        this.dotsGraphics.fillStyle(0xff0000, 1);
        for (const ship of this.gameInstance.queueEnemy) {
            if (ship.removeIt) continue;
            this.dotsGraphics.fillCircle(ship.x * this.scaleFactor, ship.y * this.scaleFactor, 1.5);
        }

        // Stations / Resource Dots (Grey/Neutral)
        this.dotsGraphics.fillStyle(0x888888, 1);
        for (const ship of this.gameInstance.queueStations) {
            if (ship.removeIt) continue;
            this.dotsGraphics.fillCircle(ship.x * this.scaleFactor, ship.y * this.scaleFactor, 3);
        }

        // Update Objective Arrow
        this.updateArrow(camX, camY);
    }

    private updateArrow(camX: number, camY: number) {
        // Find current task objective
        const currentTask = this.gameInstance.tasks[0];
        if (!currentTask) {
            this.arrowSprite.setVisible(false);
            return;
        }

        let targetX = 0;
        let targetY = 0;
        let hasTarget = false;

        // Check if there's a target unit or fixed coordinate
        if (currentTask.targetShip && !currentTask.targetShip.removeIt) {
            targetX = currentTask.targetShip.x;
            targetY = currentTask.targetShip.y;
            hasTarget = true;
        } else if (this.gameInstance.commander && !this.gameInstance.commander.removeIt) {
            targetX = this.gameInstance.commander.x;
            targetY = this.gameInstance.commander.y;
            hasTarget = true;
        }

        if (hasTarget) {
            this.arrowSprite.setVisible(true);

            let ax = targetX * this.scaleFactor;
            let ay = targetY * this.scaleFactor;

            // Clamping arrow within the minimap viewport bounds relative to camera
            const margin = 5;
            const minX = camX - 60 + margin;
            const maxX = camX + 62 - margin;
            const minY = camY - 60 + margin;
            const maxY = camY + 59 - margin;

            ax = Phaser.Math.Clamp(ax, minX, maxX);
            ay = Phaser.Math.Clamp(ay, minY, maxY);

            this.arrowSprite.x = ax;
            this.arrowSprite.y = ay;

            // Rotate arrow towards the actual target
            const dx = targetX * this.scaleFactor - camX;
            const dy = targetY * this.scaleFactor - camY;
            this.arrowSprite.rotation = Math.atan2(dy, dx);
        } else {
            this.arrowSprite.setVisible(false);
        }
    }
}

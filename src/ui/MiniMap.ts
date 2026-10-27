import Phaser from 'phaser';
import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';

/**
 * MiniMap - ShellCore-style radar showing ships, stations, and planets.
 * Tracks the player position with zoom support. Dots clip at the circular boundary.
 * Draw order: planets (back) → stations → neutral → hostile → friendly → player (front).
 */
export class MiniMap extends Phaser.GameObjects.Container {
    public gameInstance: Game;
    private dotsContainer: Phaser.GameObjects.Container;
    private bgGraphics: Phaser.GameObjects.Graphics;
    private dotsGraphics: Phaser.GameObjects.Graphics;
    private arrowSprite: Phaser.GameObjects.Sprite;

    // Minimap base dimensions (at zoom = 1)
    private baseRectWidth: number = 150;
    private baseRectHeight: number = 150;
    private baseBorderWidth: number = 160;
    private baseBorderHeight: number = 160;

    // Zoom state
    private zoom: number = 1.0;
    private minZoom: number = 0.3;
    private maxZoom: number = 3.0;
    private zoomStep: number = 0.15;

    // Scale factor (world -> minimap), adjusted by zoom
    private baseScaleFactor: number = 0.05;

    // Computed values (updated on zoom change)
    private rectWidth: number = 150;
    private rectHeight: number = 150;
    public borderWidth: number = 160;
    public borderHeight: number = 160;
    private scaleFactor: number = 0.05;
    private viewportCenterX: number = 80;
    private viewportCenterY: number = 80;
    private clipMinX: number = 5;
    private clipMinY: number = 5;

    // Input
    private wheelListener: (event: WheelEvent) => void;

    constructor(scene: Phaser.Scene, x: number, y: number) {
        super(scene, x, y);
        this.gameInstance = Game.instance;

        this.recomputeZoomValues();

        // 1. Background + Border (static, not clipped)
        this.bgGraphics = scene.add.graphics();
        this.add(this.bgGraphics);
        this.drawBackground();

        // 2. Container for dynamic dots (we'll position this to center on player)
        this.dotsContainer = scene.add.container(this.viewportCenterX, this.viewportCenterY);
        this.add(this.dotsContainer);

        // 3. Graphics for drawing unit dots (separate layers for draw order)
        this.dotsGraphics = scene.add.graphics();
        this.dotsContainer.add(this.dotsGraphics);

        // 4. Task arrow pointer
        this.arrowSprite = scene.add.sprite(0, 0, 'hardpoint');
        this.arrowSprite.setVisible(false);
        this.dotsContainer.add(this.arrowSprite);

        // 5. Mouse wheel zoom
        this.wheelListener = (event: WheelEvent) => {
            if (!this.scene.scale.isFullscreen && !this.isPointerOverMiniMap(event.clientX, event.clientY)) {
                return;
            }
            event.preventDefault();
            if (event.deltaY < 0) {
                this.zoomIn();
            } else {
                this.zoomOut();
            }
        };
        window.addEventListener('wheel', this.wheelListener, { passive: false });

        // 6. Keyboard zoom (M to zoom in, N to zoom out - or use +/-)
        scene.input.keyboard?.on('keydown-M', () => this.zoomIn());
        scene.input.keyboard?.on('keydown-N', () => this.zoomOut());
        scene.input.keyboard?.on('keydown-ADD', () => this.zoomIn());  // =
        scene.input.keyboard?.on('keydown-SUBTRACT', () => this.zoomOut()); // -

        scene.add.existing(this);
    }

    private recomputeZoomValues(): void {
        this.rectWidth = this.baseRectWidth * this.zoom;
        this.rectHeight = this.baseRectHeight * this.zoom;
        this.borderWidth = this.baseBorderWidth * this.zoom;
        this.borderHeight = this.baseBorderHeight * this.zoom;
        this.scaleFactor = this.baseScaleFactor * this.zoom;
        this.viewportCenterX = this.borderWidth / 2;
        this.viewportCenterY = this.borderHeight / 2;
        this.clipMinX = this.viewportCenterX - this.rectWidth / 2;
        this.clipMinY = this.viewportCenterY - this.rectHeight / 2;

        // Reposition container center
        if (this.dotsContainer) {
            this.dotsContainer.setPosition(this.viewportCenterX, this.viewportCenterY);
        }
    }

    private zoomIn(): void {
        this.zoom = Math.min(this.maxZoom, this.zoom + this.zoomStep);
        this.onZoomChange();
    }

    private zoomOut(): void {
        this.zoom = Math.max(this.minZoom, this.zoom - this.zoomStep);
        this.onZoomChange();
    }

    private onZoomChange(): void {
        this.recomputeZoomValues();
        this.drawBackground();
    }

    /** Check if pointer is over the minimap area (for wheel zoom). */
    private isPointerOverMiniMap(clientX: number, clientY: number): boolean {
        const canvas = this.scene.game.canvas;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const localX = (clientX - rect.left) * scaleX;
        const localY = (clientY - rect.top) * scaleY;

        // Minimap position in screen coords (container has scrollFactor 0)
        const mmX = this.x;
        const mmY = this.y;
        return localX >= mmX && localX <= mmX + this.borderWidth &&
               localY >= mmY && localY <= mmY + this.borderHeight;
    }

    /** Draw the static minimap background and border. */
    private drawBackground(): void {
        this.bgGraphics.clear();

        // Background fill
        this.bgGraphics.fillStyle(0x000000, 0.7);
        this.bgGraphics.fillRect(0, 0, this.borderWidth, this.borderHeight);

        // Border
        this.bgGraphics.lineStyle(2, 0x4488ff, 1);
        this.bgGraphics.strokeRect(0, 0, this.borderWidth, this.borderHeight);

        // Inner viewport rectangle (shows the clipping area)
        this.bgGraphics.lineStyle(1, 0x224488, 0.5);
        this.bgGraphics.strokeRect(this.clipMinX, this.clipMinY, this.rectWidth, this.rectHeight);

        // Zoom indicator text
        this.bgGraphics.fillStyle(0xffffff, 0.6);
        this.bgGraphics.fillRect(4, 4, 40, 16);
        // Note: Can't draw text on Graphics, would need a Text object for zoom level
    }

    /**
     * Check if a point (in world minimap coords) is within the currently visible
     * viewport region (which is centered on the player).
     */
    private isInViewport(mx: number, my: number, radius: number, playerMinimapX: number, playerMinimapY: number): boolean {
        // Visible region in world minimap coords is centered on player
        const halfW = this.rectWidth / 2 + radius;
        const halfH = this.rectHeight / 2 + radius;
        return mx >= playerMinimapX - halfW &&
               mx <= playerMinimapX + halfW &&
               my >= playerMinimapY - halfH &&
               my <= playerMinimapY + halfH;
    }

    private findPlayerShip(): Ship | undefined {
        return this.gameInstance.entityManager?.getAll()
            .find((entity): entity is Ship => entity instanceof Ship && entity.subType === 'Player');
    }

    /**
     * Main update loop - called from Game.update()
     * Tracks player position and renders all dots clipped to minimap boundary.
     * Draw order: planets → stations → neutral → hostile → friendly → player (front)
     */
    public update(): void {
        if (!this.gameInstance) return;

        const scene = this.scene;
        if (!scene) return;

        // Find player position
        let playerX = 0;
        let playerY = 0;
        let foundPlayer = false;

        const playerShip = this.findPlayerShip();
        if (playerShip && playerShip.active && !playerShip.removeIt) {
            playerX = playerShip.x;
            playerY = playerShip.y;
            foundPlayer = true;
        } else if (scene.physics && scene.physics.world && scene.physics.world.bodies) {
            // Fallback: iterate physics bodies Set
            for (const body of scene.physics.world.bodies) {
                if (body.gameObject && body.gameObject instanceof Phaser.GameObjects.Container) {
                    const container = body.gameObject as Phaser.GameObjects.Container;
                    if (container.list && container.list.length > 0) {
                        playerX = container.x;
                        playerY = container.y;
                        foundPlayer = true;
                        break;
                    }
                }
            }
        }

        if (!foundPlayer) return;

        // Player position in minimap coordinates
        const playerMinimapX = playerX * this.scaleFactor;
        const playerMinimapY = playerY * this.scaleFactor;

        // Center the dotsContainer on the player's minimap position
        this.dotsContainer.x = this.viewportCenterX - playerMinimapX;
        this.dotsContainer.y = this.viewportCenterY - playerMinimapY;

        // Reposition minimap to top-right corner of screen (handles % dimensions)
        this.updateScreenPosition();

        // Draw Unit Dots (clipped to player-centered viewport)
        // ORDER: Planets → Stations → Neutral → Hostile → Friendly → Player
        this.dotsGraphics.clear();

        // 1. Planet Dots (Yellow/Neutral, larger - radius scaled) - DRAWN FIRST (back)
        if (this.gameInstance.planets) {
            this.dotsGraphics.fillStyle(0xffdd00, 0.85);
            for (const planet of this.gameInstance.planets) {
                const r = Math.max(4, planet.radius * this.scaleFactor);
                const mx = planet.x * this.scaleFactor;
                const my = planet.y * this.scaleFactor;
                if (this.isInViewport(mx, my, r, playerMinimapX, playerMinimapY)) {
                    this.dotsGraphics.fillCircle(mx, my, r);
                }
            }
        }

        // 2. Stations remain visually distinct from faction relationships.
        this.dotsGraphics.fillStyle(0x888888, 1);
        for (const ship of this.gameInstance.shipQueue) {
            if (ship.removeIt || (ship.superType !== 'Station' && ship.superType !== 'Turret')) continue;
            const mx = ship.x * this.scaleFactor;
            const my = ship.y * this.scaleFactor;
            if (this.isInViewport(mx, my, 3, playerMinimapX, playerMinimapY)) {
                this.dotsGraphics.fillCircle(mx, my, 3);
            }
        }

        const relationshipColors = [
            { relationship: 'Neutral' as const, color: 0xaaaaaa },
            { relationship: 'Enemy' as const, color: 0xff0000 },
            { relationship: 'Ally' as const, color: 0x00ff00 }
        ];
        for (const { relationship, color } of relationshipColors) {
            this.dotsGraphics.fillStyle(color, 1);
            for (const ship of this.gameInstance.shipQueue) {
                if (ship.removeIt || ship === playerShip ||
                    ship.superType === 'Station' || ship.superType === 'Turret') continue;
                if (this.gameInstance.factionManager.getRelationship(playerShip, ship) !== relationship) continue;
                const mx = ship.x * this.scaleFactor;
                const my = ship.y * this.scaleFactor;
                if (this.isInViewport(mx, my, 2, playerMinimapX, playerMinimapY)) {
                    this.dotsGraphics.fillCircle(mx, my, 2);
                }
            }
        }

        // 5. Player Dot (Cyan) - ALWAYS on top, always at center
        this.dotsGraphics.fillStyle(0x00ffff, 1);
        this.dotsGraphics.fillCircle(playerMinimapX, playerMinimapY, 5);

        // Update Objective Arrow
        this.updateArrow(playerMinimapX, playerMinimapY, playerShip);
    }

    /** Position minimap at top-right of screen (handles % dimensions via camera). */
    private updateScreenPosition(): void {
        const cam = this.scene.cameras.main;
        const screenW = cam.width;
        const padding = 10;
        this.setPosition(screenW - this.borderWidth - padding, padding);
    }

    private updateArrow(_playerMinimapX: number, _playerMinimapY: number, playerShip?: Ship): void {
        const currentTask = this.gameInstance.tasks?.[0];
        if (!currentTask) {
            this.arrowSprite.setVisible(false);
            return;
        }

        let targetX = 0;
        let targetY = 0;
        let hasTarget = false;

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

            // Arrow position in minimap coordinates
            let ax = targetX * this.scaleFactor;
            let ay = targetY * this.scaleFactor;

            // Clamp arrow to stay within minimap viewport bounds
            const margin = 8 * this.zoom;
            const halfW = this.rectWidth / 2 - margin;
            const halfH = this.rectHeight / 2 - margin;
            const centerX = this.viewportCenterX;
            const centerY = this.viewportCenterY;

            ax = Phaser.Math.Clamp(ax, centerX - halfW, centerX + halfW);
            ay = Phaser.Math.Clamp(ay, centerY - halfH, centerY + halfH);

            // Position relative to dotsContainer center
            this.arrowSprite.x = ax - this.dotsContainer.x;
            this.arrowSprite.y = ay - this.dotsContainer.y;

            // Rotate arrow towards actual target direction
            if (playerShip) {
                const dx = targetX - playerShip.x;
                const dy = targetY - playerShip.y;
                this.arrowSprite.rotation = Math.atan2(dy, dx);
            }
        } else {
            this.arrowSprite.setVisible(false);
        }
    }

    destroy(): void {
        window.removeEventListener('wheel', this.wheelListener);
        this.scene.input.keyboard?.off('keydown-M');
        this.scene.input.keyboard?.off('keydown-N');
        this.scene.input.keyboard?.off('keydown-ADD');
        this.scene.input.keyboard?.off('keydown-SUBTRACT');
        this.dotsGraphics.destroy();
        this.bgGraphics.destroy();
        this.arrowSprite.destroy();
        this.dotsContainer.destroy();
        super.destroy();
    }
}
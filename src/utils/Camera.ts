// Camera system - Similar to ActionScript Camera.as
export class Camera {
    public static instance: Camera;

    public mode: string = "follow"; // "follow", "fixed", "scroll"
    public target: any = null;
    public targetX: number = 0;
    public targetY: number = 0;
    public x: number = 0;
    public y: number = 0;
    public smooth: number = 0.1; // Lerp factor
    public bounds: { x: number; y: number; width: number; height: number } | null = null;
    public viewportWidth: number = 800;
    public viewportHeight: number = 600;

    constructor() {
        Camera.instance = this;
    }

    setBounds(x: number, y: number, width: number, height: number) {
        this.bounds = { x, y, width, height };
    }

    update() {
        if (this.mode === "follow" && this.target) {
            this.targetX = this.target.x;
            this.targetY = this.target.y;
        }

        // Smooth camera follow
        this.x += (this.targetX - this.x) * this.smooth;
        this.y += (this.targetY - this.y) * this.smooth;

        // Clamp to bounds
        if (this.bounds) {
            const halfW = this.viewportWidth / 2;
            const halfH = this.viewportHeight / 2;

            this.x = Math.max(this.bounds.x + halfW, Math.min(this.bounds.x + this.bounds.width - halfW, this.x));
            this.y = Math.max(this.bounds.y + halfH, Math.min(this.bounds.y + this.bounds.height - halfH, this.y));
        }
    }

    getCameraOffset() {
        return { x: this.x, y: this.y };
    }

    worldToScreen(worldX: number, worldY: number) {
        return {
            x: worldX - this.x + this.viewportWidth / 2,
            y: worldY - this.y + this.viewportHeight / 2
        };
    }

    screenToWorld(screenX: number, screenY: number) {
        return {
            x: screenX + this.x - this.viewportWidth / 2,
            y: screenY + this.y - this.viewportHeight / 2
        };
    }
}
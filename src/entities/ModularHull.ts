import Phaser from 'phaser';

export interface HardpointDef {
    id: string;
    type: 'weapon' | 'ability';
    name: string;
    offsetX: number;
    offsetY: number;
    facingAngle: number; // in degrees relative to ship
    maxHp: number;
    cooldown: number; // in seconds
    damage: number;
    projectileSpeed: number; // muzzle velocity
    energyCost: number;
}

export class Hardpoint {
    public id: string;
    public type: 'weapon' | 'ability';
    public name: string;
    public offsetX: number;
    public offsetY: number;
    public facingAngle: number;
    public maxHp: number;
    public currentHp: number;
    public disabled: boolean = false;
    public cooldown: number;
    public timer: number = 0;
    public damage: number;
    public projectileSpeed: number;
    public energyCost: number;
    public sprite: Phaser.GameObjects.Sprite | null = null;

    constructor(def: HardpointDef) {
        this.id = def.id;
        this.type = def.type;
        this.name = def.name;
        this.offsetX = def.offsetX;
        this.offsetY = def.offsetY;
        this.facingAngle = def.facingAngle;
        this.maxHp = def.maxHp;
        this.currentHp = def.maxHp;
        this.cooldown = def.cooldown;
        this.damage = def.damage;
        this.projectileSpeed = def.projectileSpeed;
        this.energyCost = def.energyCost;
    }

    public update(deltaSeconds: number) {
        if (this.timer > 0) {
            this.timer -= deltaSeconds;
            if (this.timer < 0) this.timer = 0;
        }
    }

    public isReady(): boolean {
        return !this.disabled && this.timer <= 0;
    }

    public takeDamage(dmg: number) {
        if (this.disabled) return;
        this.currentHp -= dmg;
        if (this.currentHp <= 0) {
            this.currentHp = 0;
            this.disabled = true;
            if (this.sprite) {
                this.sprite.setTint(0x555555); // Visually damaged/offline
            }
        }
    }

    public repair(amount: number) {
        this.currentHp += amount;
        if (this.currentHp > this.maxHp) this.currentHp = this.maxHp;
        if (this.currentHp > 0 && this.disabled) {
            this.disabled = false;
            if (this.sprite) {
                this.sprite.clearTint();
            }
        }
    }
}

export interface HullSectionDef {
    id: string;
    name: string;
    isCore: boolean;
    textureKey: string;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    maxHp: number;
    weight: number;
    hardpoints: HardpointDef[];
}

export class HullSection {
    public id: string;
    public name: string;
    public isCore: boolean;
    public textureKey: string;
    public offsetX: number;
    public offsetY: number;
    public maxHp: number;
    public currentHp: number;
    public weight: number;
    public hardpoints: Hardpoint[] = [];
    public detached: boolean = false;
    public sprite: Phaser.GameObjects.Sprite | null = null;
    public container: Phaser.GameObjects.Container | null = null;

    constructor(def: HullSectionDef) {
        this.id = def.id;
        this.name = def.name;
        this.isCore = def.isCore;
        this.textureKey = def.textureKey;
        this.offsetX = def.offsetX;
        this.offsetY = def.offsetY;
        this.maxHp = def.maxHp;
        this.currentHp = def.maxHp;
        this.weight = def.weight;

        for (const hpDef of def.hardpoints) {
            this.hardpoints.push(new Hardpoint(hpDef));
        }
    }

    public update(deltaSeconds: number) {
        if (this.detached) return;
        for (const hp of this.hardpoints) {
            hp.update(deltaSeconds);
        }
    }

    public takeDamage(amount: number): boolean {
        if (this.detached) return false;
        this.currentHp -= amount;

        // Spread damage to hardpoints on this section
        if (this.hardpoints.length > 0 && Math.random() < 0.35) {
            const randomHp = this.hardpoints[Math.floor(Math.random() * this.hardpoints.length)];
            randomHp.takeDamage(amount * 0.5);
        }

        if (this.currentHp <= 0) {
            this.currentHp = 0;
            return true; // Section destroyed / detached
        }
        return false;
    }
}

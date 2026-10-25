// Object Pool for efficient reuse of objects (ships, effects, power-ups, etc.)
import { Ship } from '../entities/Ship';
import { Component } from '../entities/Component';
import { Effect } from '../effects/Effect';
import { PowerUp } from '../objects/PowerUp';
import { Resource } from '../objects/Resource';

export class ObjectPool {
    // Pools
    private shipPool: Map<string, Ship[]> = new Map();
    private componentPool: Map<string, Component[]> = new Map();
    private effectPool: Map<string, Effect[]> = new Map();
    private powerUpPool: Map<string, PowerUp[]> = new Map();
    private resourcePool: Map<string, Resource[]> = new Map();

    // Temp arrays for getting objects
    private tempShips: Ship[] = [];
    private tempComponents: Component[] = [];
    private tempEffects: Effect[] = [];
    private tempPowerUps: PowerUp[] = [];
    private tempResources: Resource[] = [];

    constructor() {
        this.initPools();
    }

    initPools() {
        // Pre-create some objects if needed, or just create on demand
    }

    // Ship pooling
    public getShipObject(type: string): Ship | null {
        let pool = this.shipPool.get(type);
        if (!pool) {
            pool = [];
            this.shipPool.set(type, pool);
        }

        // Find an inactive ship of this type
        for (const ship of pool) {
            if (!ship.active || ship.removeIt) {
                ship.init(type);
                ship.active = true;
                ship.removeIt = false;
                return ship;
            }
        }

        // Create new if none available
        const ship = new Ship();
        ship.init(type);
        ship.active = true;
        pool.push(ship);
        return ship;
    }

    public disposeShipObject(ship: Ship) {
        if (!ship) return;
        ship.active = false;
        ship.removeIt = true;
        // Optionally reset visuals, etc.
        ship.sprite?.destroy?.();
        ship.selection?.destroy?.();
        ship.dot?.destroy?.();
        if (ship.tractor) {
            ship.tractor.removeIt = true;
            ship.tractor = null;
        }
        // Reset ship state
        ship.resetIt();
    }

    // Component pooling
    public getComponent(type: string): Component | null {
        let pool = this.componentPool.get(type);
        if (!pool) {
            pool = [];
            this.componentPool.set(type, pool);
        }

        for (const comp of pool) {
            if (!comp.active || comp.removeIt) {
                comp.init(type); // Assuming init can reinitialize
                comp.active = true;
                comp.removeIt = false;
                return comp;
            }
        }

        const comp = new Component();
        comp.init(type);
        pool.push(comp);
        return comp;
    }

    public disposeComponent(comp: Component) {
        if (!comp) return;
        comp.active = false;
        comp.removeIt = true;
    }

    // Effect pooling
    public getEffect(type: string): Effect | null {
        let pool = this.effectPool.get(type);
        if (!pool) {
            pool = [];
            this.effectPool.set(type, pool);
        }

        for (const eff of pool) {
            if (!eff.active || eff.removeIt) {
                eff.init(type, 0, 0); // Will be repositioned
                eff.active = true;
                eff.removeIt = false;
                return eff;
            }
        }

        const eff = new Effect();
        eff.init(type, 0, 0);
        pool.push(eff);
        return eff;
    }

    public disposeEffect(eff: Effect) {
        if (!eff) return;
        eff.active = false;
        eff.removeIt = true;
        eff.sprite?.destroy?.();
    }

    // PowerUp pooling
    public getPowerUp(type: string): PowerUp | null {
        let pool = this.powerUpPool.get(type);
        if (!pool) {
            pool = [];
            this.powerUpPool.set(type, pool);
        }

        for (const pup of pool) {
            if (!pup.active || pup.removeIt) {
                pup.init(type);
                pup.active = true;
                pup.removeIt = false;
                return pup;
            }
        }

        const pup = new PowerUp();
        pup.init(type);
        pool.push(pup);
        return pup;
    }

    public disposePowerUp(pup: PowerUp) {
        if (!pup) return;
        pup.active = false;
        pup.removeIt = true;
        pup.sprite?.destroy?.();
    }

    // Resource pooling
    public getResource(type: string): Resource | null {
        let pool = this.resourcePool.get(type);
        if (!pool) {
            pool = [];
            this.resourcePool.set(type, pool);
        }

        for (const res of pool) {
            if (!res.active || res.removeIt) {
                res.init(type);
                res.active = true;
                res.removeIt = false;
                return res;
            }
        }

        const res = new Resource();
        res.init(type);
        pool.push(res);
        return res;
    }

    public disposeResource(res: Resource) {
        if (!res) return;
        res.active = false;
        res.removeIt = true;
        res.sprite?.destroy?.();
    }

    // Clear all pools (called when changing sectors)
    public clearAll() {
        this.shipPool.forEach(pool => {
            for (const ship of pool) {
                this.disposeShipObject(ship);
            }
        });
        this.componentPool.forEach(pool => {
            for (const comp of pool) {
                this.disposeComponent(comp);
            }
        });
        this.effectPool.forEach(pool => {
            for (const eff of pool) {
                this.disposeEffect(eff);
            }
        });
        this.powerUpPool.forEach(pool => {
            for (const pup of pool) {
                this.disposePowerUp(pup);
            }
        });
        this.resourcePool.forEach(pool => {
            for (const res of pool) {
                this.disposeResource(res);
            }
        });

        // Clear maps
        this.shipPool.clear();
        this.componentPool.clear();
        this.effectPool.clear();
        this.powerUpPool.clear();
        this.resourcePool.clear();
    }
}
import type { Game } from '../core/Game';
import type { Ship } from '../entities/Ship';
import type {
    ActiveModuleDefinition,
    ActiveModuleTargeting
} from '../types/Shipmaker';

export type ActiveModuleRuntimeState = 'ready' | 'charging' | 'cooldown';

export class ActiveModuleRuntime {
    private owner: Ship | null;
    private stateValue: ActiveModuleRuntimeState = 'ready';
    private chargeElapsedMs = 0;
    private cooldownElapsedMs = 0;
    private paidActivation = false;
    private pendingTarget: Ship | null = null;
    private resolvedTargets: Ship[] = [];

    constructor(
        private readonly game: Game,
        private readonly definition: ActiveModuleDefinition,
        owner: Ship | null
    ) {
        this.owner = owner;
    }

    get state(): ActiveModuleRuntimeState {
        return this.stateValue;
    }

    get ready(): boolean {
        return this.stateValue === 'ready';
    }

    get isCharging(): boolean {
        return this.stateValue === 'charging';
    }

    get isOnCooldown(): boolean {
        return this.stateValue === 'cooldown';
    }

    setOwner(owner: Ship | null): void {
        if (owner !== this.owner) this.cancel();
        this.owner = owner;
    }

    setReady(ready: boolean): void {
        if (ready) {
            if (this.paidActivation) {
                this.cancel();
                return;
            }
            this.stateValue = 'ready';
            this.cooldownElapsedMs = 0;
            this.chargeElapsedMs = 0;
            this.clearTargets();
        } else if (this.stateValue === 'ready') {
            this.stateValue = 'cooldown';
            this.cooldownElapsedMs = 0;
        }
    }

    activate(target: Ship | null = null): boolean {
        const owner = this.owner;
        if (!this.ready || !this.isActiveShip(owner)) return false;
        if (owner.currentEnergy < this.definition.operation.energyCost) return false;

        const targeting = this.definition.targeting;
        if (targeting.kind === 'self') {
            this.pendingTarget = owner;
        } else if (targeting.kind === 'single') {
            if (!target || !this.isEligibleRelationship(owner, target, targeting)) return false;
            this.pendingTarget = target;
        }

        owner.currentEnergy -= this.definition.operation.energyCost;
        this.paidActivation = true;
        this.chargeElapsedMs = 0;
        this.cooldownElapsedMs = 0;

        if ((this.definition.operation.chargeTime ?? 0) > 0) {
            this.stateValue = 'charging';
            return true;
        }

        return this.trigger();
    }

    update(deltaMs: number): void {
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;

        if (this.isCharging) {
            this.chargeElapsedMs += deltaMs;
            if (this.chargeElapsedMs >= (this.definition.operation.chargeTime ?? 0) * 1000) {
                this.trigger();
            }
        } else if (this.isOnCooldown) {
            this.cooldownElapsedMs += deltaMs;
            if (this.cooldownElapsedMs >= this.definition.operation.cooldown * 1000) {
                this.stateValue = 'ready';
                this.cooldownElapsedMs = 0;
            }
        }
    }

    cancel(): boolean {
        if (!this.paidActivation) return false;

        const owner = this.owner;
        this.paidActivation = false;
        this.stateValue = 'ready';
        this.chargeElapsedMs = 0;
        this.cooldownElapsedMs = 0;
        this.clearTargets();

        if (owner) {
            owner.currentEnergy = Math.min(
                owner.maxEnergy,
                owner.currentEnergy + this.definition.operation.energyCost
            );
        }
        return true;
    }

    reset(): void {
        this.cancel();
        this.stateValue = 'ready';
        this.chargeElapsedMs = 0;
        this.cooldownElapsedMs = 0;
        this.clearTargets();
    }

    private trigger(): boolean {
        const targets = this.resolveTargets();
        if (targets.length === 0 || !targets.every((target) => this.isActiveShip(target))) {
            this.cancel();
            return false;
        }

        this.resolvedTargets = targets;
        const payload = this.definition.payload;
        if (payload.kind === 'resource_restore') {
            for (const target of this.resolvedTargets) {
                target.currentShell = Math.min(target.maxShell, target.currentShell + payload.shell);
                target.currentHull = Math.min(target.maxHull, target.currentHull + payload.hull);
                target.currentEnergy = Math.min(target.maxEnergy, target.currentEnergy + payload.energy);
            }
        }

        this.paidActivation = false;
        this.chargeElapsedMs = 0;
        this.clearTargets();
        this.cooldownElapsedMs = 0;
        this.stateValue = this.definition.operation.cooldown > 0 ? 'cooldown' : 'ready';
        return true;
    }

    private resolveTargets(): Ship[] {
        const owner = this.owner;
        if (!this.isActiveShip(owner)) return [];

        const targeting = this.definition.targeting;
        if (targeting.kind === 'self') {
            return [owner];
        }
        if (targeting.kind === 'single') {
            return this.pendingTarget && this.isEligibleRelationship(owner, this.pendingTarget, targeting)
                ? [this.pendingTarget]
                : [];
        }

        const targets: Ship[] = [];
        const seen = new Set<Ship>();
        for (const candidate of this.game.getActiveShipsInArea(owner.x, owner.y, targeting.radius)) {
            if (seen.has(candidate)) continue;
            if (candidate === owner) {
                if (targeting.includeSelf && this.isInsideArea(owner, owner, targeting.radius)) {
                    targets.push(candidate);
                    seen.add(candidate);
                }
            } else if (
                this.isActiveShip(candidate) &&
                this.isEligibleRelationship(owner, candidate, targeting)
            ) {
                targets.push(candidate);
                seen.add(candidate);
            }
        }

        if (
            targeting.includeSelf &&
            !seen.has(owner) &&
            this.isInsideArea(owner, owner, targeting.radius)
        ) {
            targets.push(owner);
        }
        return targets;
    }

    private isEligibleRelationship(
        owner: Ship,
        target: Ship,
        targeting: Extract<ActiveModuleTargeting, { kind: 'single' | 'area' }>
    ): boolean {
        if (!this.isActiveShip(owner) || !this.isActiveShip(target)) return false;
        return targeting.allowed.some((relationship) =>
            relationship === 'Ally'
                ? this.game.factionManager.isAlly(owner, target)
                : this.game.factionManager.isEnemy(owner, target)
        );
    }

    private isActiveShip(ship: Ship | null): ship is Ship {
        return !!ship && ship.active && !ship.removeIt;
    }

    private isInsideArea(owner: Ship, candidate: Ship, radius: number): boolean {
        const dx = candidate.x - owner.x;
        const dy = candidate.y - owner.y;
        return dx * dx + dy * dy <= radius * radius;
    }

    private clearTargets(): void {
        this.pendingTarget = null;
        this.resolvedTargets = [];
    }
}

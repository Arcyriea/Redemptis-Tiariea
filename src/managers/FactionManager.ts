import { Entity } from '../entities/Entity';

export type FactionRelationship = 'Ally' | 'Neutral' | 'Enemy';

declare const FactionBrand: unique symbol;
export type FactionId = string & { readonly [FactionBrand]: typeof FactionBrand };

export function createFactionId(id: string): FactionId {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Faction ID must be a non-empty string.');
    }
    return id as FactionId;
}

export const YUTIARINALIA: FactionId = createFactionId('Yutiarinalia');
export const AISTIARIA: FactionId = createFactionId('Aistiaria');
export const VERDANIA: FactionId = createFactionId('Verdania');

export const HARMONICA: FactionId = createFactionId('Harmonica');
export const IMPERICA: FactionId = createFactionId('Imperica');
export const EVANGELISTA: FactionId = createFactionId('Evangelista');

export const DIVINICA: FactionId = createFactionId('Divinica');
export const AMETHYSCA: FactionId = createFactionId('Amethysca');
export const YINYALISTA: FactionId = createFactionId('Yinyalista');

export const CALIPHISTA: FactionId = createFactionId('Caliphista');
export const DORANIACA: FactionId = createFactionId('Doraniaca');
export const ISILICA: FactionId = createFactionId('Isilica');

export const SULMAKARAIK: FactionId = createFactionId('Sulmakaraik');
export const KULSIRAKYIL: FactionId = createFactionId('Kulsirakyil');
export const ULTHYRIAKYIAI: FactionId = createFactionId('Ulthyriakyiai');

export const CALIPHATHIC_EDEN: FactionId = createFactionId('Caliphathic Eden');
export const ASTRAL_UNION: FactionId = createFactionId('Astral Union');

export const JURISDICTATE_COUNCIL: FactionId = createFactionId('Jurisdictate Council');
export const UNITED_GALACTIC_FEDERATION: FactionId = createFactionId('United Galactic Federation');

export const ELVEN_IJYIAKARYAI: FactionId = createFactionId('Elven Ijyiakaryai');
export const MERASSYILRI: FactionId = createFactionId('Merassyilri');
export const NIARIEKYIAI: FactionId = createFactionId('Niariekyiai');
export const KISARAKYIL: FactionId = createFactionId('Kisarakyil');
export const SAKIGARAIK: FactionId = createFactionId('Sakigaraik');
export const HAYAKIYIAI: FactionId = createFactionId('Hayakiyiai');

export const FREE_INNOMINI: FactionId = createFactionId('Free Innomini');

export const RESERVED_FACTIONS: readonly FactionId[] = [
    VERDANIA,
    HARMONICA,
    IMPERICA,
    EVANGELISTA,
    DIVINICA,
    AMETHYSCA,
    YINYALISTA,
    CALIPHISTA,
    DORANIACA,
    ISILICA,
    SULMAKARAIK,
    KULSIRAKYIL,
    ULTHYRIAKYIAI,
    CALIPHATHIC_EDEN,
    ASTRAL_UNION,
    JURISDICTATE_COUNCIL,
    UNITED_GALACTIC_FEDERATION,
    ELVEN_IJYIAKARYAI,
    FREE_INNOMINI
];

export const ALLY_THRESHOLD = 50;
export const ENEMY_THRESHOLD = -50;
export const MIN_RELATIONSHIP_SCORE = -100;
export const MAX_RELATIONSHIP_SCORE = 100;
export const DEFAULT_RELATIONSHIP_SCORE = 0;
export const ENEMY_BASE_SCORE = -100;

export class FactionManager {
    private readonly factions = new Set<FactionId>();
    private readonly memberships = new Map<Entity, FactionId>();
    private readonly relationshipScores = new Map<string, number>();

    constructor() {
        this.registerFaction(YUTIARINALIA);
        this.registerFaction(AISTIARIA);
        for (const faction of RESERVED_FACTIONS) {
            this.registerFaction(faction);
        }
        this.setRelationshipScore(YUTIARINALIA, AISTIARIA, ENEMY_BASE_SCORE);
    }

    registerFaction(id: FactionId): void {
        this.assertValidFactionId(id);
        this.factions.add(id);
    }

    isFactionRegistered(id: FactionId): boolean {
        return typeof id === 'string' && this.factions.has(id);
    }

    getFactions(): FactionId[] {
        return Array.from(this.factions);
    }

    factionCount(): number {
        return this.factions.size;
    }

    setFaction(entity: Entity | null | undefined, faction: FactionId): void {
        this.assertRegisteredFaction(faction);
        if (entity) this.memberships.set(entity, faction);
    }

    getFaction(entity: Entity | null | undefined): FactionId | undefined {
        if (!entity) return undefined;
        return this.memberships.get(entity);
    }

    hasFaction(entity: Entity | null | undefined): boolean {
        return this.getFaction(entity) !== undefined;
    }

    clearFaction(entity: Entity | null | undefined): void {
        if (entity) this.memberships.delete(entity);
    }

    get size(): number {
        return this.memberships.size;
    }

    getRelationshipScore(a: FactionId, b: FactionId): number {
        this.assertRegisteredFaction(a);
        this.assertRegisteredFaction(b);
        if (a === b) return DEFAULT_RELATIONSHIP_SCORE;
        return this.relationshipScores.get(this.relationshipKey(a, b)) ?? DEFAULT_RELATIONSHIP_SCORE;
    }

    setRelationshipScore(a: FactionId, b: FactionId, score: number): void {
        this.assertRelationshipPair(a, b);
        if (!Number.isFinite(score)) {
            throw new Error('Relationship score must be a finite number.');
        }
        if (score < MIN_RELATIONSHIP_SCORE || score > MAX_RELATIONSHIP_SCORE) {
            throw new Error(`Relationship score must be between ${MIN_RELATIONSHIP_SCORE} and ${MAX_RELATIONSHIP_SCORE}.`);
        }
        this.relationshipScores.set(this.relationshipKey(a, b), score);
    }

    adjustRelationshipScore(a: FactionId, b: FactionId, delta: number): void {
        this.assertRelationshipPair(a, b);
        if (!Number.isFinite(delta)) {
            throw new Error('Relationship score adjustment must be a finite number.');
        }
        const score = Math.max(
            MIN_RELATIONSHIP_SCORE,
            Math.min(MAX_RELATIONSHIP_SCORE, this.getRelationshipScore(a, b) + delta)
        );
        this.relationshipScores.set(this.relationshipKey(a, b), score);
    }

    getFactionRelationship(a: FactionId, b: FactionId): FactionRelationship {
        this.assertRegisteredFaction(a);
        this.assertRegisteredFaction(b);
        if (a === b) return 'Ally';
        return this.deriveRelationship(this.getRelationshipScore(a, b));
    }

    isFactionAlly(a: FactionId, b: FactionId): boolean {
        return this.getFactionRelationship(a, b) === 'Ally';
    }

    isFactionEnemy(a: FactionId, b: FactionId): boolean {
        return this.getFactionRelationship(a, b) === 'Enemy';
    }

    isFactionNeutral(a: FactionId, b: FactionId): boolean {
        return this.getFactionRelationship(a, b) === 'Neutral';
    }

    getRelationship(
        a: Entity | null | undefined,
        b: Entity | null | undefined
    ): FactionRelationship | undefined {
        const factionA = this.getFaction(a);
        const factionB = this.getFaction(b);
        if (!factionA || !factionB) return undefined;
        return this.getFactionRelationship(factionA, factionB);
    }

    isAlly(a: Entity | null | undefined, b: Entity | null | undefined): boolean {
        return this.getRelationship(a, b) === 'Ally';
    }

    isEnemy(a: Entity | null | undefined, b: Entity | null | undefined): boolean {
        return this.getRelationship(a, b) === 'Enemy';
    }

    isNeutral(a: Entity | null | undefined, b: Entity | null | undefined): boolean {
        return this.getRelationship(a, b) === 'Neutral';
    }

    isAllyOfFaction(entity: Entity | null | undefined, faction: FactionId): boolean {
        const entityFaction = this.getFaction(entity);
        return entityFaction !== undefined && this.isFactionAlly(entityFaction, faction);
    }

    isEnemyOfFaction(entity: Entity | null | undefined, faction: FactionId): boolean {
        const entityFaction = this.getFaction(entity);
        return entityFaction !== undefined && this.isFactionEnemy(entityFaction, faction);
    }

    isNeutralTowardFaction(entity: Entity | null | undefined, faction: FactionId): boolean {
        const entityFaction = this.getFaction(entity);
        return entityFaction !== undefined && this.isFactionNeutral(entityFaction, faction);
    }

    clear(): void {
        this.memberships.clear();
    }

    private assertValidFactionId(id: FactionId): void {
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new Error('Faction ID must be a non-empty string.');
        }
    }

    private assertRegisteredFaction(id: FactionId): void {
        this.assertValidFactionId(id);
        if (!this.factions.has(id)) {
            throw new Error(`Faction "${id}" is not registered.`);
        }
    }

    private assertRelationshipPair(a: FactionId, b: FactionId): void {
        this.assertRegisteredFaction(a);
        this.assertRegisteredFaction(b);
        if (a === b) {
            throw new Error('A faction cannot have a relationship score with itself.');
        }
    }

    private relationshipKey(a: FactionId, b: FactionId): string {
        return JSON.stringify(a < b ? [a, b] : [b, a]);
    }

    private deriveRelationship(score: number): FactionRelationship {
        if (score >= ALLY_THRESHOLD) return 'Ally';
        if (score <= ENEMY_THRESHOLD) return 'Enemy';
        return 'Neutral';
    }
}

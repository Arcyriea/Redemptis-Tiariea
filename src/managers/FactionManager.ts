import { Entity } from '../entities/Entity';

export type FactionRelationship = 'Ally' | 'Neutral' | 'Enemy';

declare const FactionBrand: unique symbol;
export type FactionId = string & { readonly [FactionBrand]: typeof FactionBrand };

declare const DiplomaticGroupBrand: unique symbol;
export type DiplomaticGroupId = string & { readonly [DiplomaticGroupBrand]: typeof DiplomaticGroupBrand };

export function createFactionId(id: string): FactionId {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Faction ID must be a non-empty string.');
    }
    return id as FactionId;
}

export function createDiplomaticGroupId(id: string): DiplomaticGroupId {
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Diplomatic group ID must be a non-empty string.');
    }
    return id as DiplomaticGroupId;
}

export type DiplomaticPrincipal =
    | { readonly kind: 'faction'; readonly id: FactionId }
    | { readonly kind: 'group'; readonly id: DiplomaticGroupId };

export function factionPrincipal(id: FactionId): DiplomaticPrincipal {
    return { kind: 'faction', id };
}

export function groupPrincipal(id: DiplomaticGroupId): DiplomaticPrincipal {
    return { kind: 'group', id };
}

export type DiplomaticAgreementDefinition =
    | {
        readonly id: string;
        readonly type: 'Alliance';
        readonly participants: readonly [DiplomaticPrincipal, DiplomaticPrincipal];
    }
    | {
        readonly id: string;
        readonly type: 'Ceasefire';
        readonly participants: readonly [DiplomaticPrincipal, DiplomaticPrincipal];
    }
    | {
        readonly id: string;
        readonly type: 'Treaty';
        readonly participants: readonly [DiplomaticPrincipal, DiplomaticPrincipal];
        readonly relationship: FactionRelationship;
    };

export interface RelationshipResolution {
    readonly relationship: FactionRelationship;
    readonly baselineRelationship: FactionRelationship;
    readonly source: 'same-faction' | 'direct' | 'group-diplomacy' | 'default-neutral' | 'agreement';
    readonly agreements: readonly { readonly id: string; readonly type: DiplomaticAgreementDefinition['type'] }[];
}

interface DiplomaticAgreement {
    readonly id: string;
    readonly type: DiplomaticAgreementDefinition['type'];
    readonly participants: readonly [DiplomaticPrincipal, DiplomaticPrincipal];
    readonly relationship: FactionRelationship;
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

// Pre-register reserved lore IDs so they can receive memberships immediately;
// their relationships remain neutral until configured.
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
    MERASSYILRI,
    NIARIEKYIAI,
    KISARAKYIL,
    SAKIGARAIK,
    HAYAKIYIAI,
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
    private readonly groups = new Set<DiplomaticGroupId>();
    private readonly factionGroups = new Map<FactionId, DiplomaticGroupId>();
    private readonly memberships = new Map<Entity, FactionId>();
    private readonly relationshipScores = new Map<string, number>();
    private readonly diplomaticRelationshipScores = new Map<string, number>();
    private readonly agreements = new Map<string, DiplomaticAgreement>();

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

    registerGroup(id: DiplomaticGroupId): void {
        this.assertValidGroupId(id);
        this.groups.add(id);
    }

    isGroupRegistered(id: DiplomaticGroupId): boolean {
        return typeof id === 'string' && this.groups.has(id);
    }

    getGroups(): DiplomaticGroupId[] {
        return Array.from(this.groups);
    }

    /**
     * Assigns one political group to a faction, replacing any previous group.
     * Faction-principal diplomatic scores are retained; while grouped, resolution
     * uses the assigned group instead, and the faction scores become applicable
     * again if the faction is later independent.
     */
    setFactionGroup(faction: FactionId, group: DiplomaticGroupId | null): void {
        this.assertRegisteredFaction(faction);
        if (group !== null) this.assertRegisteredGroup(group);

        const previousGroup = this.factionGroups.get(faction);
        if (group === null) {
            this.factionGroups.delete(faction);
        } else {
            this.factionGroups.set(faction, group);
        }

        try {
            this.assertNoAgreementsWithCurrentGroups();
            this.assertNoAmbiguousAgreements();
        } catch (error) {
            if (previousGroup === undefined) {
                this.factionGroups.delete(faction);
            } else {
                this.factionGroups.set(faction, previousGroup);
            }
            throw error;
        }
    }

    getFactionGroup(faction: FactionId): DiplomaticGroupId | undefined {
        this.assertRegisteredFaction(faction);
        return this.factionGroups.get(faction);
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
        this.assertRelationshipScore(score);
        this.relationshipScores.set(this.relationshipKey(a, b), score);
    }

    /** Reads scores by principal identity, including dormant scores for grouped factions. */
    getDiplomaticRelationshipScore(a: DiplomaticPrincipal, b: DiplomaticPrincipal): number {
        this.assertPrincipal(a);
        this.assertPrincipal(b);
        this.assertExternalPrincipalPair(a, b);
        return this.diplomaticRelationshipScores.get(this.diplomaticRelationshipKey(a, b))
            ?? DEFAULT_RELATIONSHIP_SCORE;
    }

    /**
     * Stores scores by principal identity. A faction-principal score remains
     * stored while that faction is grouped, but resolution uses the group's score.
     */
    setDiplomaticRelationshipScore(a: DiplomaticPrincipal, b: DiplomaticPrincipal, score: number): void {
        this.assertPrincipal(a);
        this.assertPrincipal(b);
        this.assertExternalPrincipalPair(a, b);
        this.assertRelationshipScore(score);
        this.diplomaticRelationshipScores.set(this.diplomaticRelationshipKey(a, b), score);
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
        return this.resolveRelationship(a, b).relationship;
    }

    resolveRelationship(a: FactionId, b: FactionId): RelationshipResolution {
        this.assertRegisteredFaction(a);
        this.assertRegisteredFaction(b);

        if (a === b) {
            return {
                relationship: 'Ally',
                baselineRelationship: 'Ally',
                source: 'same-faction',
                agreements: []
            };
        }

        const groupA = this.factionGroups.get(a);
        const groupB = this.factionGroups.get(b);
        const internalPair = groupA !== undefined && groupA === groupB;
        const baselineScore = internalPair || (!groupA && !groupB)
            ? this.relationshipScores.get(this.relationshipKey(a, b))
            : this.diplomaticRelationshipScores.get(
                this.diplomaticRelationshipKey(
                    groupA ? groupPrincipal(groupA) : factionPrincipal(a),
                    groupB ? groupPrincipal(groupB) : factionPrincipal(b)
                )
            );
        const baselineRelationship = this.deriveRelationship(baselineScore ?? DEFAULT_RELATIONSHIP_SCORE);
        const source = internalPair || (!groupA && !groupB)
            ? (baselineScore === undefined ? 'default-neutral' : 'direct')
            : (baselineScore === undefined ? 'default-neutral' : 'group-diplomacy');

        const applicableAgreements = this.getApplicableAgreements(a, b, internalPair);
        if (applicableAgreements.length === 0) {
            return {
                relationship: baselineRelationship,
                baselineRelationship,
                source,
                agreements: []
            };
        }

        const highestSpecificity = Math.max(...applicableAgreements.map((agreement) => this.agreementSpecificity(agreement)));
        const mostSpecific = applicableAgreements
            .filter((agreement) => this.agreementSpecificity(agreement) === highestSpecificity)
            .sort((left, right) => left.id.localeCompare(right.id));
        const outcomes = new Set(mostSpecific.map((agreement) => agreement.relationship));
        if (outcomes.size > 1) {
            throw new Error(`Ambiguous diplomatic agreements apply to "${a}" and "${b}".`);
        }

        return {
            relationship: mostSpecific[0].relationship,
            baselineRelationship,
            source: 'agreement',
            agreements: mostSpecific.map(({ id, type }) => ({ id, type }))
        };
    }

    registerAgreement(definition: DiplomaticAgreementDefinition): void {
        if (typeof definition.id !== 'string' || definition.id.trim().length === 0) {
            throw new Error('Diplomatic agreement ID must be a non-empty string.');
        }
        if (this.agreements.has(definition.id)) {
            throw new Error(`Diplomatic agreement "${definition.id}" is already registered.`);
        }
        if (!definition.participants || definition.participants.length !== 2) {
            throw new Error('A diplomatic agreement must have exactly two participants.');
        }
        const [first, second] = definition.participants;
        this.assertPrincipal(first);
        this.assertPrincipal(second);
        if (this.diplomaticPrincipalKey(first) === this.diplomaticPrincipalKey(second)) {
            throw new Error('A diplomatic agreement requires two distinct participants.');
        }
        const participantPairKey = this.diplomaticRelationshipKey(first, second);
        if (Array.from(this.agreements.values()).some((agreement) =>
            this.diplomaticRelationshipKey(agreement.participants[0], agreement.participants[1]) === participantPairKey
        )) {
            throw new Error('An agreement already exists for these exact participants; revoke it before replacing it.');
        }
        if (this.isAgreementBetweenFactionAndItsCurrentGroup(first, second)) {
            throw new Error('A faction cannot have an agreement with its current political group.');
        }

        const relationship = definition.type === 'Alliance'
            ? 'Ally'
            : definition.type === 'Ceasefire'
                ? 'Neutral'
                : definition.relationship;
        if (!['Ally', 'Neutral', 'Enemy'].includes(relationship)) {
            throw new Error('A treaty must declare an Ally, Neutral, or Enemy relationship.');
        }

        const agreement: DiplomaticAgreement = {
            id: definition.id,
            type: definition.type,
            participants: [first, second],
            relationship
        };
        this.agreements.set(agreement.id, agreement);
        try {
            this.assertNoAmbiguousAgreements();
        } catch (error) {
            this.agreements.delete(agreement.id);
            throw error;
        }
    }

    revokeAgreement(id: string): boolean {
        return this.agreements.delete(id);
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

    private assertRelationshipScore(score: number): void {
        if (!Number.isFinite(score)) {
            throw new Error('Relationship score must be a finite number.');
        }
        if (score < MIN_RELATIONSHIP_SCORE || score > MAX_RELATIONSHIP_SCORE) {
            throw new Error(`Relationship score must be between ${MIN_RELATIONSHIP_SCORE} and ${MAX_RELATIONSHIP_SCORE}.`);
        }
    }

    private assertValidGroupId(id: DiplomaticGroupId): void {
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new Error('Diplomatic group ID must be a non-empty string.');
        }
    }

    private assertRegisteredGroup(id: DiplomaticGroupId): void {
        this.assertValidGroupId(id);
        if (!this.groups.has(id)) {
            throw new Error(`Diplomatic group "${id}" is not registered.`);
        }
    }

    private assertPrincipal(principal: DiplomaticPrincipal): void {
        if (!principal || (principal.kind !== 'faction' && principal.kind !== 'group')) {
            throw new Error('Diplomatic principal must be a faction or group.');
        }
        if (principal.kind === 'faction') this.assertRegisteredFaction(principal.id);
        else this.assertRegisteredGroup(principal.id);
    }

    private assertExternalPrincipalPair(a: DiplomaticPrincipal, b: DiplomaticPrincipal): void {
        if (a.kind === 'faction' && b.kind === 'faction') {
            throw new Error('Group diplomacy must include at least one political group.');
        }
        if (this.diplomaticPrincipalKey(a) === this.diplomaticPrincipalKey(b)) {
            throw new Error('A diplomatic principal cannot have a relationship score with itself.');
        }
    }

    private isAgreementBetweenFactionAndItsCurrentGroup(
        first: DiplomaticPrincipal,
        second: DiplomaticPrincipal
    ): boolean {
        const faction = first.kind === 'faction' ? first : second.kind === 'faction' ? second : undefined;
        const group = first.kind === 'group' ? first : second.kind === 'group' ? second : undefined;
        return faction !== undefined &&
            group !== undefined &&
            this.factionGroups.get(faction.id) === group.id;
    }

    private assertNoAgreementsWithCurrentGroups(): void {
        for (const agreement of this.agreements.values()) {
            if (this.isAgreementBetweenFactionAndItsCurrentGroup(
                agreement.participants[0],
                agreement.participants[1]
            )) {
                throw new Error('A faction cannot have an agreement with its current political group.');
            }
        }
    }

    private diplomaticPrincipalKey(principal: DiplomaticPrincipal): string {
        return `${principal.kind}:${principal.id}`;
    }

    private diplomaticRelationshipKey(a: DiplomaticPrincipal, b: DiplomaticPrincipal): string {
        const keys = [this.diplomaticPrincipalKey(a), this.diplomaticPrincipalKey(b)].sort();
        return JSON.stringify(keys);
    }

    private getApplicableAgreements(
        factionA: FactionId,
        factionB: FactionId,
        internalPair: boolean
    ): DiplomaticAgreement[] {
        return Array.from(this.agreements.values()).filter((agreement) => {
            const [first, second] = agreement.participants;
            if (internalPair && (first.kind !== 'faction' || second.kind !== 'faction')) return false;
            return (this.principalMatches(first, factionA) && this.principalMatches(second, factionB)) ||
                (this.principalMatches(first, factionB) && this.principalMatches(second, factionA));
        });
    }

    private principalMatches(principal: DiplomaticPrincipal, faction: FactionId): boolean {
        if (principal.kind === 'faction') return principal.id === faction;
        return this.factionGroups.get(faction) === principal.id;
    }

    private agreementSpecificity(agreement: DiplomaticAgreement): number {
        return agreement.participants.filter((participant) => participant.kind === 'faction').length;
    }

    // Validate every currently resolvable pair; group reassignment calls this
    // too, so a previously non-overlapping scope cannot become ambiguous.
    private assertNoAmbiguousAgreements(): void {
        const factions = Array.from(this.factions);
        for (let first = 0; first < factions.length; first++) {
            for (let second = first + 1; second < factions.length; second++) {
                const [factionA, factionB] = [factions[first], factions[second]];
                const internalPair = this.factionGroups.get(factionA) !== undefined &&
                    this.factionGroups.get(factionA) === this.factionGroups.get(factionB);
                const applicable = this.getApplicableAgreements(factionA, factionB, internalPair);
                if (applicable.length < 2) continue;

                const highestSpecificity = Math.max(...applicable.map((agreement) => this.agreementSpecificity(agreement)));
                const outcomes = new Set(
                    applicable
                        .filter((agreement) => this.agreementSpecificity(agreement) === highestSpecificity)
                        .map((agreement) => agreement.relationship)
                );
                if (outcomes.size > 1) {
                    throw new Error(`Conflicting diplomatic agreements apply to "${factionA}" and "${factionB}".`);
                }
            }
        }
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

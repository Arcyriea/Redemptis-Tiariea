import { Game } from '../core/Game';

export interface ShipBlueprintStats {
    maxHull: number;
    maxShell: number;
    regenShell: number;
    maxEnergy: number;
    regenEnergy?: number;
    maxSpeed: number;
    acceleration: number;
    weight: number;
    radius: number;
    value: number;
}

export interface ShipBlueprintPart {
    name: string;
    x: number;
    y: number;
    rotation: number;
    isLoot: boolean;
    maxHull?: number;
}

export interface ShipBlueprintComponent {
    partIndex: number;
    name: string;
}

export interface ShipBlueprintVisualSprite {
    textureKey: string;
    x: number;
    y: number;
    scale?: number;
}

export interface ShipBlueprintDefinition {
    superType: string;
    subType: string;
    name: string;
    categoryType: string;
    stats: ShipBlueprintStats;
    gameplay: {
        parts: ShipBlueprintPart[];
        components: ShipBlueprintComponent[];
    };
    visual: {
        sprites: ShipBlueprintVisualSprite[];
    };
}

export type LegacyShipDefinition = [
    parts: unknown[][],
    components: unknown[][],
    superType: string,
    subType: string,
    name: string,
    categoryType: string
];

/**
 * Stable catalogue entry for a ship definition. Structured definitions are
 * owned by the blueprint; legacy definitions continue to resolve from
 * Game.shipData until their consumers have migrated.
 */
export class ShipBlueprint {
    public readonly id: string;
    public readonly sourceKey: string;
    public readonly shipDefinition?: ShipBlueprintDefinition;

    constructor(id: string, sourceKey: string, shipDefinition?: ShipBlueprintDefinition) {
        this.id = id;
        this.sourceKey = sourceKey;
        this.shipDefinition = shipDefinition;
    }

    /** Resolve a structured blueprint first, then the legacy tuple if present. */
    get definition(): ShipBlueprintDefinition | LegacyShipDefinition | undefined {
        return this.shipDefinition ?? Game.instance?.shipData?.[this.sourceKey];
    }

    get isLoaded(): boolean {
        return !!this.definition;
    }
}

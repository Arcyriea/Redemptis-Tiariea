import { Game } from '../core/Game';
import type {
    ShipBlueprintDefinition as CanonicalShipBlueprintDefinition,
    ShipBlueprintStats as CanonicalShipBlueprintStats,
    LegacyShipDefinition as CanonicalLegacyShipDefinition
} from '../types/Shipmaker';

export type ShipBlueprintStats = CanonicalShipBlueprintStats;
export type LegacyShipDefinition = CanonicalLegacyShipDefinition;

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

/** Existing structured blueprint shape retained for player and debug ships. */
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

export type StructuredShipBlueprintDefinition =
    | CanonicalShipBlueprintDefinition
    | ShipBlueprintDefinition;

export type LegacyShipTuple = CanonicalLegacyShipDefinition;

/**
 * Stable catalogue entry for a ship definition. Structured definitions are
 * owned by the blueprint; legacy definitions continue to resolve from
 * Game.shipData until their consumers have migrated.
 */
export class ShipBlueprint {
    public readonly id: string;
    public readonly sourceKey: string;
    public readonly shipDefinition?: StructuredShipBlueprintDefinition;

    constructor(id: string, sourceKey: string, shipDefinition?: StructuredShipBlueprintDefinition) {
        this.id = id;
        this.sourceKey = sourceKey;
        this.shipDefinition = shipDefinition;
    }

    /** Resolve a structured blueprint first, then the legacy tuple if present. */
    get definition(): StructuredShipBlueprintDefinition | LegacyShipTuple | undefined {
        return this.shipDefinition ?? Game.instance?.shipData?.[this.sourceKey];
    }

    get isLoaded(): boolean {
        return !!this.definition;
    }
}

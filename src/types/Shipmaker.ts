export type HullPartId = string & { readonly __hullPartId: unique symbol };
export type HullPointId = string & { readonly __hullPointId: unique symbol };
export type ComponentId = string;
export type SpriteKey = string;

export const toHullPartId = (id: string): HullPartId => id as HullPartId;
export const toHullPointId = (id: string): HullPointId => id as HullPointId;

export interface Point2 {
    x: number;
    y: number;
}

export interface SpriteLayer {
    id: string;
    textureKey: SpriteKey;
    textureOrigin?: Point2;
    position: Point2;
    rotationDeg?: number;
    scale?: Point2;
    rotationFrame?: 'component' | 'turret';
    order: number;
}

export interface HullPart {
    id: HullPartId;
    name: string;
    position: Point2;
    rotationDeg: number;
    isLoot: boolean;
    maxHull?: number;
}

export interface WeaponHardpoint {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    accepts: readonly ('spinal' | 'turret')[];
    maxDimensions?: Point2;
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface ThrusterVent {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    width: number;
    height: number;
    exhaustDirectionDeg: number;
    acceptsPropulsionCategories: readonly string[];
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface UtilitySocket {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    acceptedCategories: readonly string[];
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface HullDefinition {
    id: string;
    parts: readonly HullPart[];
    sprites: readonly SpriteLayer[];
    weaponHardpoints: readonly WeaponHardpoint[];
    thrusterVents: readonly ThrusterVent[];
    utilitySockets: readonly UtilitySocket[];
}

export interface ComponentAttachment {
    position: Point2;
    attachmentRotationDeg: number;
}

export interface BaseComponentDef {
    id: ComponentId;
    operation: {
        cooldown: number;
        energyCost: number;
    };
    attachment: ComponentAttachment;
    dimensions?: {
        length: number;
        width: number;
        height: number;
    };
}

export type WeaponOperation = BaseComponentDef['operation'] & {
    firingMode: string;
    damage: number;
    range: number;
    projectileSpeed: number;
    splashRadius: number;
};

export interface SpinalWeaponDefinition extends BaseComponentDef {
    kind: 'weapon';
    configuration: 'spinal';
    operation: WeaponOperation;
    visuals: {
        fixed: readonly SpriteLayer[];
    };
    geometry: {
        muzzles: readonly {
            position: Point2;
            directionDeg: number;
        }[];
    };
}

export interface TurretWeaponDefinition extends BaseComponentDef {
    kind: 'weapon';
    configuration: 'turret';
    operation: WeaponOperation;
    visuals: {
        fixed: readonly SpriteLayer[];
        rotating: readonly SpriteLayer[];
    };
    geometry: {
        pivot: Point2;
        rotationLimitsDeg: {
            min: number;
            max: number;
        };
        rotationSpeedDegPerSecond: number;
        barrels: readonly {
            id: string;
            position: Point2;
            rotationDeg: number;
            muzzles: readonly {
                position: Point2;
                directionDeg: number;
            }[];
        }[];
    };
}

export interface PropulsionComponentDefinition extends BaseComponentDef {
    kind: 'propulsion';
    category: string;
    propulsion: {
        output: number;
    };
    sprites: readonly SpriteLayer[];
}

export interface UtilityComponentDefinition extends BaseComponentDef {
    kind: 'utility';
    category: string;
    sprites: readonly SpriteLayer[];
}

export type LegacyComponentCategory = 'Weapon' | 'Skill' | 'Spawn' | 'Passive';

export interface LegacyWeaponValues {
    firingMode: string;
    damage: number;
    range: number;
    projectileSpeed: number;
    splashRadius: number;
}

export interface LegacyComponentDef {
    kind: 'legacy';
    id: ComponentId;
    category: LegacyComponentCategory;
    subType: string;
    value: number;
    cooldown: number;
    energyCost: number;
    description: string;
    weapon?: LegacyWeaponValues;
}

export type ComponentDefinition =
    | SpinalWeaponDefinition
    | TurretWeaponDefinition
    | PropulsionComponentDefinition
    | UtilityComponentDefinition
    | LegacyComponentDef;

export interface LegacyShipPartTuple {
    name: string;
    x: number;
    y: number;
    rotationDeg: number;
    isLoot?: boolean;
    maxHull?: number;
}

export type LegacyShipComponentReference =
    | string
    | readonly [componentId: string]
    | null
    | undefined;

export type LegacyShipDefinition = [
    parts: Array<
        | [name: string, x: number, y: number, rotationDeg: number, isLoot?: boolean, maxHull?: number]
        | LegacyShipPartTuple
    >,
    components: LegacyShipComponentReference[],
    superType: string,
    subType: string,
    name: string,
    categoryType: string
];

export type LegacyComponentTuple =
    | [
        category: 'Weapon',
        firingMode?: string,
        damage?: number,
        range?: number,
        cooldown?: number,
        energyCost?: number,
        projectileSpeed?: number,
        splashRadius?: number,
        ...extra: Array<string | number>
    ]
    | [
        category: Exclude<LegacyComponentCategory, 'Weapon'>,
        subType?: string,
        value?: number,
        cooldown?: number,
        energyCost?: number,
        description?: string,
        ...extra: Array<string | number>
    ];

export interface LegacyComponentAttachment {
    partIndex: number;
    mountId: HullPointId;
    componentId: ComponentId;
}

export interface LegacyCompatibilityView {
    hullId: string;
    loadoutId: string;
    legacyAttachments: readonly LegacyComponentAttachment[];
}

export interface InstallationRecord {
    mountId: HullPointId;
    componentId: ComponentId;
}

export interface ShipLoadout {
    id: string;
    installations: readonly InstallationRecord[];
}

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

export interface ShipBlueprintDefinition {
    hullId: string;
    loadoutId: string;
    superType: string;
    subType: string;
    name: string;
    categoryType: string;
    stats: ShipBlueprintStats;
}

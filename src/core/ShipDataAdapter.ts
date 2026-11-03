import type { Game } from './Game';
import {
    ComponentDefinition,
    HullDefinition,
    LegacyComponentDef,
    LegacyComponentAttachment,
    LegacyComponentCategory,
    LegacyComponentTuple,
    LegacyShipDefinition,
    LegacyShipComponentReference,
    ShipLoadout,
    toHullPartId,
    toHullPointId
} from '../types/Shipmaker';

export class ShipDataAdapter {
    static ingestLegacyData(game: Game): void {
        game.hullDefinitions ??= new Map();
        game.componentDefinitions ??= new Map();
        game.shipLoadouts ??= new Map();
        game.legacyCompatibilityViews ??= new Map();
        game.hullDefinitions.clear();
        game.componentDefinitions.clear();
        game.shipLoadouts.clear();
        game.legacyCompatibilityViews.clear();

        const componentData = game.componentData as Record<string, LegacyComponentTuple>;
        const shipData = game.shipData as Record<string, LegacyShipDefinition>;
        for (const [componentId, tuple] of Object.entries(componentData)) {
            game.componentDefinitions.set(componentId, this.adaptComponent(componentId, tuple));
        }

        for (const [sourceKey, shipTuple] of Object.entries(shipData)) {
            const [legacyParts, componentReferences] = shipTuple;
            const hullId = `hull.${sourceKey}`;
            const loadoutId = `loadout.${sourceKey}`;
            const parts = legacyParts.map((part, index) => {
                const [name, x, y, rotationDeg, isLoot = false, maxHull] = this.partValues(part);
                return {
                    id: toHullPartId(`part_${index}`),
                    name,
                    position: { x: x * 5, y: y * 5 },
                    rotationDeg,
                    isLoot,
                    ...(maxHull === undefined ? {} : { maxHull })
                };
            });

            const hull: HullDefinition = {
                id: hullId,
                parts,
                sprites: [],
                weaponHardpoints: [],
                activeModuleMounts: [],
                thrusterVents: [],
                utilitySockets: [],
                hullModCapacity: 0
            };
            const installations: ShipLoadout['installations'][number][] = [];
            const legacyAttachments: LegacyComponentAttachment[] = [];

            for (let partIndex = 0; partIndex < componentReferences.length; partIndex++) {
                const componentId = this.componentId(componentReferences[partIndex]);
                if (!componentId) continue;

                const definition = game.componentDefinitions.get(componentId);
                if (!definition) {
                    throw new Error(
                        `Legacy ship "${sourceKey}" references missing component "${componentId}".`
                    );
                }

                const mountId = toHullPointId(`legacy.${sourceKey}.part.${partIndex}`);
                const part = parts[partIndex];
                if (!part) {
                    throw new Error(
                        `Legacy ship "${sourceKey}" attaches component "${componentId}" to missing part ${partIndex}.`
                    );
                }

                if (definition.kind === 'legacy' && definition.category === 'Weapon') {
                    hull.weaponHardpoints = [
                        ...hull.weaponHardpoints,
                        {
                            id: mountId,
                            position: part.position,
                            rotationDeg: part.rotationDeg,
                            accepts: ['spinal', 'turret'],
                            restrictions: {}
                        }
                    ];
                } else {
                    // Individual classification:
                    // Only explicitly verified legacy components are migrated to canonical mounts.
                    // Everything else is handled via the LegacyCompatibilityView.
                    // Currently, no non-weapon components are verified for canonical migration.
                }

                if (definition.kind !== 'legacy') {
                    installations.push({ mountId, componentId });
                }
                legacyAttachments.push({ partIndex, mountId, componentId });
            }

            game.hullDefinitions.set(hullId, hull);
            game.shipLoadouts.set(loadoutId, { id: loadoutId, installations });
            game.legacyCompatibilityViews.set(sourceKey, {
                hullId,
                loadoutId,
                legacyAttachments
            });
        }
    }

    private static adaptComponent(componentId: string, tuple: LegacyComponentTuple): ComponentDefinition {
        if (tuple[0] === 'Weapon') {
            const category: LegacyComponentCategory = 'Weapon';
            const subType = tuple[1] || componentId;
            const damage = tuple[2] || 10;
            const range = tuple[3] || 300;
            const cooldown = tuple[4] || 1;
            const energyCost = tuple[5] || 5;
            const projectileSpeed = tuple[6] || 10;
            const splashRadius = tuple[7] || 0;
            const legacy: LegacyComponentDef = {
                kind: 'legacy',
                id: componentId,
                category,
                subType,
                value: tuple[2] ?? 0,
                cooldown,
                energyCost,
                description: '',
                weapon: {
                    firingMode: tuple[1] || "Cannon",
                    damage,
                    range,
                    projectileSpeed,
                    splashRadius
                }
            };
            return legacy;
        }

        const category: LegacyComponentCategory = tuple[0] || 'Passive';
        const subType = tuple[1] || componentId;
        const value = tuple[2] ?? 0;
        const cooldown = tuple[3] || 1;
        const energyCost = tuple[4] || 0;
        const description = tuple[5] || '';
        return {
            kind: 'legacy',
            id: componentId,
            category,
            subType,
            value,
            cooldown,
            energyCost,
            description
        };
    }

    private static partValues(
        part: LegacyShipDefinition[0][number]
    ): [string, number, number, number, boolean, number | undefined] {
        if (Array.isArray(part)) {
            const [name, x, y, rotationDeg, isLoot = false, maxHull] = part;
            return [name, x, y, rotationDeg, isLoot, maxHull];
        }
        return [
            part.name,
            part.x,
            part.y,
            part.rotationDeg,
            part.isLoot ?? false,
            part.maxHull
        ];
    }

    private static componentId(reference: LegacyShipComponentReference): string | undefined {
        if (typeof reference === 'string') {
            return reference === 'none' ? undefined : reference;
        }
        if (Array.isArray(reference)) {
            const [componentId] = reference;
            return componentId && componentId !== 'none' ? componentId : undefined;
        }
        return undefined;
    }
}

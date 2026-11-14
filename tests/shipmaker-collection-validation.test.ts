import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ComponentDefinition,
    HullDefinition
} from '../src/types/Shipmaker';
import { parseLuaData } from '../src/shipmaker/luaDataParser.mjs';
import { validateDefinitionDocument } from '../src/shipmaker/definitionValidation';
import {
    validateDefinitionCollection,
    type ExistingContentView
} from '../src/shipmaker/definitionCollectionValidation';
import type { DefinitionDiagnostic, LocallyValidatedDefinitionDocument } from '../src/shipmaker/definitionSchema';
import type { SourceSpan } from '../src/shipmaker/luaDataParser.mjs';

const UUIDS = {
    hullA: 'hull:11111111-1111-4111-8111-111111111111',
    hullB: 'hull:22222222-2222-4222-8222-222222222222',
    shipA: 'ship:33333333-3333-4333-8333-333333333333',
    shipB: 'ship:44444444-4444-4444-8444-444444444444',
    component: 'component:55555555-5555-4555-8555-555555555555',
    component2: 'component:66666666-6666-4666-8666-666666666666',
    loadout: 'loadout:77777777-7777-4777-8777-777777777777',
    loadout2: 'loadout:88888888-8888-4888-8888-888888888888'
} as const;

const EMPTY_CONTENT: ExistingContentView = {
    hullDefinitions: [],
    componentDefinitions: [],
    shipLoadouts: [],
    blueprints: [],
    legacyCompatibilityViewSourceKeys: []
};

function local(source: string, sourceName: string): LocallyValidatedDefinitionDocument {
    const parsed = parseLuaData(source, { sourceName });
    if (!parsed.ok) throw new Error(`Fixture parser failure: ${parsed.diagnostics[0].message}`);
    const result = validateDefinitionDocument(sourceName, parsed.ast);
    if (!result.ok) throw new Error(`Fixture Phase 3A failure: ${result.diagnostics.map((item) => item.path).join(', ')}`);
    return result.document;
}

function hullSource(
    id: string = UUIDS.hullA,
    points: { weapon?: string; vent?: string; utility?: string; active?: string; builtIn?: string } = {}
): string {
    const weapon = points.weapon
        ? `weaponHardpoints = {{ id = "${points.weapon}", position = { x = 0, y = 0 }, rotationDeg = 0, accepts = { "spinal", "turret" }, restrictions = {} }},`
        : 'weaponHardpoints = {},';
    const vent = points.vent
        ? `thrusterVents = {{ id = "${points.vent}", position = { x = 0, y = 0 }, rotationDeg = 0, width = 10, height = 10, exhaustDirectionDeg = 0, acceptsPropulsionCategories = { "engine" }, restrictions = {} }},`
        : 'thrusterVents = {},';
    const utility = points.utility
        ? `utilitySockets = {{ id = "${points.utility}", position = { x = 0, y = 0 }, rotationDeg = 0, acceptedCategories = { "shield" }, restrictions = {} }},`
        : 'utilitySockets = {},';
    const active = points.active
        ? `activeModuleMounts = {{ id = "${points.active}", position = { x = 0, y = 0 }, rotationDeg = 0, acceptedCategories = { "repair" }, restrictions = {} }},`
        : 'activeModuleMounts = {},';
    const weaponWithBuiltIn = points.builtIn && points.weapon
        ? weapon.replace(`id = "${points.weapon}"`, `id = "${points.weapon}", builtInComponentId = "${points.builtIn}"`)
        : weapon;
    return `return {
  schemaVersion = 1,
  domain = "hull",
  definition = {
    id = "${id}",
    parts = {},
    sprites = {},
    ${weaponWithBuiltIn}
    ${active}
    ${vent}
    ${utility}
    hullModCapacity = 0
  }
}`;
}

function canonicalHullSource(
    id: string,
    points: { weapon?: string; vent?: string; utility?: string; active?: string; builtIn?: string } = {}
): string {
    return hullSource(id, points);
}

function componentSource(
    id: string = UUIDS.component,
    kind: 'spinal' | 'propulsion' | 'utility' | 'active-module' = 'spinal',
    category = 'engine',
    configuration: 'spinal' | 'turret' = 'spinal'
): string {
    if (kind === 'spinal') {
        if (configuration === 'turret') {
            return `return { schemaVersion = 1, domain = "component", definition = { id = "${id}", kind = "weapon", configuration = "turret", operation = { firingMode = "Cannon", damage = 1, range = 1, cooldown = 0, energyCost = 0, projectileSpeed = 1, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {}, rotating = {} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = -180, max = 180 }, rotationSpeedDegPerSecond = 0, barrels = {} } } }`;
        }
        return `return { schemaVersion = 1, domain = "component", definition = { id = "${id}", kind = "weapon", configuration = "${configuration}", operation = { firingMode = "Cannon", damage = 1, range = 1, cooldown = 0, energyCost = 0, projectileSpeed = 1, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } } }`;
    }
    if (kind === 'propulsion') {
        return `return { schemaVersion = 1, domain = "component", definition = { id = "${id}", kind = "propulsion", category = "${category}", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, propulsion = { output = 1 }, sprites = {} } }`;
    }
    if (kind === 'utility') {
        return `return { schemaVersion = 1, domain = "component", definition = { id = "${id}", kind = "utility", category = "${category}", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, sprites = {} } }`;
    }
    return `return { schemaVersion = 1, domain = "component", definition = { id = "${id}", kind = "active-module", category = "${category}", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, payload = { kind = "resource_restore", shell = 0, hull = 0, energy = 0 }, targeting = { kind = "self" }, sprites = {} } }`;
}

function loadoutSource(id: string = UUIDS.loadout, mountId?: string, componentId: string = UUIDS.component): string {
    const installations = mountId ? `{{ mountId = "${mountId}", componentId = "${componentId}" }}` : '{}';
    return `return { schemaVersion = 1, domain = "loadout", definition = { id = "${id}", installations = ${installations} } }`;
}

function shipSource(
    id: string = UUIDS.shipA,
    sourceKey: string = 'first',
    hullId: string = UUIDS.hullA,
    loadoutId: string = UUIDS.loadout
): string {
    return `return { schemaVersion = 1, domain = "ship", blueprintId = "${id}", sourceKey = "${sourceKey}", definition = { hullId = "${hullId}", loadoutId = "${loadoutId}", superType = "Ship", subType = "Fighter", name = "Test", categoryType = "Air", stats = { maxHull = 1, maxShell = 1, regenShell = 0, maxEnergy = 1, maxSpeed = 1, acceleration = 1, weight = 1, radius = 1, value = 0 } } }`;
}

function collection(sources: Array<{ source: string; name: string }>, existing = EMPTY_CONTENT) {
    return validateDefinitionCollection(sources.map(({ source, name }) => local(source, name)), existing);
}

function diagnostics(result: ReturnType<typeof validateDefinitionCollection>): DefinitionDiagnostic[] {
    assert.equal(result.ok, false, 'Expected collection validation failure.');
    return result.ok ? [] : result.diagnostics;
}

function pointIdSpan(source: string, id: string): SourceSpan {
    const parsed = parseLuaData(source);
    if (!parsed.ok) throw new Error('Expected fixture parse success.');
    const found: SourceSpan[] = [];
    const visit = (node: typeof parsed.ast): void => {
        for (const entry of node.entries) {
            if (entry.kind === 'field' && entry.key === 'mountId' && entry.value.kind === 'string' && entry.value.value === id) {
                found.push(entry.value.span);
            }
            if (entry.value.kind === 'table') visit(entry.value);
        }
    };
    visit(parsed.ast);
    if (!found[0]) throw new Error(`Could not find point ID ${id}.`);
    return found[0];
}

function existingHull(registryId: string, pointId: string): ExistingContentView['hullDefinitions'][number] {
    return {
        registryId,
        definition: {
            id: registryId,
            parts: [], sprites: [],
            weaponHardpoints: [{ id: pointId as HullDefinition['weaponHardpoints'][number]['id'], position: { x: 0, y: 0 }, rotationDeg: 0, accepts: ['spinal'], restrictions: {} }],
            activeModuleMounts: [], thrusterVents: [], utilitySockets: [], hullModCapacity: 0
        }
    };
}

function existingSpinalComponent(id: string): ExistingContentView['componentDefinitions'][number] {
    const definition: ComponentDefinition = {
        id,
        kind: 'weapon', configuration: 'spinal',
        operation: { firingMode: 'Cannon', damage: 1, range: 1, cooldown: 0, energyCost: 0, projectileSpeed: 1, splashRadius: 0 },
        attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 },
        visuals: { fixed: [] }, geometry: { muzzles: [] }
    };
    return { registryId: id, definition };
}

function withWeaponPoint(base = EMPTY_CONTENT, hullId = 'hull.existing', mountId = 'mount.old'): ExistingContentView {
    return {
        ...base,
        hullDefinitions: [...base.hullDefinitions, existingHull(hullId, mountId)],
        componentDefinitions: [...base.componentDefinitions, existingSpinalComponent('PlayerCannon')],
        shipLoadouts: [...base.shipLoadouts, {
            registryId: 'loadout.old',
            definition: { id: 'loadout.old', installations: [{ mountId: mountId as HullDefinition['weaponHardpoints'][number]['id'], componentId: 'PlayerCannon' }] }
        }],
        blueprints: [...base.blueprints, { id: 'ship.player', sourceKey: 'player' }]
    };
}

function assertFailure(result: ReturnType<typeof validateDefinitionCollection>): asserts result is Extract<ReturnType<typeof validateDefinitionCollection>, { ok: false }> {
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('Expected validation failure.');
}

test('clones and revalidates the complete envelope after a Phase 3A AST mutation', () => {
    const document = local(shipSource(), 'ships/a.lua');
    const version = document.rootAst.entries.find((entry) => entry.kind === 'field' && entry.key === 'schemaVersion');
    assert.ok(version?.kind === 'field' && version.value.kind === 'number');
    if (version?.kind === 'field' && version.value.kind === 'number') version.value.value = 2;

    const result = validateDefinitionCollection([document], EMPTY_CONTENT);
    assertFailure(result);
    assert.ok(result.diagnostics.some((item) => item.code === 'invalid-schema-version' && item.path === 'document.schemaVersion'));
    assert.equal(document.domain, 'ship');
});

test('revalidates envelope metadata instead of trusting copied Phase 3A metadata', () => {
    const document = local(shipSource(), 'ships/missing-envelope-field.lua');
    document.rootAst.entries = document.rootAst.entries.filter((entry) => !(entry.kind === 'field' && entry.key === 'blueprintId'));
    const result = validateDefinitionCollection([document], EMPTY_CONTENT);
    assertFailure(result);
    assert.ok(result.diagnostics.some((item) => item.code === 'missing-field' && item.path === 'document.blueprintId'));
});

test('rejects a cyclic mutated AST with a source-located snapshot diagnostic', () => {
    const document = local(hullSource(), 'hulls/cyclic.lua');
    document.rootAst.entries.push({
        kind: 'array',
        value: document.rootAst,
        span: document.rootAst.span
    });
    const result = validateDefinitionCollection([document], EMPTY_CONTENT);
    assertFailure(result);
    const issue = result.diagnostics.find((item) => item.code === 'invalid-ast-snapshot');
    assert.equal(issue?.sourceName, 'hulls/cyclic.lua');
    assert.equal(issue?.path, 'document');
    assert.deepEqual(issue?.span, document.rootAst.span);
});

test('preserves source spans in an isolated, deeply frozen successful snapshot', () => {
    const source = `return {\n  schemaVersion = 1,\n  domain = "hull",\n  definition = { id = "${UUIDS.hullA}", parts = {}, sprites = {}, weaponHardpoints = {}, activeModuleMounts = {}, thrusterVents = {}, utilitySockets = {}, hullModCapacity = 0 }\n}`;
    const document = local(source, 'hulls/span.lua');
    const before = document.rootAst.span;
    const beforeDefinition = document.rootAst.entries.find((entry) => entry.kind === 'field' && entry.key === 'definition');
    assert.ok(beforeDefinition?.kind === 'field' && beforeDefinition.value.kind === 'table');
    const beforeId = beforeDefinition?.kind === 'field' && beforeDefinition.value.kind === 'table'
        ? beforeDefinition.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'id')
        : undefined;
    assert.ok(beforeId?.kind === 'field' && beforeId.value.kind === 'string');
    const result = validateDefinitionCollection([document], EMPTY_CONTENT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const snapshot = result.collection.documents[0];
    assert.ok(snapshot);
    assert.notEqual(snapshot?.rootAst, document.rootAst);
    assert.deepEqual(snapshot?.rootAst.span, before);
    assert.notEqual(snapshot?.rootAst.span, document.rootAst.span);
    const snapshotDefinition = snapshot?.rootAst.entries.find((entry) => entry.kind === 'field' && entry.key === 'definition');
    const snapshotId = snapshotDefinition?.kind === 'field' && snapshotDefinition.value.kind === 'table'
        ? snapshotDefinition.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'id')
        : undefined;
    if (beforeId?.kind === 'field' && beforeId.value.kind === 'string' && snapshotId?.kind === 'field' && snapshotId.value.kind === 'string') {
        assert.deepEqual(snapshotId.value.span, beforeId.value.span);
        assert.notEqual(snapshotId.value.span, beforeId.value.span);
    } else {
        assert.fail('Expected nested ID source spans on both ASTs.');
    }
    assert.equal(Object.isFrozen(snapshot?.rootAst), true);
    assert.equal(Object.isFrozen(snapshot?.rootAst.entries), true);
    assert.equal(Object.isFrozen(snapshot?.rootAst.span.start), true);
    document.rootAst.span.start.offset = 999;
    assert.notEqual(snapshot?.rootAst.span.start.offset, 999);
});

test('indexes candidates before resolving forward references', () => {
    const result = collection([
        { source: loadoutSource(UUIDS.loadout, 'mount.main'), name: 'loadouts/forward.lua' },
        { source: shipSource(), name: 'ships/forward.lua' },
        { source: hullSource(UUIDS.hullA, { weapon: 'mount.main' }), name: 'hulls/forward.lua' },
        { source: componentSource(), name: 'components/forward.lua' }
    ]);
    assert.equal(result.ok, true, result.ok ? '' : result.diagnostics.map((item) => `${item.code}:${item.path}`).join(', '));
});

test('requires strict domain-prefixed lowercase UUIDv4 IDs for new definitions', () => {
    const bad = collection([
        { source: hullSource('hull:11111111-1111-1111-8111-111111111111'), name: 'hull/bad-version.lua' },
        { source: componentSource('component.sample'), name: 'components/legacy-looking.lua' }
    ]);
    const issues = diagnostics(bad);
    assert.ok(issues.some((item) => item.code === 'invalid-definition-id' && item.path === 'definition.id'));
});

test('resolves exact grandfathered IDs from ExistingContentView without a static allowlist', () => {
    const existing = withWeaponPoint();
    const result = collection([
        { source: shipSource(UUIDS.shipA, 'new-player-variant', 'hull.existing', 'loadout.old'), name: 'ships/legacy-refs.lua' }
    ], existing);
    assert.equal(result.ok, true, result.ok ? '' : result.diagnostics.map((item) => `${item.code}:${item.path}`).join(', '));

    const unknownLegacy = collection([
        { source: shipSource(UUIDS.shipA, 'unknown-legacy', 'hull.missing', 'loadout.missing'), name: 'ships/unknown-legacy.lua' }
    ]);
    const issues = diagnostics(unknownLegacy);
    assert.ok(issues.some((item) => item.code === 'invalid-id' && item.path === 'definition.hullId'));
    assert.ok(issues.some((item) => item.code === 'invalid-id' && item.path === 'definition.loadoutId'));
});

test('detects duplicate IDs across component variants and within other namespaces with related locations', () => {
    const componentId = UUIDS.component;
    const result = collection([
        { source: componentSource(componentId, 'spinal'), name: 'z-components/weapon.lua' },
        { source: componentSource(componentId, 'utility', 'shield'), name: 'a-components/utility.lua' },
        { source: hullSource(UUIDS.hullA), name: 'z-hulls/a.lua' },
        { source: hullSource(UUIDS.hullA), name: 'a-hulls/a.lua' }
    ]);
    const issues = diagnostics(result);
    const componentDuplicate = issues.find((item) => item.code === 'duplicate-definition-id' && item.domain === 'component');
    const hullDuplicate = issues.find((item) => item.code === 'duplicate-definition-id' && item.domain === 'hull');
    assert.ok(componentDuplicate?.relatedLocations?.some((location) => location.sourceName === 'a-components/utility.lua'));
    assert.ok(hullDuplicate?.relatedLocations?.some((location) => location.sourceName === 'a-hulls/a.lua'));
});

test('detects conflicts with existing canonical and legacy definitions', () => {
    const existing: ExistingContentView = {
        ...EMPTY_CONTENT,
        componentDefinitions: [{ registryId: UUIDS.component, definition: existingSpinalComponent(UUIDS.component).definition }]
    };
    const result = collection([
        { source: componentSource(UUIDS.component), name: 'components/conflict.lua' }
    ], existing);
    const issue = diagnostics(result).find((item) => item.code === 'existing-definition-conflict');
    assert.ok(issue);
    assert.equal(issue?.relatedLocations?.[0]?.sourceName, '<ExistingContentView.componentDefinitions>');
});

test('detects blueprint ID, ShipManager source-key, and legacy compatibility-view source-key conflicts', () => {
    const existing: ExistingContentView = {
        ...EMPTY_CONTENT,
        blueprints: [{ id: UUIDS.shipA, sourceKey: 'occupied' }],
        legacyCompatibilityViewSourceKeys: ['legacy-view-key']
    };
    const result = collection([
        { source: shipSource(UUIDS.shipA, 'occupied'), name: 'ships/id-and-key.lua' },
        { source: shipSource(UUIDS.shipB, 'legacy-view-key'), name: 'ships/legacy-view.lua' }
    ], existing);
    const issues = diagnostics(result);
    assert.ok(issues.some((item) => item.code === 'existing-definition-conflict' && item.path === 'document.blueprintId'));
    assert.ok(issues.some((item) => item.code === 'existing-definition-conflict' && item.path === 'document.sourceKey'));
});

test('detects duplicate candidate blueprint IDs and source keys', () => {
    const result = collection([
        { source: shipSource(UUIDS.shipA, 'same-key'), name: 'ships/a.lua' },
        { source: shipSource(UUIDS.shipA, 'same-key'), name: 'ships/b.lua' }
    ]);
    const issues = diagnostics(result);
    assert.ok(issues.some((item) => item.code === 'duplicate-definition-id' && item.path === 'document.blueprintId'));
    assert.ok(issues.some((item) => item.code === 'duplicate-blueprint-source-key' && item.path === 'document.sourceKey'));
});

test('reports unresolved hull, loadout, and component references at their source fields', () => {
    const result = collection([
        { source: shipSource(UUIDS.shipA, 'missing-refs', UUIDS.hullA, UUIDS.loadout2), name: 'ships/missing.lua' },
        { source: loadoutSource(UUIDS.loadout, 'mount.missing', UUIDS.component), name: 'loadouts/missing.lua' }
    ]);
    const issues = diagnostics(result);
    assert.ok(issues.some((item) => item.code === 'unresolved-reference' && item.path === 'definition.hullId'));
    assert.ok(issues.some((item) => item.code === 'unresolved-reference' && item.path === 'definition.loadoutId'));
    assert.ok(issues.some((item) => item.code === 'unresolved-reference' && item.path === 'definition.installations[0].componentId'));
});

test('allows unreferenced loadouts after validating their component references', () => {
    const result = collection([
        { source: loadoutSource(UUIDS.loadout, 'unused.mount'), name: 'loadouts/unused.lua' },
        { source: componentSource(), name: 'components/unused.lua' }
    ]);
    assert.equal(result.ok, true, result.ok ? '' : result.diagnostics.map((item) => `${item.code}:${item.path}`).join(', '));
});

test('validates one shared loadout against every ship-selected hull with the installation source span', () => {
    const loadout = loadoutSource(UUIDS.loadout, 'mount.shared');
    const result = collection([
        { source: shipSource(UUIDS.shipA, 'ship-a', UUIDS.hullA), name: 'ships/a.lua' },
        { source: shipSource(UUIDS.shipB, 'ship-b', UUIDS.hullB), name: 'ships/b.lua' },
        { source: canonicalHullSource(UUIDS.hullA, { weapon: 'mount.shared' }), name: 'hulls/a.lua' },
        { source: canonicalHullSource(UUIDS.hullB, { utility: 'other.mount' }), name: 'hulls/b.lua' },
        { source: loadout, name: 'loadouts/shared.lua' },
        { source: componentSource(), name: 'components/shared.lua' }
    ]);
    const issue = diagnostics(result).find((item) => item.code === 'unresolved-reference' && item.path === 'definition.installations[0].mountId');
    assert.ok(issue);
    assert.match(issue?.message ?? '', /ship:44444444-4444-4444-8444-444444444444/);
    assert.match(issue?.message ?? '', /hull:22222222-2222-4222-8222-222222222222/);
    assert.deepEqual(issue?.span, pointIdSpan(loadout, 'mount.shared'));
});

test('resolves built-ins and reports built-in mount reservation at installation source', () => {
    const hull = canonicalHullSource(UUIDS.hullA, { weapon: 'mount.builtin', builtIn: UUIDS.component });
    const result = collection([
        { source: shipSource(), name: 'ships/builtin.lua' },
        { source: hull, name: 'hulls/builtin.lua' },
        { source: loadoutSource(UUIDS.loadout, 'mount.builtin'), name: 'loadouts/builtin.lua' },
        { source: componentSource(), name: 'components/builtin.lua' }
    ]);
    const issue = diagnostics(result).find((item) => item.code === 'reserved-mount');
    assert.ok(issue);
    assert.equal(issue?.path, 'definition.installations[0].mountId');
    assert.equal(issue?.sourceName, 'loadouts/builtin.lua');
});

test('reports unresolved built-in component references', () => {
    const result = collection([
        { source: canonicalHullSource(UUIDS.hullA, { weapon: 'mount.builtin', builtIn: UUIDS.component }), name: 'hulls/missing-built-in.lua' }
    ]);
    assert.ok(diagnostics(result).some((item) => item.code === 'unresolved-reference' && item.path.endsWith('builtInComponentId')));
});

test('enforces all four runtime component-to-mount compatibility cases', () => {
    const cases: Array<{
        component: string;
        hull: string;
        mountId: string;
        shouldPass: boolean;
        label: string;
    }> = [
        { component: componentSource(UUIDS.component, 'spinal'), hull: canonicalHullSource(UUIDS.hullA, { weapon: 'mount.test' }), mountId: 'mount.test', shouldPass: true, label: 'weapon hardpoint' },
        { component: componentSource(UUIDS.component, 'propulsion', 'engine'), hull: canonicalHullSource(UUIDS.hullA, { vent: 'mount.test' }), mountId: 'mount.test', shouldPass: true, label: 'thruster vent' },
        { component: componentSource(UUIDS.component, 'utility', 'shield'), hull: canonicalHullSource(UUIDS.hullA, { utility: 'mount.test' }), mountId: 'mount.test', shouldPass: true, label: 'utility socket' },
        { component: componentSource(UUIDS.component, 'active-module', 'repair'), hull: canonicalHullSource(UUIDS.hullA, { active: 'mount.test' }), mountId: 'mount.test', shouldPass: true, label: 'active-module mount' },
        { component: componentSource(UUIDS.component, 'propulsion', 'wrong-category'), hull: canonicalHullSource(UUIDS.hullA, { vent: 'mount.test' }), mountId: 'mount.test', shouldPass: false, label: 'wrong propulsion category' },
        { component: componentSource(UUIDS.component, 'utility', 'wrong-category'), hull: canonicalHullSource(UUIDS.hullA, { utility: 'mount.test' }), mountId: 'mount.test', shouldPass: false, label: 'wrong utility category' },
        { component: componentSource(UUIDS.component, 'active-module', 'wrong-category'), hull: canonicalHullSource(UUIDS.hullA, { active: 'mount.test' }), mountId: 'mount.test', shouldPass: false, label: 'wrong active-module category' },
        { component: componentSource(UUIDS.component, 'spinal', 'engine', 'turret'), hull: canonicalHullSource(UUIDS.hullA, { weapon: 'mount.test' }), mountId: 'mount.test', shouldPass: true, label: 'turret accepted by generic hardpoint' }
    ];
    for (const item of cases) {
        const result = collection([
            { source: shipSource(), name: `${item.label}/ship.lua` },
            { source: item.hull, name: `${item.label}/hull.lua` },
            { source: loadoutSource(UUIDS.loadout, item.mountId), name: `${item.label}/loadout.lua` },
            { source: item.component, name: `${item.label}/component.lua` }
        ]);
        assert.equal(result.ok, item.shouldPass, `${item.label}: ${result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`);
        if (!item.shouldPass) assert.ok(diagnostics(result).some((diagnostic) => diagnostic.code === 'incompatible-mount'));
    }
});

test('detects duplicate candidate references as ambiguous and never selects one', () => {
    const result = collection([
        { source: componentSource(), name: 'components/a.lua' },
        { source: componentSource(), name: 'components/b.lua' },
        { source: loadoutSource(UUIDS.loadout, 'mount.x'), name: 'loadouts/ref.lua' }
    ]);
    const issues = diagnostics(result);
    assert.ok(issues.some((item) => item.code === 'duplicate-definition-id'));
    const ambiguous = issues.find((item) => item.code === 'ambiguous-reference' && item.path.endsWith('.componentId'));
    assert.ok(ambiguous?.relatedLocations && ambiguous.relatedLocations.length >= 2);
});

test('orders diagnostics by ordinal source name independent of input order', () => {
    const first = local(hullSource('not-a-hull-uuid'), 'z-file.lua');
    const second = local(componentSource('not-a-component-uuid'), 'A-file.lua');
    const result = validateDefinitionCollection([first, second], EMPTY_CONTENT);
    const issues = diagnostics(result);
    assert.deepEqual(issues.map((item) => item.sourceName), ['A-file.lua', 'z-file.lua']);
});

test('never returns a successful collection alongside any validation diagnostic', () => {
    const result = collection([
        { source: hullSource('bad-id'), name: 'hulls/bad.lua' },
        { source: componentSource(), name: 'components/good.lua' }
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.diagnostics.length > 0);
});

test('rejects duplicate installations during complete AST revalidation', () => {
    const source = `return { schemaVersion = 1, domain = "loadout", definition = { id = "${UUIDS.loadout}", installations = {
      { mountId = "mount.first", componentId = "${UUIDS.component}" },
      { mountId = "mount.second", componentId = "${UUIDS.component}" }
    } } }`;
    const document = local(source, 'loadouts/duplicate.lua');
    const definition = document.rootAst.entries.find((entry) => entry.kind === 'field' && entry.key === 'definition');
    assert.ok(definition?.kind === 'field' && definition.value.kind === 'table');
    if (definition?.kind === 'field' && definition.value.kind === 'table') {
        const installations = definition.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'installations');
        assert.ok(installations?.kind === 'field' && installations.value.kind === 'table');
        if (installations?.kind === 'field' && installations.value.kind === 'table') {
            const first = installations.value.entries[0];
            const second = installations.value.entries[1];
            assert.ok(first?.kind === 'array' && first.value.kind === 'table');
            assert.ok(second?.kind === 'array' && second.value.kind === 'table');
            if (first?.kind === 'array' && first.value.kind === 'table' && second?.kind === 'array' && second.value.kind === 'table') {
                const firstMount = first.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'mountId');
                const secondMount = second.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'mountId');
                assert.ok(firstMount?.kind === 'field' && firstMount.value.kind === 'string');
                assert.ok(secondMount?.kind === 'field' && secondMount.value.kind === 'string');
                if (firstMount?.kind === 'field' && firstMount.value.kind === 'string' && secondMount?.kind === 'field' && secondMount.value.kind === 'string') {
                    secondMount.value.value = firstMount.value.value;
                }
            }
        }
    }
    const result = validateDefinitionCollection([document], EMPTY_CONTENT);
    assert.ok(diagnostics(result).some((item) => item.code === 'duplicate-local-id' && item.path.endsWith('.mountId')));
});

test('rejects a legacy component in a canonical loadout', () => {
    const legacy: ComponentDefinition = {
        id: 'LegacyWeapon', kind: 'legacy', category: 'Weapon', subType: 'Cannon', value: 1,
        cooldown: 1, energyCost: 0, description: ''
    };
    const existing: ExistingContentView = {
        ...EMPTY_CONTENT,
        componentDefinitions: [{ registryId: 'LegacyWeapon', definition: legacy }]
    };
    const result = collection([
        { source: loadoutSource(UUIDS.loadout, 'mount.old', 'LegacyWeapon'), name: 'loadouts/legacy-component.lua' }
    ], existing);
    assert.ok(diagnostics(result).some((item) => item.code === 'incompatible-mount' && item.path.endsWith('.componentId')));
});

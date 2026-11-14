import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeAssetContract } from '../src/generated/runtimeAssetContract';
import { parseLuaData } from '../src/shipmaker/luaDataParser.mjs';
import { validateDefinitionDocument } from '../src/shipmaker/definitionValidation';
import type { DefinitionDiagnostic, DefinitionValidationResult } from '../src/shipmaker/definitionSchema';

const runtimeAssets = runtimeAssetContract.assets as readonly { assetId: string; contentType: string }[];
const svgAssetId = runtimeAssets.find((asset) => asset.contentType === 'SVG')!.assetId;
const nonSvgAssetId = runtimeAssets.find((asset) => asset.contentType !== 'SVG')!.assetId;

function validate(source: string, sourceName = 'fixture.lua'): DefinitionValidationResult {
    const parsed = parseLuaData(source, { sourceName });
    if (!parsed.ok) throw new Error('Expected a syntactically valid Lua fixture.');
    return validateDefinitionDocument(sourceName, parsed.ast);
}

function expectSuccess(source: string, sourceName?: string) {
    const result = validate(source, sourceName);
    if (!result.ok) throw new Error('Expected local schema validation success.');
    return result.document;
}

function expectDiagnostic(source: string, predicate: (diagnostic: DefinitionDiagnostic) => boolean): DefinitionDiagnostic {
    const result = validate(source, 'diagnostics.lua');
    assert.equal(result.ok, false, 'Expected local schema validation failure.');
    if (result.ok) throw new Error('Expected local schema validation failure.');
    const diagnostic = result.diagnostics.find(predicate);
    assert.ok(diagnostic, `No matching diagnostic. Found: ${result.diagnostics.map((entry) => `${entry.code} ${entry.path}`).join(', ')}`);
    return diagnostic;
}

function validHull(): string {
    return `return {
  schemaVersion = 1,
  domain = "hull",
  definition = {
    id = "hull.sample",
    parts = {{ id = "part.core", name = "core", position = { x = -1, y = 2 }, rotationDeg = -90, isLoot = false, maxHull = 0 }},
    sprites = {{ id = "body", assetId = "${svgAssetId}", position = { x = 0, y = 0 }, scale = { x = -1, y = 0 }, order = 0 }},
    weaponHardpoints = {{ id = "point.weapon", position = { x = 4, y = 0 }, rotationDeg = 0, accepts = { "spinal" }, maxDimensions = { x = 100, y = 50 }, restrictions = { ["__proto__"] = { tags = { "safe", "static" }, empty = {} } } }},
    activeModuleMounts = {{ id = "point.module", position = { x = 0, y = 0 }, rotationDeg = 0, acceptedCategories = {}, restrictions = {} }},
    thrusterVents = {{ id = "point.vent", position = { x = -2, y = -3 }, rotationDeg = 0, width = 10, height = 4, exhaustDirectionDeg = 180, acceptsPropulsionCategories = { "engine" }, restrictions = {} }},
    utilitySockets = {{ id = "point.utility", position = { x = 0, y = 1 }, rotationDeg = 0, acceptedCategories = { "shield" }, restrictions = {} }},
    hullModCapacity = 0
  }
}`;
}

function validShip(): string {
    return `return {
  schemaVersion = 1,
  domain = "ship",
  blueprintId = "ship.sample",
  sourceKey = "sample",
  definition = {
    hullId = "hull.sample",
    loadoutId = "loadout.sample",
    superType = "Ship",
    subType = "Fighter",
    name = "Sample",
    categoryType = "Air",
    stats = { maxHull = 0, maxShell = 0, regenShell = 0, maxEnergy = 0, maxSpeed = 0, acceleration = 0, weight = 0, radius = 0, value = 0 }
  }
}`;
}

const componentPrefix = `return { schemaVersion = 1, domain = "component", definition = `;
const componentSuffix = ' }';

function validComponent(definition: string): string {
    return `${componentPrefix}${definition}${componentSuffix}`;
}

test('validates a full hull locally, including finite geometry, manifest sprites, and open restrictions', () => {
    const document = expectSuccess(validHull(), 'hulls/sample.lua');
    assert.equal(document.domain, 'hull');
    assert.equal(document.sourceName, 'hulls/sample.lua');
    assert.equal(document.definition.kind, 'table');
    if (document.definition.kind === 'table') {
        const restriction = document.definition.entries.find((entry) => entry.kind === 'field' && entry.key === 'weaponHardpoints');
        assert.ok(restriction?.kind === 'field');
        assert.equal(restriction.value.kind, 'table');
    }
});

test('accepts the four version-one document domains and preserves ship catalogue metadata', () => {
    assert.equal(expectSuccess(validHull()).domain, 'hull');
    const ship = expectSuccess(validShip());
    assert.equal(ship.domain, 'ship');
    if (ship.domain === 'ship') {
        assert.equal(ship.blueprintId, 'ship.sample');
        assert.equal(ship.sourceKey, 'sample');
    }
    assert.equal(expectSuccess(validComponent('{ id = "component.sample", kind = "utility", category = "shield", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, sprites = {} }')).domain, 'component');
    assert.equal(expectSuccess('return { schemaVersion = 1, domain = "loadout", definition = { id = "loadout.empty", installations = {} } }').domain, 'loadout');
});

test('validates all five canonical component variants without converting their ASTs', () => {
    const definitions = [
        '{ id = "weapon.spinal", kind = "weapon", configuration = "spinal", operation = { firingMode = "ProjectileArcade", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }',
        '{ id = "weapon.turret", kind = "weapon", configuration = "turret", operation = { firingMode = "Beam", damage = 1, range = 2, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {}, rotating = {{ id = "turn", assetId = "' + svgAssetId + '", position = { x = 0, y = 0 }, rotationFrame = "turret", order = 0 }} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = -350, max = -340 }, rotationSpeedDegPerSecond = 0, barrels = {} } }',
        '{ id = "module.engine", kind = "propulsion", category = "engine", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, propulsion = { output = 0 }, sprites = {} }',
        '{ id = "module.shield", kind = "utility", category = "shield", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, sprites = {} }',
        '{ id = "module.restore", kind = "active-module", category = "repair", operation = { cooldown = 0, energyCost = 0, chargeTime = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, payload = { kind = "resource_restore", shell = 0, hull = 0, energy = 0 }, targeting = { kind = "area", allowed = {}, radius = 0, includeSelf = false }, sprites = {} }'
    ];

    for (const definition of definitions) {
        const validated = expectSuccess(validComponent(definition));
        assert.equal(validated.domain, 'component');
        assert.equal(validated.definition.kind, 'table');
    }
});

test('accepts supported firing modes and rejects unsupported modes', () => {
    for (const mode of ['Beam', 'Cannon', 'Projectile', 'ProjectileArcade']) {
        const source = validComponent(`{ id = "weapon.${mode}", kind = "weapon", configuration = "spinal", operation = { firingMode = "${mode}", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }`);
        expectSuccess(source);
    }
    expectDiagnostic(validComponent('{ id = "weapon.bad", kind = "weapon", configuration = "spinal", operation = { firingMode = "Rocket", damage = 1, range = 1, cooldown = 1, energyCost = 1, projectileSpeed = 1, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }'), (diagnostic) => diagnostic.code === 'invalid-enum' && diagnostic.path === 'definition.operation.firingMode');
});

test('reports a missing weapon configuration at its precise schema path', () => {
    const diagnostic = expectDiagnostic(validComponent('{ id = "weapon.no-config", kind = "weapon", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }'), (entry) => entry.code === 'missing-field' && entry.path === 'definition.configuration');
    assert.equal(diagnostic.span.start.line, 1);
});

test('enforces numeric minima, full dimensions, hardpoint Point2, and unwrapped turret limits', () => {
    expectDiagnostic(validShip().replace('maxEnergy = 0', 'maxEnergy = -1'), (diagnostic) => diagnostic.code === 'invalid-number' && diagnostic.path === 'definition.stats.maxEnergy');
    expectDiagnostic(validHull().replace('maxHull = 0', 'maxHull = -1'), (diagnostic) => diagnostic.code === 'invalid-number' && diagnostic.path === 'definition.parts[0].maxHull');
    expectDiagnostic(validHull().replace('hullModCapacity = 0', 'hullModCapacity = 0.5'), (diagnostic) => diagnostic.code === 'invalid-number' && diagnostic.path === 'definition.hullModCapacity');
    expectDiagnostic(validHull().replace('maxDimensions = { x = 100, y = 50 }', 'maxDimensions = { x = 100 }'), (diagnostic) => diagnostic.code === 'missing-field' && diagnostic.path === 'definition.weaponHardpoints[0].maxDimensions.y');
    expectDiagnostic(validHull().replace('width = 10, height = 4', 'width = 0, height = 4'), (diagnostic) => diagnostic.code === 'invalid-dimension' && diagnostic.path === 'definition.thrusterVents[0].width');
    expectDiagnostic(validComponent('{ id = "module.engine", kind = "propulsion", category = "engine", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, propulsion = { output = -1 }, sprites = {} }'), (diagnostic) => diagnostic.code === 'invalid-number' && diagnostic.path === 'definition.propulsion.output');
    expectDiagnostic(validComponent('{ id = "weapon.dim", kind = "weapon", configuration = "spinal", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, dimensions = { length = 10, width = 0, height = 0 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }'), (diagnostic) => diagnostic.code === 'invalid-dimension' && diagnostic.path === 'definition.dimensions.width');
    expectDiagnostic(validComponent('{ id = "weapon.dim", kind = "weapon", configuration = "spinal", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, dimensions = { length = 10, width = 5 }, visuals = { fixed = {} }, geometry = { muzzles = {} } }'), (diagnostic) => diagnostic.code === 'missing-field' && diagnostic.path === 'definition.dimensions.height');
    expectDiagnostic(validComponent('{ id = "weapon.turret", kind = "weapon", configuration = "turret", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {}, rotating = {} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = 0, max = 361 }, rotationSpeedDegPerSecond = 0, barrels = {} } }'), (diagnostic) => diagnostic.code === 'invalid-angle' && diagnostic.message.includes('360'));
    expectDiagnostic(validComponent('{ id = "weapon.turret", kind = "weapon", configuration = "turret", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {}, rotating = {} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = 1, max = 0 }, rotationSpeedDegPerSecond = 0, barrels = {} } }'), (diagnostic) => diagnostic.code === 'invalid-angle' && diagnostic.message.includes('ordered'));
});

test('requires source-located envelope, domain, schema, and exact contract fields', () => {
    const wrongVersion = expectDiagnostic('return { schemaVersion = 2, domain = "loadout", definition = { id = "l", installations = {} } }', (diagnostic) => diagnostic.code === 'invalid-schema-version');
    assert.equal(wrongVersion.sourceName, 'diagnostics.lua');
    assert.ok(wrongVersion.span.start.line === 1 && wrongVersion.span.start.column > 1);
    expectDiagnostic('return { schemaVersion = 1, domain = "faction", definition = {} }', (diagnostic) => diagnostic.code === 'invalid-domain');
    expectDiagnostic('return { schemaVersion = 1, domain = "loadout", surprise = true, definition = { id = "l", installations = {} } }', (diagnostic) => diagnostic.code === 'unknown-field' && diagnostic.path === 'document.surprise');
    expectDiagnostic('return { schemaVersion = 1, domain = "loadout", definition = { id = "l", installations = {}, unexpected = 1 } }', (diagnostic) => diagnostic.code === 'unknown-field' && diagnostic.path === 'definition.unexpected');
    expectDiagnostic('return { schemaVersion = 1, domain = "ship", definition = {} }', (diagnostic) => diagnostic.code === 'missing-field' && diagnostic.path === 'document.blueprintId');
    expectDiagnostic(validComponent('{ id = "legacy", kind = "legacy" }'), (diagnostic) => diagnostic.code === 'invalid-enum' && diagnostic.path === 'definition.kind');
    expectDiagnostic(validComponent('{ id = "component.extra", kind = "utility", category = "shield", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, sprites = {}, surprise = true }'), (diagnostic) => diagnostic.code === 'unknown-field' && diagnostic.path === 'definition.surprise');
    expectDiagnostic(validComponent('{ id = "module.target", kind = "active-module", category = "repair", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, payload = { kind = "resource_restore", shell = 0, hull = 0, energy = 0 }, targeting = { kind = "single", allowed = {}, surprise = true }, sprites = {} }'), (diagnostic) => diagnostic.code === 'unknown-field' && diagnostic.path === 'definition.targeting.surprise');
});

test('validates local IDs, unified hull point IDs, layer IDs, and reserved legacy layer prefixes', () => {
    const duplicatePoints = validHull().replace(
        'activeModuleMounts = {{ id = "point.module"',
        'activeModuleMounts = {{ id = "point.weapon"'
    );
    expectDiagnostic(duplicatePoints, (diagnostic) => diagnostic.code === 'duplicate-local-id' && diagnostic.path.includes('activeModuleMounts'));

    const duplicateLayers = validHull().replace(
        'sprites = {{ id = "body"',
        'sprites = {{ id = "legacy:body"'
    );
    expectDiagnostic(duplicateLayers, (diagnostic) => diagnostic.code === 'invalid-id' && diagnostic.message.includes('legacy:'));

    const repeatedComponentLayers = validComponent('{ id = "weapon.turret", kind = "weapon", configuration = "turret", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {{ id = "same", assetId = "' + svgAssetId + '", position = { x = 0, y = 0 }, order = 0 }}, rotating = {{ id = "same", assetId = "' + svgAssetId + '", position = { x = 0, y = 0 }, rotationFrame = "turret", order = 1 }} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = -180, max = 180 }, rotationSpeedDegPerSecond = 1, barrels = {} } }');
    expectDiagnostic(repeatedComponentLayers, (diagnostic) => diagnostic.code === 'duplicate-local-id' && diagnostic.path.includes('rotating'));
});

test('keeps original source-table indexes when invalid keyed entries precede positional items', () => {
    const source = validHull().replace(
        'parts = {{ id = "part.core", name = "core", position = { x = -1, y = 2 }, rotationDeg = -90, isLoot = false, maxHull = 0 }}',
        'parts = { unexpected = true, { id = 7, name = "core", position = { x = -1, y = 2 }, rotationDeg = -90, isLoot = false, maxHull = 0 } }'
    );
    const result = validate(source);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === 'definition.parts[0]'));
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === 'definition.parts[1].id'));
    }
});

test('validates runtime-contract SVG asset IDs and the turret rotating-layer frame', () => {
    expectSuccess(validHull());
    const unknownSource = validHull().replace(svgAssetId, 'asset:00000000-0000-4000-8000-000000000000');
    const unknown = expectDiagnostic(unknownSource, (diagnostic) => diagnostic.code === 'invalid-asset-id' && diagnostic.path === 'definition.sprites[0].assetId');
    assert.equal(unknown.sourceName, 'diagnostics.lua');
    assert.equal(unknown.span.start.line, 7);
    assert.equal(unknownSource.slice(unknown.span.start.offset, unknown.span.end.offset), '"asset:00000000-0000-4000-8000-000000000000"');

    const nonSvgSource = validHull().replace(svgAssetId, nonSvgAssetId);
    const nonSvg = expectDiagnostic(nonSvgSource, (diagnostic) => diagnostic.code === 'invalid-asset-type' && diagnostic.path === 'definition.sprites[0].assetId');
    assert.equal(nonSvg.sourceName, 'diagnostics.lua');
    assert.equal(nonSvg.span.start.line, 7);
    assert.equal(nonSvgSource.slice(nonSvg.span.start.offset, nonSvg.span.end.offset), `"${nonSvgAssetId}"`);

    const missingFrame = validComponent('{ id = "weapon.turret", kind = "weapon", configuration = "turret", operation = { firingMode = "Cannon", damage = 0, range = 0, cooldown = 0, energyCost = 0, projectileSpeed = 0, splashRadius = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, visuals = { fixed = {}, rotating = {{ id = "turn", assetId = "' + svgAssetId + '", position = { x = 0, y = 0 }, order = 0 }} }, geometry = { pivot = { x = 0, y = 0 }, rotationLimitsDeg = { min = 0, max = 360 }, rotationSpeedDegPerSecond = 0, barrels = {} } }');
    expectDiagnostic(missingFrame, (diagnostic) => diagnostic.code === 'invalid-sprite-layer' && diagnostic.path.endsWith('.rotationFrame'));
});

test('allows empty accepted and targeting arrays and finite negative sprite scales', () => {
    expectSuccess(validHull().replace('accepts = { "spinal" }', 'accepts = {}'));
    const activeModule = validComponent('{ id = "module.restore", kind = "active-module", category = "repair", operation = { cooldown = 0, energyCost = 0 }, attachment = { position = { x = 0, y = 0 }, attachmentRotationDeg = 0 }, payload = { kind = "resource_restore", shell = 0, hull = 0, energy = 0 }, targeting = { kind = "single", allowed = {} }, sprites = {} }');
    expectSuccess(activeModule);
    expectSuccess(validHull());
});

test('permits empty part and blueprint display/classification strings by contract', () => {
    const hull = validHull().replace('name = "core"', 'name = ""');
    expectSuccess(hull);
    const ship = validShip()
        .replace('superType = "Ship"', 'superType = ""')
        .replace('subType = "Fighter"', 'subType = ""')
        .replace('name = "Sample"', 'name = ""')
        .replace('categoryType = "Air"', 'categoryType = ""');
    expectSuccess(ship);
});

test('validates generic restriction table shape without converting or assigning dynamic keys', () => {
    const mixed = validHull().replace('restrictions = { ["__proto__"] = { tags = { "safe", "static" }, empty = {} } }', 'restrictions = { safe = true, "array entry" }');
    expectDiagnostic(mixed, (diagnostic) => diagnostic.code === 'invalid-restrictions-shape');

    const protoKey = expectSuccess(validHull());
    assert.equal(protoKey.domain, 'hull');
    if (protoKey.definition.kind === 'table') {
        const points = protoKey.definition.entries.find((entry) => entry.kind === 'field' && entry.key === 'weaponHardpoints');
        assert.ok(points?.kind === 'field' && points.value.kind === 'table');
        if (points?.kind === 'field' && points.value.kind === 'table') {
            const point = points.value.entries[0];
            assert.ok(point?.kind === 'array' && point.value.kind === 'table');
            if (point?.kind === 'array' && point.value.kind === 'table') {
                const restrictions = point.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'restrictions');
                assert.ok(restrictions?.kind === 'field' && restrictions.value.kind === 'table');
                if (restrictions?.kind === 'field' && restrictions.value.kind === 'table') {
                    assert.equal(restrictions.value.entries.some((entry) => entry.kind === 'field' && entry.key === '__proto__'), true);
                }
            }
        }
    }
});

test('does not interpret non-finite values even when supplied by a constructed AST', () => {
    const parsed = parseLuaData(validHull());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('Expected parser success.');
    const definition = parsed.ast.entries.find((entry) => entry.kind === 'field' && entry.key === 'definition');
    assert.ok(definition?.kind === 'field' && definition.value.kind === 'table');
    if (!definition || definition.kind !== 'field' || definition.value.kind !== 'table') return;
    const capacity = definition.value.entries.find((entry) => entry.kind === 'field' && entry.key === 'hullModCapacity');
    assert.ok(capacity?.kind === 'field' && capacity.value.kind === 'number');
    if (!capacity || capacity.kind !== 'field' || capacity.value.kind !== 'number') return;
    capacity.value.value = Number.POSITIVE_INFINITY;
    const result = validateDefinitionDocument('constructed.lua', parsed.ast);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-number' && diagnostic.path === 'definition.hullModCapacity'));
});

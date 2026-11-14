import { runtimeAssetContract } from '../generated/runtimeAssetContract';
import type {
    LuaDataNode,
    LuaFieldEntry,
    LuaTableNode,
    SourceSpan
} from './luaDataParser.mjs';
import {
    DEFINITION_DOMAINS,
    DEFINITION_SCHEMA_VERSION,
    type DefinitionDiagnostic,
    type DefinitionDiagnosticCode,
    type DefinitionDomain,
    type DefinitionValidationResult,
    type LocallyValidatedDefinitionDocument
} from './definitionSchema';

type TableFields = Map<string, LuaFieldEntry>;
type IndexedArrayItem = { value: LuaDataNode; tableEntryIndex: number };
type LocalContext = {
    sourceName: string;
    domain?: DefinitionDomain;
    diagnostics: DefinitionDiagnostic[];
};
type LayerFrameRule = 'hull' | 'component' | 'turret-fixed' | 'turret-rotating';

const RUNTIME_ASSETS = runtimeAssetContract.assets as readonly { assetId: string; contentType: string }[];
const RUNTIME_ASSETS_BY_ID = new Map(RUNTIME_ASSETS.map((asset) => [asset.assetId, asset]));

const SHIP_STATS = [
    'maxHull', 'maxShell', 'regenShell', 'maxEnergy', 'regenEnergy',
    'maxSpeed', 'acceleration', 'weight', 'radius', 'value'
] as const;

function issue(
    context: LocalContext,
    code: DefinitionDiagnosticCode,
    path: string,
    span: SourceSpan,
    message: string
): void {
    context.diagnostics.push({ code, message, sourceName: context.sourceName, domain: context.domain, path, span });
}

function emptySpan(): SourceSpan {
    const position = { offset: 0, line: 1, column: 1 };
    return { start: position, end: position };
}

function isTable(node: LuaDataNode | undefined): node is LuaTableNode {
    return node?.kind === 'table';
}

function getField(table: LuaTableNode, key: string): LuaFieldEntry | undefined {
    return table.entries.find((entry): entry is LuaFieldEntry => entry.kind === 'field' && entry.key === key);
}

function collectFields(context: LocalContext, node: LuaDataNode | undefined, path: string): TableFields | undefined {
    if (node === undefined) return undefined;
    if (!isTable(node)) {
        issue(context, 'wrong-type', path, node.span, 'Expected an object-shaped table.');
        return undefined;
    }

    const result: TableFields = new Map();
    for (const entry of node.entries) {
        if (entry.kind !== 'field') {
            issue(context, 'wrong-type', path, entry.span, 'Expected keyed fields, not positional array entries.');
            continue;
        }
        if (result.has(entry.key)) {
            issue(context, 'duplicate-field', `${path}.${entry.key}`, entry.keySpan, `Field "${entry.key}" is repeated.`);
            continue;
        }
        result.set(entry.key, entry);
    }
    return result;
}

function readFields(
    context: LocalContext,
    node: LuaDataNode | undefined,
    path: string,
    allowed: readonly string[],
    required: readonly string[] = allowed
): TableFields | undefined {
    const result = collectFields(context, node, path);
    if (!result) return undefined;
    const allowedSet = new Set(allowed);
    for (const [key, entry] of result) {
        if (!allowedSet.has(key)) {
            issue(context, 'unknown-field', `${path}.${key}`, entry.keySpan, `Unknown field "${key}".`);
        }
    }

    for (const key of required) {
        if (!result.has(key)) {
            issue(context, 'missing-field', `${path}.${key}`, node!.span, `Required field "${key}" is missing.`);
        }
    }
    return result;
}

function readArray(
    context: LocalContext,
    node: LuaDataNode | undefined,
    path: string
): IndexedArrayItem[] | undefined {
    if (node === undefined) return undefined;
    if (!isTable(node)) {
        issue(context, 'wrong-type', path, node?.span ?? emptySpan(), 'Expected an array-shaped table.');
        return undefined;
    }
    const items: IndexedArrayItem[] = [];
    node.entries.forEach((entry, index) => {
        if (entry.kind !== 'array') {
            issue(context, 'wrong-type', `${path}[${index}]`, entry.span, 'Expected a positional array entry.');
        } else {
            items.push({ value: entry.value, tableEntryIndex: index });
        }
    });
    return items;
}

function stringValue(
    context: LocalContext,
    entry: LuaFieldEntry | undefined,
    path: string,
    options: { nonEmpty?: boolean; id?: boolean } = {}
): string | undefined {
    if (!entry) return undefined;
    if (entry.value.kind !== 'string') {
        issue(context, 'wrong-type', path, entry.value.span, 'Expected a string.');
        return undefined;
    }
    if (options.nonEmpty && entry.value.value.trim().length === 0) {
        issue(context, options.id ? 'invalid-id' : 'wrong-type', path, entry.value.span, 'Value must not be empty or whitespace.');
        return undefined;
    }
    return entry.value.value;
}

function booleanValue(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    if (entry && entry.value.kind !== 'boolean') {
        issue(context, 'wrong-type', path, entry.value.span, 'Expected a boolean.');
    }
}

function numberValue(
    context: LocalContext,
    entry: LuaFieldEntry | undefined,
    path: string,
    rule: { minimum?: number; exclusiveMinimum?: number; integer?: boolean; code?: DefinitionDiagnosticCode } = {}
): number | undefined {
    if (!entry) return undefined;
    const node = entry.value;
    if (node.kind !== 'number') {
        issue(context, 'wrong-type', path, node.span, 'Expected a number.');
        return undefined;
    }
    if (!Number.isFinite(node.value)) {
        issue(context, 'invalid-number', path, node.span, 'Number must be finite.');
        return undefined;
    }
    if (rule.minimum !== undefined && node.value < rule.minimum) {
        issue(context, rule.code ?? 'invalid-number', path, node.span, `Number must be at least ${rule.minimum}.`);
    }
    if (rule.exclusiveMinimum !== undefined && node.value <= rule.exclusiveMinimum) {
        issue(context, rule.code ?? 'invalid-number', path, node.span, `Number must be greater than ${rule.exclusiveMinimum}.`);
    }
    if (rule.integer && !Number.isInteger(node.value)) {
        issue(context, rule.code ?? 'invalid-number', path, node.span, 'Number must be an integer.');
    }
    return node.value;
}

function validateStringArray(
    context: LocalContext,
    node: LuaDataNode | undefined,
    path: string,
    allowedValues?: readonly string[]
): void {
    const items = readArray(context, node, path);
    if (!items) return;
    const allowed = allowedValues ? new Set(allowedValues) : undefined;
    items.forEach(({ value: item, tableEntryIndex: index }) => {
        if (item.kind !== 'string') {
            issue(context, 'wrong-type', `${path}[${index}]`, item.span, 'Expected a string array entry.');
            return;
        }
        if (item.value.trim().length === 0) {
            issue(context, 'wrong-type', `${path}[${index}]`, item.span, 'String array entries must not be empty or whitespace.');
        }
        if (allowed && !allowed.has(item.value)) {
            issue(context, 'invalid-enum', `${path}[${index}]`, item.span, `Unsupported value "${item.value}".`);
        }
    });
}

function validatePoint(context: LocalContext, node: LuaDataNode | undefined, path: string): void {
    const fields = readFields(context, node, path, ['x', 'y']);
    if (!fields) return;
    numberValue(context, fields.get('x'), `${path}.x`);
    numberValue(context, fields.get('y'), `${path}.y`);
}

function validateDimensions(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    if (!entry) return;
    const fields = readFields(context, entry.value, path, ['length', 'width', 'height']);
    if (!fields) return;
    numberValue(context, fields.get('length'), `${path}.length`, { exclusiveMinimum: 0, code: 'invalid-dimension' });
    numberValue(context, fields.get('width'), `${path}.width`, { exclusiveMinimum: 0, code: 'invalid-dimension' });
    numberValue(context, fields.get('height'), `${path}.height`, { minimum: 0, code: 'invalid-dimension' });
}

function validateRestrictions(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    if (!entry) return;
    if (!isTable(entry.value)) {
        issue(context, 'wrong-type', path, entry.value.span, 'Restrictions must be an object-shaped table.');
        return;
    }

    const visit = (table: LuaTableNode, tablePath: string, root = false): void => {
        const hasKeys = table.entries.some((candidate) => candidate.kind === 'field');
        const hasArrayEntries = table.entries.some((candidate) => candidate.kind === 'array');
        if (hasKeys && hasArrayEntries) {
            issue(context, 'invalid-restrictions-shape', tablePath, table.span, 'Mixed keyed and positional entries are not allowed in restrictions.');
        } else if (root && hasArrayEntries) {
            issue(context, 'invalid-restrictions-shape', tablePath, table.span, 'The restrictions value must be object-shaped.');
        }
        let arrayIndex = 0;
        for (const child of table.entries) {
            if (child.kind === 'field' && isTable(child.value)) visit(child.value, `${tablePath}.${child.key}`);
            else if (child.kind === 'array') {
                if (isTable(child.value)) visit(child.value, `${tablePath}[${arrayIndex}]`);
                arrayIndex++;
            }
        }
    };
    visit(entry.value, path, true);
}

function validateSpriteLayers(
    context: LocalContext,
    node: LuaDataNode | undefined,
    path: string,
    frameRule: LayerFrameRule,
    layerIds: Set<string>
): void {
    const layers = readArray(context, node, path);
    if (!layers) return;
    layers.forEach(({ value: layer, tableEntryIndex: index }) => {
        const layerPath = `${path}[${index}]`;
        const fields = readFields(
            context,
            layer,
            layerPath,
            ['id', 'assetId', 'textureOrigin', 'position', 'rotationDeg', 'scale', 'rotationFrame', 'order'],
            ['id', 'assetId', 'position', 'order']
        );
        if (!fields) return;

        const id = stringValue(context, fields.get('id'), `${layerPath}.id`, { nonEmpty: true, id: true });
        if (id !== undefined) {
            if (id.startsWith('legacy:')) {
                issue(context, 'invalid-id', `${layerPath}.id`, fields.get('id')!.value.span, 'Canonical sprite-layer IDs cannot use the reserved legacy: prefix.');
            }
            if (layerIds.has(id)) {
                issue(context, 'duplicate-local-id', `${layerPath}.id`, fields.get('id')!.value.span, `Sprite-layer ID "${id}" is repeated in this definition.`);
            }
            layerIds.add(id);
        }

        const assetId = stringValue(context, fields.get('assetId'), `${layerPath}.assetId`, { nonEmpty: true });
        if (assetId !== undefined) {
            const asset = RUNTIME_ASSETS_BY_ID.get(assetId);
            if (!asset) {
                issue(context, 'invalid-asset-id', `${layerPath}.assetId`, fields.get('assetId')!.value.span, `Asset ID "${assetId}" is not present in the runtime asset contract.`);
            } else if (asset.contentType !== 'SVG') {
                issue(context, 'invalid-asset-type', `${layerPath}.assetId`, fields.get('assetId')!.value.span, `Asset ID "${assetId}" has content type "${asset.contentType}"; sprite artwork must be SVG.`);
            }
        }

        validatePoint(context, fields.get('position')?.value, `${layerPath}.position`);
        if (fields.has('textureOrigin')) validatePoint(context, fields.get('textureOrigin')?.value, `${layerPath}.textureOrigin`);
        if (fields.has('scale')) validatePoint(context, fields.get('scale')?.value, `${layerPath}.scale`);

        numberValue(context, fields.get('rotationDeg'), `${layerPath}.rotationDeg`);
        numberValue(context, fields.get('order'), `${layerPath}.order`);

        const frameEntry = fields.get('rotationFrame');
        const frame = stringValue(context, frameEntry, `${layerPath}.rotationFrame`);
        if (frame !== undefined && frame !== 'component' && frame !== 'turret') {
            issue(context, 'invalid-enum', `${layerPath}.rotationFrame`, frameEntry!.value.span, 'rotationFrame must be "component" or "turret".');
        }

        if (frameRule === 'hull' && frameEntry && frame !== undefined) {
            issue(context, 'invalid-sprite-layer', `${layerPath}.rotationFrame`, frameEntry.value.span, 'Hull sprite layers must omit rotationFrame.');
        } else if (frameRule === 'component' && frame === 'turret') {
            issue(context, 'invalid-sprite-layer', `${layerPath}.rotationFrame`, frameEntry!.value.span, 'This component layer may only use the component rotation frame.');
        } else if (frameRule === 'turret-fixed' && frame === 'turret') {
            issue(context, 'invalid-sprite-layer', `${layerPath}.rotationFrame`, frameEntry!.value.span, 'Fixed turret layers may only use the component rotation frame.');
        } else if (frameRule === 'turret-rotating' && !frameEntry) {
            issue(context, 'invalid-sprite-layer', `${layerPath}.rotationFrame`, layer.span, 'Rotating turret layers must explicitly use rotationFrame = "turret".');
        } else if (frameRule === 'turret-rotating' && frame !== undefined && frame !== 'turret') {
            issue(context, 'invalid-sprite-layer', `${layerPath}.rotationFrame`, frameEntry!.value.span, 'Rotating turret layers must explicitly use rotationFrame = "turret".');
        }
    });
}

function validateHullPart(context: LocalContext, node: LuaDataNode, path: string, partIds: Set<string>): void {
    const fields = readFields(context, node, path, ['id', 'name', 'position', 'rotationDeg', 'isLoot', 'maxHull'], ['id', 'name', 'position', 'rotationDeg', 'isLoot']);
    if (!fields) return;
    uniqueId(context, fields.get('id'), `${path}.id`, partIds);
    stringValue(context, fields.get('name'), `${path}.name`);
    validatePoint(context, fields.get('position')?.value, `${path}.position`);
    numberValue(context, fields.get('rotationDeg'), `${path}.rotationDeg`);
    booleanValue(context, fields.get('isLoot'), `${path}.isLoot`);
    numberValue(context, fields.get('maxHull'), `${path}.maxHull`, { minimum: 0 });
}

function validateHullPoint(
    context: LocalContext,
    node: LuaDataNode,
    path: string,
    kind: 'weapon' | 'vent' | 'utility' | 'active-module',
    pointIds: Set<string>
): void {
    const fieldsByKind = {
        weapon: ['id', 'position', 'rotationDeg', 'accepts', 'maxDimensions', 'restrictions', 'builtInComponentId'],
        vent: ['id', 'position', 'rotationDeg', 'width', 'height', 'exhaustDirectionDeg', 'acceptsPropulsionCategories', 'restrictions', 'builtInComponentId'],
        utility: ['id', 'position', 'rotationDeg', 'acceptedCategories', 'restrictions', 'builtInComponentId'],
        'active-module': ['id', 'position', 'rotationDeg', 'acceptedCategories', 'restrictions', 'builtInComponentId']
    } as const;
    const requiredByKind = {
        weapon: ['id', 'position', 'rotationDeg', 'accepts', 'restrictions'],
        vent: ['id', 'position', 'rotationDeg', 'width', 'height', 'exhaustDirectionDeg', 'acceptsPropulsionCategories', 'restrictions'],
        utility: ['id', 'position', 'rotationDeg', 'acceptedCategories', 'restrictions'],
        'active-module': ['id', 'position', 'rotationDeg', 'acceptedCategories', 'restrictions']
    } as const;
    const fields = readFields(context, node, path, fieldsByKind[kind], requiredByKind[kind]);
    if (!fields) return;

    uniqueId(context, fields.get('id'), `${path}.id`, pointIds);
    validatePoint(context, fields.get('position')?.value, `${path}.position`);
    numberValue(context, fields.get('rotationDeg'), `${path}.rotationDeg`);
    if (kind === 'weapon') {
        validateStringArray(context, fields.get('accepts')?.value, `${path}.accepts`, ['spinal', 'turret']);
        const maximum = fields.get('maxDimensions');
        if (maximum) {
            const maxFields = readFields(context, maximum.value, `${path}.maxDimensions`, ['x', 'y']);
            if (maxFields) {
                numberValue(context, maxFields.get('x'), `${path}.maxDimensions.x`, { minimum: 0, code: 'invalid-dimension' });
                numberValue(context, maxFields.get('y'), `${path}.maxDimensions.y`, { minimum: 0, code: 'invalid-dimension' });
            }
        }
    } else if (kind === 'vent') {
        numberValue(context, fields.get('width'), `${path}.width`, { exclusiveMinimum: 0, code: 'invalid-dimension' });
        numberValue(context, fields.get('height'), `${path}.height`, { exclusiveMinimum: 0, code: 'invalid-dimension' });
        numberValue(context, fields.get('exhaustDirectionDeg'), `${path}.exhaustDirectionDeg`);
        validateStringArray(context, fields.get('acceptsPropulsionCategories')?.value, `${path}.acceptsPropulsionCategories`);
    } else {
        validateStringArray(context, fields.get('acceptedCategories')?.value, `${path}.acceptedCategories`);
    }
    validateRestrictions(context, fields.get('restrictions'), `${path}.restrictions`);
    stringValue(context, fields.get('builtInComponentId'), `${path}.builtInComponentId`, { nonEmpty: true, id: true });
}

function validateHull(context: LocalContext, node: LuaTableNode): void {
    const fields = readFields(context, node, 'definition', [
        'id', 'parts', 'sprites', 'weaponHardpoints', 'activeModuleMounts',
        'thrusterVents', 'utilitySockets', 'hullModCapacity'
    ]);
    if (!fields) return;
    stringValue(context, fields.get('id'), 'definition.id', { nonEmpty: true, id: true });

    const partIds = new Set<string>();
    readArray(context, fields.get('parts')?.value, 'definition.parts')?.forEach(({ value: part, tableEntryIndex: index }) => {
        validateHullPart(context, part, `definition.parts[${index}]`, partIds);
    });

    const layerIds = new Set<string>();
    validateSpriteLayers(context, fields.get('sprites')?.value, 'definition.sprites', 'hull', layerIds);

    const pointIds = new Set<string>();
    const pointArrays = [
        ['weaponHardpoints', 'weapon'],
        ['activeModuleMounts', 'active-module'],
        ['thrusterVents', 'vent'],
        ['utilitySockets', 'utility']
    ] as const;
    for (const [field, kind] of pointArrays) {
        readArray(context, fields.get(field)?.value, `definition.${field}`)?.forEach(({ value: point, tableEntryIndex: index }) => {
            validateHullPoint(context, point, `definition.${field}[${index}]`, kind, pointIds);
        });
    }
    numberValue(context, fields.get('hullModCapacity'), 'definition.hullModCapacity', { minimum: 0, integer: true });
}

function validateStats(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    const fields = readFields(context, entry?.value, path, SHIP_STATS, SHIP_STATS.filter((field) => field !== 'regenEnergy'));
    if (!fields) return;
    for (const stat of SHIP_STATS) numberValue(context, fields.get(stat), `${path}.${stat}`, { minimum: 0 });
}

function validateShip(context: LocalContext, node: LuaTableNode): void {
    const fields = readFields(context, node, 'definition', [
        'hullId', 'loadoutId', 'superType', 'subType', 'name', 'categoryType', 'stats'
    ]);
    if (!fields) return;
    for (const id of ['hullId', 'loadoutId']) {
        stringValue(context, fields.get(id), `definition.${id}`, { nonEmpty: true, id: true });
    }
    for (const text of ['superType', 'subType', 'name', 'categoryType']) {
        stringValue(context, fields.get(text), `definition.${text}`);
    }
    validateStats(context, fields.get('stats'), 'definition.stats');
}

function validateComponentOperation(
    context: LocalContext,
    entry: LuaFieldEntry | undefined,
    path: string,
    weapon: boolean,
    activeModule: boolean
): void {
    const keys = ['cooldown', 'energyCost'];
    const required = ['cooldown', 'energyCost'];
    if (weapon) keys.push('firingMode', 'damage', 'range', 'projectileSpeed', 'splashRadius');
    if (activeModule) keys.push('chargeTime');
    const fields = readFields(context, entry?.value, path, keys, required.concat(weapon ? ['firingMode', 'damage', 'range', 'projectileSpeed', 'splashRadius'] : []));
    if (!fields) return;

    for (const numberField of ['cooldown', 'energyCost']) {
        numberValue(context, fields.get(numberField), `${path}.${numberField}`, { minimum: 0 });
    }
    if (weapon) {
        const mode = fields.get('firingMode');
        const value = stringValue(context, mode, `${path}.firingMode`, { nonEmpty: true });
        const modes = ['Beam', 'Cannon', 'Projectile', 'ProjectileArcade'];
        if (value !== undefined && !modes.includes(value)) {
            issue(context, 'invalid-enum', `${path}.firingMode`, mode!.value.span, `Unsupported firingMode "${value}".`);
        }
        for (const numberField of ['damage', 'range', 'projectileSpeed', 'splashRadius']) {
            numberValue(context, fields.get(numberField), `${path}.${numberField}`, { minimum: 0 });
        }
    }
    if (activeModule) numberValue(context, fields.get('chargeTime'), `${path}.chargeTime`, { minimum: 0 });
}

function validateBaseComponent(
    context: LocalContext,
    fields: TableFields,
    path: string,
    weapon: boolean,
    activeModule: boolean
): void {
    stringValue(context, fields.get('id'), `${path}.id`, { nonEmpty: true, id: true });
    const attachment = fields.get('attachment');
    const attachmentFields = readFields(context, attachment?.value, `${path}.attachment`, ['position', 'attachmentRotationDeg']);
    validatePoint(context, attachmentFields?.get('position')?.value, `${path}.attachment.position`);
    numberValue(context, attachmentFields?.get('attachmentRotationDeg'), `${path}.attachment.attachmentRotationDeg`);
    validateDimensions(context, fields.get('dimensions'), `${path}.dimensions`);
    validateComponentOperation(context, fields.get('operation'), `${path}.operation`, weapon, activeModule);
}

function validateMuzzles(context: LocalContext, node: LuaDataNode | undefined, path: string): void {
    readArray(context, node, path)?.forEach(({ value: muzzle, tableEntryIndex: index }) => {
        const muzzlePath = `${path}[${index}]`;
        const fields = readFields(context, muzzle, muzzlePath, ['position', 'directionDeg']);
        if (!fields) return;
        validatePoint(context, fields.get('position')?.value, `${muzzlePath}.position`);
        numberValue(context, fields.get('directionDeg'), `${muzzlePath}.directionDeg`);
    });
}

function validateWeapon(context: LocalContext, node: LuaTableNode, configuration: 'spinal' | 'turret'): void {
    const path = 'definition';
    const allowed = ['id', 'kind', 'configuration', 'operation', 'attachment', 'dimensions', 'visuals', 'geometry'];
    const required = ['id', 'kind', 'configuration', 'operation', 'attachment', 'visuals', 'geometry'];
    const fields = readFields(context, node, path, allowed, required);
    if (!fields) return;
    validateBaseComponent(context, fields, path, true, false);

    const visualsPath = `${path}.visuals`;
    const visualFields = configuration === 'spinal'
        ? readFields(context, fields.get('visuals')?.value, visualsPath, ['fixed'])
        : readFields(context, fields.get('visuals')?.value, visualsPath, ['fixed', 'rotating']);
    const layerIds = new Set<string>();
    validateSpriteLayers(context, visualFields?.get('fixed')?.value, `${visualsPath}.fixed`, configuration === 'turret' ? 'turret-fixed' : 'component', layerIds);
    if (configuration === 'turret') {
        validateSpriteLayers(context, visualFields?.get('rotating')?.value, `${visualsPath}.rotating`, 'turret-rotating', layerIds);
    }

    const geometryPath = `${path}.geometry`;
    if (configuration === 'spinal') {
        const geometry = readFields(context, fields.get('geometry')?.value, geometryPath, ['muzzles']);
        validateMuzzles(context, geometry?.get('muzzles')?.value, `${geometryPath}.muzzles`);
        return;
    }

    const geometry = readFields(context, fields.get('geometry')?.value, geometryPath, [
        'pivot', 'rotationLimitsDeg', 'rotationSpeedDegPerSecond', 'barrels'
    ]);
    validatePoint(context, geometry?.get('pivot')?.value, `${geometryPath}.pivot`);
    const limitsPath = `${geometryPath}.rotationLimitsDeg`;
    const limits = readFields(context, geometry?.get('rotationLimitsDeg')?.value, limitsPath, ['min', 'max']);
    const minimum = numberValue(context, limits?.get('min'), `${limitsPath}.min`);
    const maximum = numberValue(context, limits?.get('max'), `${limitsPath}.max`);
    if (minimum !== undefined && maximum !== undefined) {
        if (minimum > maximum) {
            issue(context, 'invalid-angle', limitsPath, limits!.get('max')!.value.span, 'Turret limits must be ordered (min <= max).');
        } else if (maximum - minimum > 360) {
            issue(context, 'invalid-angle', limitsPath, limits!.get('max')!.value.span, 'Turret limits must span no more than 360 degrees.');
        }
    }
    numberValue(context, geometry?.get('rotationSpeedDegPerSecond'), `${geometryPath}.rotationSpeedDegPerSecond`, { minimum: 0 });
    const barrelIds = new Set<string>();
    readArray(context, geometry?.get('barrels')?.value, `${geometryPath}.barrels`)?.forEach(({ value: barrel, tableEntryIndex: index }) => {
        const barrelPath = `${geometryPath}.barrels[${index}]`;
        const barrelFields = readFields(context, barrel, barrelPath, ['id', 'position', 'rotationDeg', 'muzzles']);
        if (!barrelFields) return;
        uniqueId(context, barrelFields.get('id'), `${barrelPath}.id`, barrelIds);
        validatePoint(context, barrelFields.get('position')?.value, `${barrelPath}.position`);
        numberValue(context, barrelFields.get('rotationDeg'), `${barrelPath}.rotationDeg`);
        validateMuzzles(context, barrelFields.get('muzzles')?.value, `${barrelPath}.muzzles`);
    });
}

function validateComponent(context: LocalContext, node: LuaTableNode): void {
    const firstFields = collectFields(context, node, 'definition');
    if (!firstFields) return;
    for (const required of ['id', 'kind']) {
        if (!firstFields.has(required)) {
            issue(context, 'missing-field', `definition.${required}`, node.span, `Required field "${required}" is missing.`);
        }
    }
    const kind = stringValue(context, firstFields.get('kind'), 'definition.kind');
    if (kind === undefined) return;
    if (kind === 'weapon') {
        const configurationEntry = firstFields.get('configuration');
        if (!configurationEntry) {
            issue(context, 'missing-field', 'definition.configuration', node.span, 'Required field "configuration" is missing for weapon components.');
            return;
        }
        const configuration = stringValue(context, configurationEntry, 'definition.configuration');
        if (configuration === undefined) return;
        if (configuration !== 'spinal' && configuration !== 'turret') {
            issue(context, 'invalid-enum', 'definition.configuration', firstFields.get('configuration')?.value.span ?? node.span, 'Weapon configuration must be "spinal" or "turret".');
            return;
        }
        validateWeapon(context, node, configuration);
        return;
    }
    if (kind === 'propulsion') {
        const allowed = ['id', 'kind', 'category', 'operation', 'attachment', 'dimensions', 'propulsion', 'sprites'];
        const required = ['id', 'kind', 'category', 'operation', 'attachment', 'propulsion', 'sprites'];
        const fields = readFields(context, node, 'definition', allowed, required);
        if (!fields) return;
        validateBaseComponent(context, fields, 'definition', false, false);
        stringValue(context, fields.get('category'), 'definition.category', { nonEmpty: true });
        const propulsion = readFields(context, fields.get('propulsion')?.value, 'definition.propulsion', ['output']);
        numberValue(context, propulsion?.get('output'), 'definition.propulsion.output', { minimum: 0 });
        validateSpriteLayers(context, fields.get('sprites')?.value, 'definition.sprites', 'component', new Set());
        return;
    }
    if (kind === 'utility') {
        const allowed = ['id', 'kind', 'category', 'operation', 'attachment', 'dimensions', 'sprites'];
        const required = ['id', 'kind', 'category', 'operation', 'attachment', 'sprites'];
        const fields = readFields(context, node, 'definition', allowed, required);
        if (!fields) return;
        validateBaseComponent(context, fields, 'definition', false, false);
        stringValue(context, fields.get('category'), 'definition.category', { nonEmpty: true });
        validateSpriteLayers(context, fields.get('sprites')?.value, 'definition.sprites', 'component', new Set());
        return;
    }
    if (kind === 'active-module') {
        const allowed = ['id', 'kind', 'category', 'operation', 'attachment', 'dimensions', 'payload', 'targeting', 'sprites'];
        const required = ['id', 'kind', 'category', 'operation', 'attachment', 'payload', 'targeting', 'sprites'];
        const fields = readFields(context, node, 'definition', allowed, required);
        if (!fields) return;
        validateBaseComponent(context, fields, 'definition', false, true);
        stringValue(context, fields.get('category'), 'definition.category', { nonEmpty: true });
        validatePayload(context, fields.get('payload'), 'definition.payload');
        validateTargeting(context, fields.get('targeting'), 'definition.targeting');
        validateSpriteLayers(context, fields.get('sprites')?.value, 'definition.sprites', 'component', new Set());
        return;
    }
    readFields(context, node, 'definition', ['id', 'kind'], ['id', 'kind']);
    issue(context, 'invalid-enum', 'definition.kind', firstFields.get('kind')?.value.span ?? node.span, 'Component kind must be weapon, propulsion, utility, or active-module; legacy components are not authored in Phase 3A.');
}

function validatePayload(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    const fields = readFields(context, entry?.value, path, ['kind', 'shell', 'hull', 'energy']);
    if (!fields) return;
    const kind = stringValue(context, fields.get('kind'), `${path}.kind`);
    if (kind === undefined) return;
    if (kind !== 'resource_restore') {
        issue(context, 'invalid-enum', `${path}.kind`, fields.get('kind')?.value.span ?? entry!.value.span, 'Payload kind must be "resource_restore".');
    }
    for (const key of ['shell', 'hull', 'energy']) numberValue(context, fields.get(key), `${path}.${key}`, { minimum: 0 });
}

function validateTargeting(context: LocalContext, entry: LuaFieldEntry | undefined, path: string): void {
    if (!entry) return;
    if (!isTable(entry.value)) {
        issue(context, 'wrong-type', path, entry.value.span, 'Expected an active-module targeting table.');
        return;
    }
    const kindEntry = getField(entry.value, 'kind');
    const kind = stringValue(context, kindEntry, `${path}.kind`);
    if (kind === undefined) {
        readFields(context, entry.value, path, ['kind', 'allowed', 'radius', 'includeSelf'], ['kind']);
        return;
    }
    if (kind === 'self') {
        readFields(context, entry.value, path, ['kind']);
        return;
    }
    if (kind === 'single') {
        const fields = readFields(context, entry.value, path, ['kind', 'allowed']);
        validateStringArray(context, fields?.get('allowed')?.value, `${path}.allowed`, ['Ally', 'Enemy']);
        return;
    }
    if (kind === 'area') {
        const fields = readFields(context, entry.value, path, ['kind', 'allowed', 'radius', 'includeSelf']);
        validateStringArray(context, fields?.get('allowed')?.value, `${path}.allowed`, ['Ally', 'Enemy']);
        numberValue(context, fields?.get('radius'), `${path}.radius`, { minimum: 0 });
        booleanValue(context, fields?.get('includeSelf'), `${path}.includeSelf`);
        return;
    }
    readFields(context, entry.value, path, ['kind', 'allowed', 'radius', 'includeSelf'], ['kind']);
    issue(context, 'invalid-enum', `${path}.kind`, kindEntry?.value.span ?? entry.value.span, 'Targeting kind must be self, single, or area.');
}

function validateLoadout(context: LocalContext, node: LuaTableNode): void {
    const fields = readFields(context, node, 'definition', ['id', 'installations']);
    if (!fields) return;
    stringValue(context, fields.get('id'), 'definition.id', { nonEmpty: true, id: true });
    const mounts = new Map<string, SourceSpan>();
    readArray(context, fields.get('installations')?.value, 'definition.installations')?.forEach(({ value: installation, tableEntryIndex: index }) => {
        const path = `definition.installations[${index}]`;
        const installFields = readFields(context, installation, path, ['mountId', 'componentId']);
        if (!installFields) return;
        const mountId = stringValue(context, installFields.get('mountId'), `${path}.mountId`, { nonEmpty: true, id: true });
        stringValue(context, installFields.get('componentId'), `${path}.componentId`, { nonEmpty: true, id: true });
        if (mountId !== undefined) {
            const field = installFields.get('mountId')!;
            if (mounts.has(mountId)) {
                issue(context, 'duplicate-local-id', `${path}.mountId`, field.value.span, `Loadout installs mount "${mountId}" more than once.`);
            } else {
                mounts.set(mountId, field.value.span);
            }
        }
    });
}

function uniqueId(context: LocalContext, entry: LuaFieldEntry | undefined, path: string, ids: Set<string>): string | undefined {
    const id = stringValue(context, entry, path, { nonEmpty: true, id: true });
    if (id === undefined || !entry) return id;
    if (ids.has(id)) issue(context, 'duplicate-local-id', path, entry.value.span, `ID "${id}" is repeated in this definition.`);
    else ids.add(id);
    return id;
}

function validateEnvelope(context: LocalContext, root: LuaTableNode): LocallyValidatedDefinitionDocument | undefined {
    const fields = readFields(
        context,
        root,
        'document',
        ['schemaVersion', 'domain', 'definition', 'blueprintId', 'sourceKey'],
        ['schemaVersion', 'domain', 'definition']
    );
    if (!fields) return undefined;

    const version = numberValue(context, fields.get('schemaVersion'), 'document.schemaVersion', { integer: true });
    if (version !== undefined && version !== DEFINITION_SCHEMA_VERSION) {
        issue(context, 'invalid-schema-version', 'document.schemaVersion', fields.get('schemaVersion')!.value.span, `Only schemaVersion ${DEFINITION_SCHEMA_VERSION} is supported.`);
    }

    const domainEntry = fields.get('domain');
    const domainValue = stringValue(context, domainEntry, 'document.domain');
    if (domainValue === undefined) return undefined;
    if (!DEFINITION_DOMAINS.includes(domainValue as DefinitionDomain)) {
        issue(context, 'invalid-domain', 'document.domain', fields.get('domain')?.value.span ?? root.span, 'Domain must be hull, ship, component, or loadout.');
        return undefined;
    }
    context.domain = domainValue as DefinitionDomain;

    const definitionEntry = fields.get('definition');
    if (!definitionEntry) return undefined;
    const definition = definitionEntry.value;
    if (!isTable(definition)) {
        issue(context, 'wrong-type', 'document.definition', definition?.span ?? root.span, 'Definition must be an object-shaped table.');
        return undefined;
    }

    if (context.domain === 'ship') {
        if (!fields.has('blueprintId')) {
            issue(context, 'missing-field', 'document.blueprintId', root.span, 'Required field "blueprintId" is missing for ship documents.');
        }
        if (!fields.has('sourceKey')) {
            issue(context, 'missing-field', 'document.sourceKey', root.span, 'Required field "sourceKey" is missing for ship documents.');
        }
        const blueprintId = stringValue(context, fields.get('blueprintId'), 'document.blueprintId', { nonEmpty: true, id: true });
        const sourceKey = stringValue(context, fields.get('sourceKey'), 'document.sourceKey', { nonEmpty: true, id: true });
        return {
            sourceName: context.sourceName,
            rootAst: root,
            domain: 'ship',
            blueprintId: blueprintId ?? '',
            sourceKey: sourceKey ?? '',
            definition
        };
    }

    for (const forbidden of ['blueprintId', 'sourceKey']) {
        const field = fields.get(forbidden);
        if (field) issue(context, 'unknown-field', `document.${forbidden}`, field.keySpan, `Field "${forbidden}" is only valid for ship documents.`);
    }
    return { sourceName: context.sourceName, rootAst: root, domain: context.domain, definition };
}

/** Validate one parsed Phase 3A document without converting its AST. */
export function validateDefinitionDocument(sourceName: string, ast: LuaTableNode): DefinitionValidationResult {
    const context: LocalContext = { sourceName, diagnostics: [] };
    const document = validateEnvelope(context, ast);
    if (document && context.domain && isTable(document.definition)) {
        switch (context.domain) {
            case 'hull': validateHull(context, document.definition); break;
            case 'ship': validateShip(context, document.definition); break;
            case 'component': validateComponent(context, document.definition); break;
            case 'loadout': validateLoadout(context, document.definition); break;
        }
    }
    if (context.diagnostics.length > 0 || !document) {
        return { ok: false, diagnostics: context.diagnostics };
    }
    return { ok: true, document, diagnostics: [] };
}

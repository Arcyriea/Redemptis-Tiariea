import type {
    ActiveModuleMount,
    ComponentDefinition,
    HullDefinition,
    InstallationRecord,
    ShipLoadout,
    ThrusterVent,
    UtilitySocket,
    WeaponHardpoint
} from '../types/Shipmaker';
import type {
    LuaDataNode,
    LuaFieldEntry,
    LuaTableNode,
    SourceSpan
} from './luaDataParser.mjs';
import { cloneLuaDataAst, deepFreezeLuaDataAst, LuaAstSnapshotError } from './luaAstSnapshot';
import {
    validateDefinitionDocument
} from './definitionValidation';
import type {
    DefinitionDiagnostic,
    DefinitionDiagnosticLocation,
    DefinitionDomain,
    DefinitionValidationResult,
    LocallyValidatedDefinitionDocument
} from './definitionSchema';

export interface ExistingDefinitionRecord<T> {
    /** The key used by the owning canonical registry. */
    registryId: string;
    definition: T;
}

export type DeepReadonly<T> = T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type ReadonlyExistingDefinitionRecord<T> = {
    readonly registryId: string;
    readonly definition: DeepReadonly<T>;
};

export interface ExistingBlueprintIdentity {
    id: string;
    sourceKey: string;
}

/** Read-only data copied from the existing owners; no runtime owner is imported here. */
export interface ExistingContentView {
    readonly hullDefinitions: readonly ReadonlyExistingDefinitionRecord<HullDefinition>[];
    readonly componentDefinitions: readonly ReadonlyExistingDefinitionRecord<ComponentDefinition>[];
    readonly shipLoadouts: readonly ReadonlyExistingDefinitionRecord<ShipLoadout>[];
    readonly blueprints: readonly Readonly<ExistingBlueprintIdentity>[];
    readonly legacyCompatibilityViewSourceKeys: readonly string[];
}

export interface ValidatedDefinitionCollection {
    readonly documents: readonly DeepReadonly<LocallyValidatedDefinitionDocument>[];
}

export type DefinitionCollectionValidationResult =
    | { ok: true; collection: ValidatedDefinitionCollection; diagnostics: [] }
    | { ok: false; diagnostics: DefinitionDiagnostic[] };

type DomainIndex = {
    hull: Map<string, Candidate[]>;
    ship: Map<string, Candidate[]>;
    component: Map<string, Candidate[]>;
    loadout: Map<string, Candidate[]>;
};

type ExistingIndex = {
    hull: Map<string, ExistingDefinitionRecord<HullDefinition>[]>;
    component: Map<string, ExistingDefinitionRecord<ComponentDefinition>[]>;
    loadout: Map<string, ExistingDefinitionRecord<ShipLoadout>[]>;
    blueprintId: Map<string, ExistingBlueprintIdentity[]>;
    sourceKey: Map<string, ExistingBlueprintIdentity[]>;
    legacySourceKey: Map<string, string[]>;
};

interface Candidate {
    domain: DefinitionDomain;
    id: string;
    idPath: string;
    idSpan: SourceSpan;
    sourceName: string;
    definition: LuaTableNode;
    document: LocallyValidatedDefinitionDocument;
    identityValid: boolean;
    sourceKey?: string;
    sourceKeySpan?: SourceSpan;
}

interface LocatedString {
    value: string;
    span: SourceSpan;
}

type PointKind = 'weapon' | 'vent' | 'utility' | 'active-module';
interface PointView {
    id: string;
    kind: PointKind;
    accepts?: readonly string[];
    category?: string[];
    builtInComponentId?: LocatedString;
    sourceName: string;
    domain?: DefinitionDomain;
    path: string;
    span: SourceSpan;
}

interface ComponentView {
    id: string;
    kind: ComponentDefinition['kind'];
    configuration?: 'spinal' | 'turret';
    category?: string;
}

interface InstallationView {
    mountId: LocatedString;
    componentId: LocatedString;
    sourceName: string;
    domain?: DefinitionDomain;
    path: string;
}

interface Resolved<T> {
    kind: 'candidate' | 'existing';
    value: T;
    candidate?: Candidate;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOMAIN_PREFIX: Record<DefinitionDomain, string> = {
    hull: 'hull',
    ship: 'ship',
    component: 'component',
    loadout: 'loadout'
};

function compareOrdinal(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareLocations(left: DefinitionDiagnosticLocation, right: DefinitionDiagnosticLocation): number {
    return compareOrdinal(left.sourceName, right.sourceName)
        || compareOrdinal(left.domain ?? '', right.domain ?? '')
        || compareOrdinal(left.path, right.path)
        || ((left.span?.start.offset ?? -1) - (right.span?.start.offset ?? -1));
}

function compareDiagnostics(left: DefinitionDiagnostic, right: DefinitionDiagnostic): number {
    const primary = compareOrdinal(left.sourceName, right.sourceName)
        || left.span.start.offset - right.span.start.offset
        || compareOrdinal(left.path, right.path)
        || compareOrdinal(left.code, right.code)
        || compareOrdinal(left.message, right.message);
    if (primary !== 0) return primary;
    const leftRelated = left.relatedLocations ?? [];
    const rightRelated = right.relatedLocations ?? [];
    for (let index = 0; index < Math.min(leftRelated.length, rightRelated.length); index++) {
        const relatedOrder = compareLocations(leftRelated[index], rightRelated[index]);
        if (relatedOrder !== 0) return relatedOrder;
    }
    return leftRelated.length - rightRelated.length;
}

function uniqueDiagnostics(diagnostics: DefinitionDiagnostic[]): DefinitionDiagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
        const key = [
            diagnostic.code,
            diagnostic.sourceName,
            diagnostic.domain ?? '',
            diagnostic.path,
            diagnostic.span.start.offset,
            diagnostic.span.end.offset,
            diagnostic.message
        ].join('\u0000');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function tableField(table: LuaTableNode, key: string): LuaFieldEntry | undefined {
    return table.entries.find((entry): entry is LuaFieldEntry => entry.kind === 'field' && entry.key === key);
}

function stringNode(node: LuaDataNode | undefined): LocatedString | undefined {
    return node?.kind === 'string' ? { value: node.value, span: node.span } : undefined;
}

function fieldString(table: LuaTableNode, key: string): LocatedString | undefined {
    return stringNode(tableField(table, key)?.value);
}

function fieldTable(table: LuaTableNode, key: string): LuaTableNode | undefined {
    const value = tableField(table, key)?.value;
    return value?.kind === 'table' ? value : undefined;
}

function arrayTables(table: LuaTableNode, key: string): Array<{ node: LuaTableNode; index: number }> {
    const value = fieldTable(table, key);
    if (!value) return [];
    const result: Array<{ node: LuaTableNode; index: number }> = [];
    value.entries.forEach((entry, index) => {
        if (entry.kind === 'array' && entry.value.kind === 'table') result.push({ node: entry.value, index });
    });
    return result;
}

function stringsFromArray(table: LuaTableNode, key: string): string[] {
    const value = fieldTable(table, key);
    if (!value) return [];
    return value.entries.flatMap((entry) => entry.kind === 'array' && entry.value.kind === 'string' ? [entry.value.value] : []);
}

function hasNamespacedId(id: string, domain: DefinitionDomain): boolean {
    const separator = id.indexOf(':');
    return separator !== -1
        && id.slice(0, separator) === DOMAIN_PREFIX[domain]
        && UUID_V4.test(id.slice(separator + 1));
}

function addToIndex<T>(index: Map<string, T[]>, key: string, value: T): void {
    const entries = index.get(key);
    if (entries) entries.push(value);
    else index.set(key, [value]);
}

function existingIndex(view: ExistingContentView): ExistingIndex {
    const index: ExistingIndex = {
        hull: new Map(), component: new Map(), loadout: new Map(),
        blueprintId: new Map(), sourceKey: new Map(), legacySourceKey: new Map()
    };
    for (const record of view.hullDefinitions) addToIndex(index.hull, record.registryId, record);
    for (const record of view.componentDefinitions) addToIndex(index.component, record.registryId, record);
    for (const record of view.shipLoadouts) addToIndex(index.loadout, record.registryId, record);
    for (const blueprint of view.blueprints) {
        addToIndex(index.blueprintId, blueprint.id, blueprint);
        addToIndex(index.sourceKey, blueprint.sourceKey, blueprint);
    }
    for (const sourceKey of view.legacyCompatibilityViewSourceKeys) {
        addToIndex(index.legacySourceKey, sourceKey, sourceKey);
    }
    return index;
}

function candidateFromDocument(document: LocallyValidatedDefinitionDocument): Candidate | undefined {
    const root = document.rootAst;
    const definition = tableField(root, 'definition')?.value;
    if (!definition || definition.kind !== 'table') return undefined;

    let id: LocatedString | undefined;
    let idPath: string;
    if (document.domain === 'ship') {
        id = fieldString(root, 'blueprintId');
        idPath = 'document.blueprintId';
    } else {
        id = fieldString(definition, 'id');
        idPath = 'definition.id';
    }
    if (!id) return undefined;
    const sourceKey = document.domain === 'ship' ? fieldString(root, 'sourceKey') : undefined;
    return {
        domain: document.domain,
        id: id.value,
        idPath,
        idSpan: id.span,
        sourceName: document.sourceName,
        definition,
        document,
        identityValid: hasNamespacedId(id.value, document.domain),
        ...(sourceKey ? { sourceKey: sourceKey.value, sourceKeySpan: sourceKey.span } : {})
    };
}

function location(sourceName: string, path: string, domain?: DefinitionDomain, span?: SourceSpan): DefinitionDiagnosticLocation {
    return { sourceName, path, ...(domain ? { domain } : {}), ...(span ? { span } : {}) };
}

function pointDiagnosticLocation(point: PointView): DefinitionDiagnosticLocation {
    const existing = point.sourceName.startsWith('<ExistingContentView.');
    return location(point.sourceName, point.path, point.domain, existing ? undefined : point.span);
}

function installationDiagnosticContext(
    ship: Candidate,
    loadout: Resolved<Candidate | ExistingDefinitionRecord<ShipLoadout>>,
    installation: InstallationView,
    field: 'mountId' | 'componentId',
    shipLoadoutReference: LocatedString
): { candidate: Candidate; path: string; span: SourceSpan; related?: DefinitionDiagnosticLocation[] } {
    if (loadout.kind === 'candidate') {
        return {
            candidate: loadout.value as Candidate,
            path: `${installation.path}.${field}`,
            span: installation[field].span
        };
    }
    return {
        candidate: ship,
        path: 'definition.loadoutId',
        span: shipLoadoutReference.span,
        related: [location(installation.sourceName, `${installation.path}.${field}`)]
    };
}

function addDiagnostic(
    diagnostics: DefinitionDiagnostic[],
    code: DefinitionDiagnostic['code'],
    candidate: Candidate,
    path: string,
    span: SourceSpan,
    message: string,
    relatedLocations?: readonly DefinitionDiagnosticLocation[]
): void {
    const orderedRelated = relatedLocations ? [...relatedLocations].sort(compareLocations) : undefined;
    diagnostics.push({
        code,
        sourceName: candidate.sourceName,
        domain: candidate.domain,
        path,
        span,
        message,
        ...(orderedRelated?.length ? { relatedLocations: orderedRelated } : {})
    });
}

function buildCandidateIndexes(candidates: readonly Candidate[]): DomainIndex {
    const indexes: DomainIndex = { hull: new Map(), ship: new Map(), component: new Map(), loadout: new Map() };
    for (const candidate of candidates) addToIndex(indexes[candidate.domain], candidate.id, candidate);
    return indexes;
}

function checkCandidateIdentities(
    candidates: readonly Candidate[],
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): void {
    for (const candidate of candidates) {
        if (!candidate.identityValid) {
            addDiagnostic(
                diagnostics,
                'invalid-definition-id',
                candidate,
                candidate.idPath,
                candidate.idSpan,
                `New ${candidate.domain} definitions must use ${DOMAIN_PREFIX[candidate.domain]}:<lowercase UUIDv4>.`
            );
        }
        const existingIndexForDomain = candidate.domain === 'ship'
            ? existing.blueprintId
            : existing[candidate.domain];
        if (existingIndexForDomain.has(candidate.id)) {
            const existingRecords = existingIndexForDomain.get(candidate.id)!;
            addDiagnostic(
                diagnostics,
                'existing-definition-conflict',
                candidate,
                candidate.idPath,
                candidate.idSpan,
                `${candidate.domain} ID "${candidate.id}" already exists in existing content.`,
                existingRecords.map(() => location(
                    candidate.domain === 'ship' ? '<ExistingContentView.blueprints>' : `<ExistingContentView.${candidate.domain}Definitions>`,
                    `${candidate.domain === 'ship' ? 'blueprints' : `${candidate.domain}Definitions`}[${candidate.id}]`,
                    candidate.domain
                ))
            );
        }

        const candidateRecords = candidateIndexes[candidate.domain].get(candidate.id) ?? [];
        if (candidateRecords.length > 1) {
            const ordered = [...candidateRecords].sort((left, right) => (
                compareOrdinal(left.sourceName, right.sourceName)
                || left.idSpan.start.offset - right.idSpan.start.offset
                || compareOrdinal(left.idPath, right.idPath)
            ));
            const primary = ordered[0];
            if (candidate === primary) continue;
            addDiagnostic(
                diagnostics,
                'duplicate-definition-id',
                candidate,
                candidate.idPath,
                candidate.idSpan,
                `Duplicate ${candidate.domain} ID "${candidate.id}".`,
                [location(primary.sourceName, primary.idPath, primary.domain, primary.idSpan)]
            );
        }
    }

    const sourceGroups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        if (candidate.domain === 'ship' && candidate.sourceKey !== undefined) {
            addToIndex(sourceGroups, candidate.sourceKey, candidate);
        }
    }
    for (const [sourceKey, group] of sourceGroups) {
        const sorted = [...group].sort((left, right) => (
            compareOrdinal(left.sourceName, right.sourceName)
            || (left.sourceKeySpan?.start.offset ?? -1) - (right.sourceKeySpan?.start.offset ?? -1)
        ));
        const existingBlueprints = existing.sourceKey.get(sourceKey) ?? [];
        const legacyViews = existing.legacySourceKey.get(sourceKey) ?? [];
        const related = [
            ...existingBlueprints.map(() => location('<ExistingContentView.blueprints>', `blueprints.sourceKey[${sourceKey}]`, 'ship')),
            ...legacyViews.map(() => location('<ExistingContentView.legacyCompatibilityViewSourceKeys>', `legacyCompatibilityViewSourceKeys[${sourceKey}]`, 'ship'))
        ];
        for (let index = 0; index < sorted.length; index++) {
            const candidate = sorted[index];
            if (index === 0 && existingBlueprints.length === 0 && legacyViews.length === 0) continue;
            addDiagnostic(
                diagnostics,
                index === 0 ? 'existing-definition-conflict' : 'duplicate-blueprint-source-key',
                candidate,
                'document.sourceKey',
                candidate.sourceKeySpan ?? candidate.idSpan,
                `Ship sourceKey "${sourceKey}" is already in use.`,
                index === 0 ? related : [location(sorted[0].sourceName, 'document.sourceKey', 'ship', sorted[0].sourceKeySpan)]
            );
        }
    }
}

function relatedCandidateLocations(candidates: readonly Candidate[]): DefinitionDiagnosticLocation[] {
    return candidates.map((candidate) => location(candidate.sourceName, candidate.idPath, candidate.domain, candidate.idSpan));
}

function resolveDefinition<T>(
    targetDomain: Exclude<DefinitionDomain, 'ship'>,
    id: LocatedString,
    source: Candidate,
    path: string,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): Resolved<T> | undefined {
    const candidateMatches = candidateIndexes[targetDomain].get(id.value) ?? [];
    const existingMatches = existing[targetDomain].get(id.value) ?? [];
    const fieldIsNamespaced = hasNamespacedId(id.value, targetDomain);

    if (candidateMatches.length > 1 || existingMatches.length > 1 || (candidateMatches.length > 0 && existingMatches.length > 0)) {
        addDiagnostic(
            diagnostics,
            'ambiguous-reference',
            source,
            path,
            id.span,
            `Reference "${id.value}" is ambiguous in the ${targetDomain} namespace.`,
            [...relatedCandidateLocations(candidateMatches), ...existingMatches.map(() => location(
                `<ExistingContentView.${targetDomain}Definitions>`, `${targetDomain}Definitions[${id.value}]`, targetDomain
            ))]
        );
        return undefined;
    }

    if (candidateMatches.length === 1) {
        const target = candidateMatches[0];
        if (target.identityValid && fieldIsNamespaced) {
            return { kind: 'candidate', value: target as unknown as T, candidate: target };
        }
        addDiagnostic(diagnostics, 'invalid-id', source, path, id.span, `Reference "${id.value}" does not use the required ${DOMAIN_PREFIX[targetDomain]} UUID namespace.`);
        return undefined;
    }
    if (existingMatches.length === 1) {
        return { kind: 'existing', value: existingMatches[0] as unknown as T };
    }

    if (!fieldIsNamespaced) {
        addDiagnostic(diagnostics, 'invalid-id', source, path, id.span, `Unknown legacy ID "${id.value}"; legacy IDs resolve only when present in ExistingContentView.`);
    } else {
        addDiagnostic(diagnostics, 'unresolved-reference', source, path, id.span, `No ${targetDomain} definition exists for "${id.value}".`);
    }
    return undefined;
}

function candidateComponentView(candidate: Candidate): ComponentView | undefined {
    const kind = fieldString(candidate.definition, 'kind')?.value;
    if (!kind) return undefined;
    if (kind === 'weapon') {
        const configuration = fieldString(candidate.definition, 'configuration')?.value;
        if (configuration !== 'spinal' && configuration !== 'turret') return undefined;
        return { id: candidate.id, kind: 'weapon', configuration };
    }
    if (kind === 'propulsion' || kind === 'utility' || kind === 'active-module') {
        const category = fieldString(candidate.definition, 'category')?.value;
        if (category === undefined) return undefined;
        return { id: candidate.id, kind, category };
    }
    return undefined;
}

function resolvedComponentView(
    resolved: Resolved<Candidate | ExistingDefinitionRecord<ComponentDefinition>>
): ComponentView | undefined {
    if (resolved.kind === 'candidate') return candidateComponentView(resolved.value as Candidate);
    const definition = (resolved.value as ExistingDefinitionRecord<ComponentDefinition>).definition;
    if (definition.kind === 'weapon') return { id: definition.id, kind: 'weapon', configuration: definition.configuration };
    if (definition.kind === 'propulsion' || definition.kind === 'utility' || definition.kind === 'active-module') {
        return { id: definition.id, kind: definition.kind, category: definition.category };
    }
    return { id: definition.id, kind: 'legacy' };
}

function candidatePoints(candidate: Candidate): PointView[] {
    const result: PointView[] = [];
    const arrays: Array<[string, PointKind]> = [
        ['weaponHardpoints', 'weapon'], ['thrusterVents', 'vent'],
        ['utilitySockets', 'utility'], ['activeModuleMounts', 'active-module']
    ];
    for (const [field, kind] of arrays) {
        for (const { node, index } of arrayTables(candidate.definition, field)) {
            const id = fieldString(node, 'id');
            if (!id) continue;
            const builtInComponentId = fieldString(node, 'builtInComponentId');
            result.push({
                id: id.value,
                kind,
                ...(kind === 'weapon' ? { accepts: stringsFromArray(node, 'accepts') } : {}),
                ...(kind === 'vent' ? { category: stringsFromArray(node, 'acceptsPropulsionCategories') } : {}),
                ...(kind === 'utility' || kind === 'active-module' ? { category: stringsFromArray(node, 'acceptedCategories') } : {}),
                ...(builtInComponentId ? { builtInComponentId } : {}),
                sourceName: candidate.sourceName,
                domain: candidate.domain,
                path: `definition.${field}[${index}]`,
                span: id.span
            });
        }
    }
    return result;
}

function existingPoints(record: ExistingDefinitionRecord<HullDefinition>): PointView[] {
    const result: PointView[] = [];
    const add = (
        points: readonly (WeaponHardpoint | ThrusterVent | UtilitySocket | ActiveModuleMount)[],
        kind: PointKind,
        path: string
    ): void => {
        points.forEach((point, index) => result.push({
            id: point.id,
            kind,
            ...(kind === 'weapon' && 'accepts' in point ? { accepts: point.accepts } : {}),
            ...(kind === 'vent' && 'acceptsPropulsionCategories' in point ? { category: [...point.acceptsPropulsionCategories] } : {}),
            ...((kind === 'utility' || kind === 'active-module') && 'acceptedCategories' in point ? { category: [...point.acceptedCategories] } : {}),
            ...(point.builtInComponentId ? { builtInComponentId: { value: point.builtInComponentId, span: zeroSpan() } } : {}),
            sourceName: `<ExistingContentView.hullDefinitions[${record.registryId}]>`,
            path: `${path}[${index}]`,
            span: zeroSpan()
        }));
    };
    add(record.definition.weaponHardpoints, 'weapon', 'definition.weaponHardpoints');
    add(record.definition.thrusterVents, 'vent', 'definition.thrusterVents');
    add(record.definition.utilitySockets, 'utility', 'definition.utilitySockets');
    add(record.definition.activeModuleMounts, 'active-module', 'definition.activeModuleMounts');
    return result;
}

function zeroSpan(): SourceSpan {
    const point = { offset: 0, line: 1, column: 1 };
    return { start: point, end: point };
}

function candidateInstallations(candidate: Candidate): InstallationView[] {
    return arrayTables(candidate.definition, 'installations').flatMap(({ node, index }) => {
        const mountId = fieldString(node, 'mountId');
        const componentId = fieldString(node, 'componentId');
        if (!mountId || !componentId) return [];
        return [{
            mountId,
            componentId,
            sourceName: candidate.sourceName,
            domain: candidate.domain,
            path: `definition.installations[${index}]`
        }];
    });
}

function existingInstallations(record: ExistingDefinitionRecord<ShipLoadout>): InstallationView[] {
    return record.definition.installations.map((installation: InstallationRecord, index) => ({
        mountId: { value: installation.mountId, span: zeroSpan() },
        componentId: { value: installation.componentId, span: zeroSpan() },
        sourceName: `<ExistingContentView.shipLoadouts[${record.registryId}]>`,
        path: `definition.installations[${index}]`
    }));
}

function incompatible(component: ComponentView, point: PointView): boolean {
    if (component.kind === 'legacy') return true;
    if (component.kind === 'weapon') {
        return point.kind !== 'weapon' || !point.accepts?.includes(component.configuration!);
    }
    if (component.kind === 'propulsion') return point.kind !== 'vent' || !point.category?.includes(component.category!);
    if (component.kind === 'active-module') return point.kind !== 'active-module' || !point.category?.includes(component.category!);
    return point.kind !== 'utility' || !point.category?.includes(component.category!);
}

function resolveComponent(
    id: LocatedString,
    source: Candidate,
    path: string,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): Resolved<Candidate | ExistingDefinitionRecord<ComponentDefinition>> | undefined {
    return resolveDefinition<Candidate | ExistingDefinitionRecord<ComponentDefinition>>(
        'component', id, source, path, candidateIndexes, existing, diagnostics
    );
}

function validateComponentReference(
    id: LocatedString,
    source: Candidate,
    path: string,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): Resolved<Candidate | ExistingDefinitionRecord<ComponentDefinition>> | undefined {
    const component = resolveComponent(id, source, path, candidateIndexes, existing, diagnostics);
    if (!component) return undefined;
    const view = resolvedComponentView(component);
    if (!view || view.kind === 'legacy') {
        addDiagnostic(diagnostics, 'incompatible-mount', source, path, id.span, `Legacy or invalid component "${id.value}" cannot be installed by a canonical loadout.`);
        return undefined;
    }
    return component;
}

function validateHullBuiltIns(
    hull: Candidate,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): void {
    for (const point of candidatePoints(hull)) {
        if (!point.builtInComponentId) continue;
        const component = validateComponentReference(
            point.builtInComponentId,
            hull,
            `${point.path}.builtInComponentId`,
            candidateIndexes,
            existing,
            diagnostics
        );
        if (!component) continue;
        const componentView = resolvedComponentView(component);
        if (componentView && incompatible(componentView, point)) {
            addDiagnostic(
                diagnostics, 'incompatible-mount', hull,
                `${point.path}.builtInComponentId`, point.builtInComponentId.span,
                `Component "${componentView.id}" is incompatible with built-in ${point.kind} point "${point.id}".`
            );
        }
    }
}

function getPoints(resolved: Resolved<Candidate | ExistingDefinitionRecord<HullDefinition>>): PointView[] {
    return resolved.kind === 'candidate'
        ? candidatePoints(resolved.value as Candidate)
        : existingPoints(resolved.value as ExistingDefinitionRecord<HullDefinition>);
}

function validateLoadoutComponentReferences(
    loadout: Candidate,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): void {
    const installations = candidateInstallations(loadout);
    const seen = new Map<string, InstallationView>();
    for (const installation of installations) {
        const prior = seen.get(installation.mountId.value);
        if (prior) {
            addDiagnostic(
                diagnostics,
                'duplicate-local-id',
                loadout,
                `${installation.path}.mountId`,
                installation.mountId.span,
                `Loadout installs mount "${installation.mountId.value}" more than once.`,
                [location(prior.sourceName, `${prior.path}.mountId`, prior.domain, prior.mountId.span)]
            );
        } else {
            seen.set(installation.mountId.value, installation);
        }
        validateComponentReference(
            installation.componentId,
            loadout,
            `${installation.path}.componentId`,
            candidateIndexes,
            existing,
            diagnostics
        );
    }
}

function validateShipCombinations(
    ship: Candidate,
    candidateIndexes: DomainIndex,
    existing: ExistingIndex,
    diagnostics: DefinitionDiagnostic[]
): void {
    const hullId = fieldString(ship.definition, 'hullId');
    const loadoutId = fieldString(ship.definition, 'loadoutId');
    if (!hullId || !loadoutId) return;

    const hull = resolveDefinition<Candidate | ExistingDefinitionRecord<HullDefinition>>(
        'hull', hullId, ship, 'definition.hullId', candidateIndexes, existing, diagnostics
    );
    const loadout = resolveDefinition<Candidate | ExistingDefinitionRecord<ShipLoadout>>(
        'loadout', loadoutId, ship, 'definition.loadoutId', candidateIndexes, existing, diagnostics
    );
    if (!hull || !loadout) return;

    const hullCandidate = hull.kind === 'candidate' ? hull.value as Candidate : undefined;
    const points = getPoints(hull);
    const pointIndex = new Map<string, PointView[]>();
    for (const point of points) addToIndex(pointIndex, point.id, point);
    const reserved = new Set(points.filter((point) => point.builtInComponentId).map((point) => point.id));
    const installations = loadout.kind === 'candidate'
        ? candidateInstallations(loadout.value as Candidate)
        : existingInstallations(loadout.value as ExistingDefinitionRecord<ShipLoadout>);
    const installedMounts = new Map<string, InstallationView>();

    for (const installation of installations) {
        const pointMatches = pointIndex.get(installation.mountId.value) ?? [];
        if (pointMatches.length === 0) {
            const context = installationDiagnosticContext(ship, loadout, installation, 'mountId', loadoutId);
            const message = `Ship "${ship.id}" uses hull "${hullCandidate?.id ?? (hull.value as ExistingDefinitionRecord<HullDefinition>).registryId}"; mount "${installation.mountId.value}" is not on that hull.`;
            addDiagnostic(diagnostics, 'unresolved-reference', context.candidate, context.path, context.span, message, [
                ...(context.related ?? []),
                location(installation.sourceName, `${installation.path}.mountId`, installation.domain,
                    installation.sourceName.startsWith('<ExistingContentView.') ? undefined : installation.mountId.span)
            ]);
            continue;
        }
        if (pointMatches.length > 1) {
            const context = installationDiagnosticContext(ship, loadout, installation, 'mountId', loadoutId);
            addDiagnostic(
                diagnostics, 'ambiguous-reference', context.candidate, context.path, context.span,
                `Mount "${installation.mountId.value}" is ambiguous on hull "${hullCandidate?.id ?? (hull.value as ExistingDefinitionRecord<HullDefinition>).registryId}".`,
                [...(context.related ?? []), ...pointMatches.map(pointDiagnosticLocation)]
            );
            continue;
        }
        const point = pointMatches[0];
        const previous = installedMounts.get(installation.mountId.value);
        if (previous) {
            const context = installationDiagnosticContext(ship, loadout, installation, 'mountId', loadoutId);
            addDiagnostic(
                diagnostics, 'duplicate-local-id', context.candidate, context.path, context.span,
                `Ship "${ship.id}" loadout installs mount "${installation.mountId.value}" more than once on hull "${hullCandidate?.id ?? (hull.value as ExistingDefinitionRecord<HullDefinition>).registryId}".`,
                [...(context.related ?? []), location(previous.sourceName, `${previous.path}.mountId`, previous.domain,
                    previous.sourceName.startsWith('<ExistingContentView.') ? undefined : previous.mountId.span)]
            );
        } else {
            installedMounts.set(installation.mountId.value, installation);
        }
        if (reserved.has(installation.mountId.value)) {
            const context = installationDiagnosticContext(ship, loadout, installation, 'mountId', loadoutId);
            addDiagnostic(
                diagnostics, 'reserved-mount', context.candidate, context.path, context.span,
                `Ship "${ship.id}" loadout replaces the built-in component at mount "${installation.mountId.value}" on hull "${hullCandidate?.id ?? (hull.value as ExistingDefinitionRecord<HullDefinition>).registryId}".`,
                [...(context.related ?? []), pointDiagnosticLocation(point)]
            );
            continue;
        }
        const component = validateComponentReference(
            installation.componentId,
            loadout.kind === 'candidate' ? loadout.value as Candidate : ship,
            loadout.kind === 'candidate' ? `${installation.path}.componentId` : 'definition.loadoutId',
            candidateIndexes,
            existing,
            diagnostics
        );
        if (!component) continue;
        const componentView = resolvedComponentView(component);
        if (componentView && incompatible(componentView, point)) {
            const context = installationDiagnosticContext(ship, loadout, installation, 'componentId', loadoutId);
            addDiagnostic(
                diagnostics, 'incompatible-mount', context.candidate,
                context.path, context.span,
                `Component "${componentView.id}" is incompatible with mount "${installation.mountId.value}" on ship "${ship.id}" hull "${hullCandidate?.id ?? (hull.value as ExistingDefinitionRecord<HullDefinition>).registryId}".`,
                [...(context.related ?? []), pointDiagnosticLocation(point)]
            );
        }
    }
}

function addLocalDiagnostics(diagnostics: DefinitionDiagnostic[], result: Extract<DefinitionValidationResult, { ok: false }>): void {
    diagnostics.push(...result.diagnostics);
}

/**
 * Snapshot, revalidate, and collection-check local Phase 3A documents.
 * Candidate indexes are private to this call and are not returned.
 */
export function validateDefinitionCollection(
    documents: readonly LocallyValidatedDefinitionDocument[],
    content: ExistingContentView
): DefinitionCollectionValidationResult {
    const diagnostics: DefinitionDiagnostic[] = [];
    const snapshots: LocallyValidatedDefinitionDocument[] = [];

    for (const input of documents) {
        let clonedRoot: LuaTableNode;
        try {
            clonedRoot = cloneLuaDataAst(input.rootAst);
        } catch (error) {
            const span = error instanceof LuaAstSnapshotError ? error.span : zeroSpan();
            diagnostics.push({
                code: 'invalid-ast-snapshot',
                message: error instanceof Error ? error.message : 'Lua AST could not be snapshotted.',
                sourceName: input.sourceName,
                path: 'document',
                span
            });
            continue;
        }
        const result = validateDefinitionDocument(input.sourceName, clonedRoot);
        if (!result.ok) {
            addLocalDiagnostics(diagnostics, result);
            continue;
        }
        deepFreezeLuaDataAst(clonedRoot);
        Object.freeze(result.document);
        snapshots.push(result.document);
    }

    if (diagnostics.length > 0) {
        return { ok: false, diagnostics: uniqueDiagnostics(diagnostics).sort(compareDiagnostics) };
    }

    const candidates = snapshots.flatMap((document) => {
        const candidate = candidateFromDocument(document);
        return candidate ? [candidate] : [];
    });
    const indexes = buildCandidateIndexes(candidates);
    const existing = existingIndex(content);

    checkCandidateIdentities(candidates, indexes, existing, diagnostics);
    for (const candidate of candidates) {
        if (candidate.domain === 'hull') validateHullBuiltIns(candidate, indexes, existing, diagnostics);
        if (candidate.domain === 'loadout') validateLoadoutComponentReferences(candidate, indexes, existing, diagnostics);
    }
    for (const candidate of candidates) {
        if (candidate.domain === 'ship') validateShipCombinations(candidate, indexes, existing, diagnostics);
    }

    const orderedDiagnostics = uniqueDiagnostics(diagnostics).sort(compareDiagnostics);
    if (orderedDiagnostics.length > 0) return { ok: false, diagnostics: orderedDiagnostics };

    const frozenDocuments = Object.freeze(snapshots.slice());
    const collection = Object.freeze({ documents: frozenDocuments });
    return { ok: true, collection, diagnostics: [] };
}

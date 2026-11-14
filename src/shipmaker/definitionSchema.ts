import type { LuaTableNode, SourceSpan } from './luaDataParser.mjs';

export const DEFINITION_SCHEMA_VERSION = 1 as const;

export const DEFINITION_DOMAINS = ['hull', 'ship', 'component', 'loadout'] as const;
export type DefinitionDomain = typeof DEFINITION_DOMAINS[number];

interface DefinitionEnvelopeBase {
    schemaVersion: typeof DEFINITION_SCHEMA_VERSION;
    domain: DefinitionDomain;
    definition: LuaTableNode;
}

export interface HullDefinitionEnvelope extends DefinitionEnvelopeBase {
    domain: 'hull';
}

export interface ShipDefinitionEnvelope extends DefinitionEnvelopeBase {
    domain: 'ship';
    blueprintId: string;
    sourceKey: string;
}

export interface ComponentDefinitionEnvelope extends DefinitionEnvelopeBase {
    domain: 'component';
}

export interface LoadoutDefinitionEnvelope extends DefinitionEnvelopeBase {
    domain: 'loadout';
}

export type DefinitionEnvelope =
    | HullDefinitionEnvelope
    | ShipDefinitionEnvelope
    | ComponentDefinitionEnvelope
    | LoadoutDefinitionEnvelope;

/**
 * A successful Phase 3A document retains the complete envelope AST in rootAst;
 * definition points into that same tree. The convenience fields are derived
 * when validation succeeds and may become stale if rootAst is later mutated.
 * Phase 3B must use rootAst only, clone it, and revalidate the clone.
 */
export type LocallyValidatedDefinitionDocument =
    | { sourceName: string; rootAst: LuaTableNode; domain: 'hull'; definition: LuaTableNode }
    | { sourceName: string; rootAst: LuaTableNode; domain: 'ship'; blueprintId: string; sourceKey: string; definition: LuaTableNode }
    | { sourceName: string; rootAst: LuaTableNode; domain: 'component'; definition: LuaTableNode }
    | { sourceName: string; rootAst: LuaTableNode; domain: 'loadout'; definition: LuaTableNode };

export type DefinitionDiagnosticCode =
    | 'invalid-envelope'
    | 'invalid-schema-version'
    | 'invalid-domain'
    | 'missing-field'
    | 'unknown-field'
    | 'duplicate-field'
    | 'wrong-type'
    | 'invalid-id'
    | 'duplicate-local-id'
    | 'invalid-enum'
    | 'invalid-number'
    | 'invalid-dimension'
    | 'invalid-angle'
    | 'invalid-sprite-layer'
    | 'invalid-asset-id'
    | 'invalid-asset-type'
    | 'invalid-restrictions-shape'
    | 'invalid-ast-snapshot'
    | 'invalid-definition-id'
    | 'duplicate-definition-id'
    | 'existing-definition-conflict'
    | 'duplicate-blueprint-source-key'
    | 'unresolved-reference'
    | 'ambiguous-reference'
    | 'incompatible-mount'
    | 'reserved-mount';

export interface DefinitionDiagnosticLocation {
    sourceName: string;
    domain?: DefinitionDomain;
    path: string;
    span?: SourceSpan;
}

export interface DefinitionDiagnostic {
    code: DefinitionDiagnosticCode;
    message: string;
    sourceName: string;
    domain?: DefinitionDomain;
    /** Dotted object path with zero-based array indexes, e.g. definition.parts[0].position.x. */
    path: string;
    span: SourceSpan;
    relatedLocations?: readonly DefinitionDiagnosticLocation[];
}

export type DefinitionValidationResult =
    | { ok: true; document: LocallyValidatedDefinitionDocument; diagnostics: [] }
    | { ok: false; diagnostics: DefinitionDiagnostic[] };

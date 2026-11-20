import type { DesignNode } from './design.js';
export type ReuseLevel = 'shell' | 'control' | 'business';
export type ReuseRole = 'shell' | 'content' | 'control' | 'unknown';
export type ReuseMatchSource = 'explicit' | 'code-dir' | 'symbol-instance' | 'name-semantics' | 'structure';
export type ReuseStatus = 'confirmed' | 'suspected';
export interface ComponentReuseContract {
    id: string;
    designNodeId: string;
    designName: string;
    level: ReuseLevel;
    role: ReuseRole;
    projectComponent: string;
    match: {
        source: ReuseMatchSource;
        confidence: number;
        status: ReuseStatus;
        evidence: string;
    };
    importPath?: string;
    slot: {
        contentSlot?: string;
        headerSlot?: string;
        extraSlots?: Record<string, string>;
        valueProps?: string[];
        eventProps?: string[];
        contentDesignNodeIds: string[];
        omitDesignNodeIds: string[];
    };
    nested?: string[];
    verify: {
        nodeId: string;
        note: string;
    };
    referencePages?: string[];
}
export interface CatalogComponent {
    name: string;
    importPath: string;
    props: string[];
    slots: string[];
    usageSample?: string;
    sourceFile: string;
}
export declare function planComponentReuse(root: DesignNode, opts: {
    contracts?: ComponentReuseContract[];
    catalog?: CatalogComponent[];
    policy: 'off' | 'auto' | 'explicit';
}): ComponentReuseContract[];
export declare function writeComponentCatalog(catalog: CatalogComponent[], path: string): void;
export declare function readComponentCatalog(path: string): CatalogComponent[];

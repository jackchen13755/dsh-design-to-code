import type { DesignModel, DesignNode } from './design.js';
export interface DiffItem {
    kind: 'added' | 'removed' | 'changed';
    key: string;
    name: string;
    type: string;
    fields?: Array<{
        field: string;
        from: string;
        to: string;
    }>;
    newNode?: DesignNode;
    oldNode?: DesignNode;
}
export interface CodeHit {
    file: string;
    line: number;
    text: string;
    keyword: string;
}
export declare function diffModels(oldModel: DesignModel | null, newModel: DesignModel): DiffItem[];
export declare function keywordsOf(model: DesignModel, limit?: number): string[];
/** 在目标仓库里找设计文案/关键字的落点（有界遍历，跳过产物目录） */
export declare function findCodeHits(codeDir: string, keywords: string[], opts?: {
    maxFiles?: number;
    maxHits?: number;
    extra?: string[];
}): {
    hits: CodeHit[];
    scanned: number;
    truncated: boolean;
};
export interface ChangeBriefInput {
    newModel: DesignModel;
    oldModel: DesignModel | null;
    project?: string;
    codeDir?: string;
    codeHits?: {
        hits: CodeHit[];
        scanned: number;
        truncated: boolean;
    };
    keywords: string[];
    staticPagePath?: string;
    specPath?: string;
}
export declare function renderChangeMarkdown(input: ChangeBriefInput): string;

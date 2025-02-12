/*
 * textEditUtils.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Language server command execution functionality.
 */

import { CancellationToken, TextEdit, WorkspaceEdit } from 'vscode-languageserver';

import { getFileInfo } from '../analyzer/analyzerNodeInfo';
import {
    getAllImportNames,
    getContainingImportStatement,
    getTextEditsForAutoImportInsertion,
    getTextEditsForAutoImportSymbolAddition,
    getTextRangeForImportNameDeletion,
    haveSameParentModule,
    ImportGroup,
    ImportNameInfo,
    ImportStatements,
    ModuleNameInfo,
} from '../analyzer/importStatementUtils';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import * as debug from '../common/debug';
import { FileEditAction, TextEditAction } from '../common/editAction';
import {
    ImportAsNode,
    ImportFromAsNode,
    ImportFromNode,
    ImportNode,
    ParseNode,
    ParseNodeType,
} from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';
import { appendArray, getOrAdd, removeArrayElements } from './collectionUtils';
import { isString } from './core';
import { convertOffsetToPosition, convertRangeToTextRange, convertTextRangeToRange } from './positionUtils';
import { doesRangeContain, doRangesIntersect, extendRange, Range, TextRange } from './textRange';
import { TextRangeCollection } from './textRangeCollection';

export function convertEditActionsToTextEdits(editActions: TextEditAction[]): TextEdit[] {
    return editActions.map((editAction) => ({
        range: editAction.range,
        newText: editAction.replacementText,
    }));
}

export function convertEditActionsToWorkspaceEdit(
    uri: string,
    editActions: TextEditAction[] | undefined
): WorkspaceEdit {
    if (!editActions) {
        return {};
    }

    const edits = convertEditActionsToTextEdits(editActions);

    return {
        changes: {
            [uri]: edits,
        },
    };
}

export function applyTextEditActions(text: string, edits: TextEditAction[], lines: TextRangeCollection<TextRange>) {
    const editsWithOffset = edits
        .map((e) => ({
            range: convertRangeToTextRange(e.range, lines) ?? { start: text.length, length: 0 },
            text: e.replacementText,
        }))
        .sort((e1, e2) => {
            const result = e2.range.start - e1.range.start;
            if (result !== 0) {
                return result;
            }

            return TextRange.getEnd(e2.range) - TextRange.getEnd(e1.range);
        });

    // Apply change in reverse order.
    let current = text;
    for (const change of editsWithOffset) {
        current = current.substr(0, change.range.start) + change.text + current.substr(TextRange.getEnd(change.range));
    }

    return current;
}

export class TextEditTracker {
    private readonly _nodesRemoved: Map<ParseNode, ParseResults> = new Map<ParseNode, ParseResults>();
    private readonly _results = new Map<string, FileEditAction[]>();

    private readonly _pendingNodeToRemove: NodeToRemove[] = [];

    constructor(private _mergeOnlyDuplications = true) {
        // Empty
    }

    addEdits(...edits: FileEditAction[]) {
        edits.forEach((e) => this.addEdit(e.filePath, e.range, e.replacementText));
    }

    addEdit(filePath: string, range: Range, replacementText: string) {
        const edits = getOrAdd(this._results, filePath, () => []);

        // If there is any overlapping edit, see whether we can merge edits.
        // We can merge edits, if one of them is 'deletion' or 2 edits has the same
        // replacement text with containing range.
        const overlappingEdits = this._getEditsToMerge(edits, range, replacementText);
        if (overlappingEdits.length > 0) {
            // Merge the given edit with the existing edits by
            // first deleting existing edits and expanding the current edit's range
            // to cover all existing edits.
            this._removeEdits(edits, overlappingEdits);
            extendRange(
                range,
                overlappingEdits.map((d) => d.range)
            );
        }

        edits.push({ filePath, range, replacementText });
    }

    addEditWithTextRange(parseResults: ParseResults, range: TextRange, replacementText: string) {
        const filePath = getFileInfo(parseResults.parseTree).filePath;

        const existing = parseResults.text.substr(range.start, range.length);
        if (existing === replacementText) {
            // No change. Return as it is.
            return;
        }

        this.addEdit(filePath, convertTextRangeToRange(range, parseResults.tokenizerOutput.lines), replacementText);
    }

    deleteImportName(parseResults: ParseResults, importToDelete: ImportFromAsNode | ImportAsNode) {
        // TODO: remove all these manual text handling and merge it to _processNodeRemoved that is
        //       used by remove unused imports.
        const imports: ImportFromAsNode[] | ImportAsNode[] =
            importToDelete.nodeType === ParseNodeType.ImportAs
                ? (importToDelete.parent as ImportNode).list
                : (importToDelete.parent as ImportFromNode).imports;

        const filePath = getFileInfo(parseResults.parseTree).filePath;
        const ranges = getTextRangeForImportNameDeletion(
            imports,
            imports.findIndex((v) => v === importToDelete)
        );

        ranges.forEach((r) => this.addEditWithTextRange(parseResults, r, ''));

        this._markNodeRemoved(importToDelete, parseResults);

        // Check whether we have deleted all trailing import names.
        // If either no trailing import is deleted or handled properly
        // then, there is nothing to do. otherwise, either delete the whole statement
        // or remove trailing comma.
        // ex) from x import [y], z or from x import y[, z]
        let lastImportIndexNotDeleted = 0;
        for (
            lastImportIndexNotDeleted = imports.length - 1;
            lastImportIndexNotDeleted >= 0;
            lastImportIndexNotDeleted--
        ) {
            if (!this._nodesRemoved.has(imports[lastImportIndexNotDeleted])) {
                break;
            }
        }

        if (lastImportIndexNotDeleted === -1) {
            // Whole statement is deleted. Remove the statement itself.
            // ex) [from x import a, b, c] or [import a]
            const importStatement = importToDelete.parent;
            if (importStatement) {
                this.addEdit(filePath, ParseTreeUtils.getFullStatementRange(importStatement, parseResults), '');
            }
        } else if (lastImportIndexNotDeleted >= 0 && lastImportIndexNotDeleted < imports.length - 2) {
            // We need to delete trailing comma
            // ex) from x import a, [b, c]
            const start = TextRange.getEnd(imports[lastImportIndexNotDeleted]);
            const length = TextRange.getEnd(imports[lastImportIndexNotDeleted + 1]) - start;
            this.addEditWithTextRange(parseResults, { start, length }, '');
        }
    }

    addOrUpdateImport(
        parseResults: ParseResults,
        importStatements: ImportStatements,
        moduleNameInfo: ModuleNameInfo,
        importGroup: ImportGroup,
        importNameInfo?: ImportNameInfo[],
        updateOptions?: {
            currentFromImport: ImportFromNode;
            originalModuleName: string;
        }
    ): void {
        // TODO: remove all these manual text handling and merge it to _processNodeRemoved that is
        //       used by remove unused imports.
        if (
            importNameInfo &&
            this._tryUpdateImport(parseResults, importStatements, moduleNameInfo, importNameInfo, updateOptions)
        ) {
            return;
        }

        this._addImport(parseResults, importStatements, moduleNameInfo, importGroup, importNameInfo);
    }

    removeNodes(...nodes: { node: ParseNode; parseResults: ParseResults }[]) {
        this._pendingNodeToRemove.push(...nodes);
    }

    isNodeRemoved(node: ParseNode) {
        return this._nodesRemoved.has(node);
    }

    getEdits(token: CancellationToken) {
        this._processNodeRemoved(token);

        const edits: FileEditAction[] = [];
        this._results.forEach((v) => appendArray(edits, v));

        return edits;
    }

    private _addImport(
        parseResults: ParseResults,
        importStatements: ImportStatements,
        moduleNameInfo: ModuleNameInfo,
        importGroup: ImportGroup,
        importNameInfo?: ImportNameInfo[]
    ) {
        const filePath = getFileInfo(parseResults.parseTree).filePath;

        this.addEdits(
            ...getTextEditsForAutoImportInsertion(
                importNameInfo ?? [],
                moduleNameInfo,
                importStatements,
                importGroup,
                parseResults,
                convertOffsetToPosition(parseResults.parseTree.length, parseResults.tokenizerOutput.lines)
            ).map((e) => ({ filePath, range: e.range, replacementText: e.replacementText }))
        );
    }

    private _tryUpdateImport(
        parseResults: ParseResults,
        importStatements: ImportStatements,
        moduleNameInfo: ModuleNameInfo,
        importNameInfo: ImportNameInfo[],
        updateOptions?: UpdateOption
    ): boolean {
        if (!updateOptions) {
            return false;
        }

        // See whether we have existing from import statement for the same module
        // ex) from [|moduleName|] import subModule
        const imported = importStatements.orderedImports.find(
            (i) =>
                i.node.nodeType === ParseNodeType.ImportFrom &&
                (i.moduleName === moduleNameInfo.nameForImportFrom || i.moduleName === moduleNameInfo.name)
        );

        if (!imported || imported.node.nodeType !== ParseNodeType.ImportFrom || imported.node.isWildcardImport) {
            return false;
        }

        const filePath = getFileInfo(parseResults.parseTree).filePath;

        const edits = getTextEditsForAutoImportSymbolAddition(importNameInfo, imported, parseResults);
        if (imported.node !== updateOptions.currentFromImport) {
            // Add what we want to the existing "import from" statement as long as it is not the same import
            // node we are working on.
            // ex) from xxx import yyy <= we are working on here.
            //     from xxx import zzz <= but we found this.
            this.addEdits(...edits.map((e) => ({ filePath, range: e.range, replacementText: e.replacementText })));
            return true;
        }

        const moduleNames = updateOptions.originalModuleName.split('.');
        const newModuleNames = moduleNameInfo.name.split('.');

        if (!haveSameParentModule(moduleNames, newModuleNames)) {
            // Module has moved.
            return false;
        }

        // Check whether we can avoid creating a new statement. We can't just merge with existing one since
        // we could create invalid text edits (2 edits that change the same span, or invalid replacement text since
        // texts on the node has changed)
        if (importNameInfo.length !== 1 || edits.length !== 1) {
            return false;
        }

        const deletions = this._getDeletionsForSpan(filePath, edits[0].range);
        if (deletions.length === 0) {
            this.addEdit(filePath, edits[0].range, edits[0].replacementText);
            return true;
        }

        const lastModuleName = moduleNames[moduleNames.length - 1];
        const newLastModuleName = newModuleNames[newModuleNames.length - 1];

        const alias = importNameInfo[0].alias === newLastModuleName ? lastModuleName : importNameInfo[0].alias;
        const importName = updateOptions.currentFromImport.imports.find(
            (i) => i.name.value === lastModuleName && i.alias?.value === alias
        );

        if (!importName) {
            return false;
        }

        this._removeEdits(filePath, deletions);
        if (importName.alias) {
            this._nodesRemoved.delete(importName.alias);
        }

        this.addEdit(
            filePath,
            convertTextRangeToRange(importName.name, parseResults.tokenizerOutput.lines),
            newLastModuleName
        );

        return true;
    }

    private _getDeletionsForSpan(filePathOrEdit: string | FileEditAction[], range: Range) {
        const edits = this._getOverlappingForSpan(filePathOrEdit, range);
        return edits.filter((e) => e.replacementText === '');
    }

    private _removeEdits(filePathOrEdit: string | FileEditAction[], edits: FileEditAction[]) {
        if (isString(filePathOrEdit)) {
            filePathOrEdit = this._results.get(filePathOrEdit) ?? [];
        }

        removeArrayElements(filePathOrEdit, (f) => edits.some((e) => FileEditAction.areEqual(f, e)));
    }

    private _getEditsToMerge(edits: FileEditAction[], range: Range, replacementText: string) {
        const overlappingEdits = this._getOverlappingForSpan(edits, range);
        if (this._mergeOnlyDuplications && overlappingEdits.length > 0) {
            // Merge duplicated deletion. For deletion, we can even merge edits
            // intersecting each other.
            if (replacementText === '') {
                return overlappingEdits.filter((e) => e.replacementText === '');
            }

            // Merge duplicated edits as long as one of them contains the other.
            return overlappingEdits.filter(
                (e) =>
                    e.replacementText === replacementText &&
                    (doesRangeContain(range, e.range) || doesRangeContain(e.range, range))
            );
        }

        // We are allowed to merge more than exact duplication. If the existing edit
        // is deletion or duplicated text with containing ranges, merge them to 1.
        return overlappingEdits.filter(
            (e) =>
                e.replacementText === '' ||
                (e.replacementText === replacementText &&
                    (doesRangeContain(range, e.range) || doesRangeContain(e.range, range)))
        );
    }

    private _getOverlappingForSpan(filePathOrEdit: string | FileEditAction[], range: Range) {
        if (isString(filePathOrEdit)) {
            filePathOrEdit = this._results.get(filePathOrEdit) ?? [];
        }

        return filePathOrEdit.filter((e) => doRangesIntersect(e.range, range));
    }

    private _processNodeRemoved(token: CancellationToken) {
        while (this._pendingNodeToRemove.length > 0) {
            const numberOfNodesBeforeProcessing = this._pendingNodeToRemove.length;

            const peekNodeToRemove = this._pendingNodeToRemove[this._pendingNodeToRemove.length - 1];
            this._handleImportNameNode(peekNodeToRemove, token);

            if (this._pendingNodeToRemove.length === numberOfNodesBeforeProcessing) {
                // It looks like we don't know how to handle the node,
                // Please add code to handle the case.
                debug.assert(`please add handler for ${peekNodeToRemove.node.nodeType}`);

                // As a default behavior, we will just remove the node
                this._pendingNodeToRemove.pop();

                const info = getFileInfo(peekNodeToRemove.parseResults.parseTree);
                this.addEdit(info.filePath, convertTextRangeToRange(peekNodeToRemove.node, info.lines), '');
            }
        }
    }

    private _handleImportNameNode(nodeToRemove: NodeToRemove, token: CancellationToken) {
        const node = nodeToRemove.node;
        if (node.nodeType !== ParseNodeType.Name) {
            return false;
        }

        const module = nodeToRemove.parseResults.parseTree;
        const info = getFileInfo(module);
        const importNode = getContainingImportStatement(ParseTreeUtils.findNodeByOffset(module, node.start), token);
        if (!importNode) {
            return false;
        }

        const nameNodes = getAllImportNames(importNode);

        // check various different cases
        // 1. check whether all imported names in the import statement is not used.
        const nodesRemoved = this._pendingNodeToRemove.filter((nodeToRemove) =>
            nameNodes.some((n) => TextRange.overlapsRange(nodeToRemove.node, n))
        );

        if (nameNodes.length === nodesRemoved.length) {
            this.addEdit(
                info.filePath,
                ParseTreeUtils.getFullStatementRange(importNode, nodeToRemove.parseResults),
                ''
            );

            // Remove nodes that are handled from queue.
            this._removeNodesHandled(nodesRemoved);
            return true;
        }

        // 2. some of modules in the import statement is used.
        const indices: number[] = [];
        for (let i = 0; i < nameNodes.length; i++) {
            const nameNode = nameNodes[i];

            if (nodesRemoved.some((r) => TextRange.overlapsRange(r.node, nameNode))) {
                indices.push(i);
            }
        }

        if (indices.length === 0) {
            // can't find module user wants to remove
            return false;
        }

        const editSpans = getTextRangeForImportNameDeletion(nameNodes, ...indices);
        editSpans.forEach((e) => this.addEdit(info.filePath, convertTextRangeToRange(e, info.lines), ''));

        this._removeNodesHandled(nodesRemoved);
        return true;
    }

    private _removeNodesHandled(nodesRemoved: NodeToRemove[]) {
        nodesRemoved.forEach((n) => this._markNodeRemoved(n.node, n.parseResults));
        removeArrayElements(this._pendingNodeToRemove, (n) => this._nodesRemoved.has(n.node));
    }

    private _markNodeRemoved(nodeToDelete: ParseNode, parseResults: ParseResults) {
        // Mark that we don't need to process these node again later.
        this._nodesRemoved.set(nodeToDelete, parseResults);
        if (nodeToDelete.nodeType === ParseNodeType.ImportAs) {
            this._nodesRemoved.set(nodeToDelete.module, parseResults);
            nodeToDelete.module.nameParts.forEach((n) => this._nodesRemoved.set(n, parseResults));
            if (nodeToDelete.alias) {
                this._nodesRemoved.set(nodeToDelete.alias, parseResults);
            }
        } else if (nodeToDelete.nodeType === ParseNodeType.ImportFromAs) {
            this._nodesRemoved.set(nodeToDelete.name, parseResults);
            if (nodeToDelete.alias) {
                this._nodesRemoved.set(nodeToDelete.alias, parseResults);
            }
        }
    }
}

interface UpdateOption {
    currentFromImport: ImportFromNode;
    originalModuleName: string;
}

interface NodeToRemove {
    node: ParseNode;
    parseResults: ParseResults;
}

/**
 * @fileoverview Model selection command for Mutsumi notebook.
 * @module notebook/commands/selectModel
 */

import * as vscode from 'vscode';
import { normalizeReasoningEffort, REASONING_EFFORT_SETTING_VALUES } from '../../agent/types';
import type { ReasoningEffortSetting } from '../../agent/types';
import { getModelsConfig } from '../../utils';
import { t } from '../../i18n';

/** QuickPick item representing a configured model. */
interface ModelQuickPickItem extends vscode.QuickPickItem {
    itemType: 'model';
    value: string;
    provider: string;
}

/** QuickPick item representing a reasoning effort setting. */
interface ReasoningEffortQuickPickItem extends vscode.QuickPickItem {
    itemType: 'reasoningEffort';
    value: ReasoningEffortSetting;
}

/** Section separator used by the combined model and reasoning effort picker. */
interface SeparatorQuickPickItem extends vscode.QuickPickItem {
    itemType: 'separator';
    kind: vscode.QuickPickItemKind.Separator;
}

type SelectModelQuickPickItem = ModelQuickPickItem | ReasoningEffortQuickPickItem | SeparatorQuickPickItem;

/** Human-readable descriptions for concrete reasoning effort levels. */
const reasoningEffortDescriptions: Readonly<Record<Exclude<ReasoningEffortSetting, 'default'>, string>> = {
    off: t('selectModel.effort.off'),
    minimal: t('selectModel.effort.minimal'),
    low: t('selectModel.effort.low'),
    medium: t('selectModel.effort.medium'),
    high: t('selectModel.effort.high'),
    xhigh: t('selectModel.effort.xhigh'),
    max: t('selectModel.effort.max')
};

/**
 * Register the select model command.
 * @param {vscode.ExtensionContext} context - Extension context for registering disposables
 */
export function registerSelectModelCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.selectModel', async () => {
            const editor = vscode.window.activeNotebookEditor;
            if (!editor) {
                vscode.window.showWarningMessage(t('notebook.noEditor'));
                return;
            }

            if (editor.notebook.notebookType !== 'mutsumi-notebook') {
                vscode.window.showWarningMessage(t('notebook.onlyMutsumi'));
                return;
            }
            
            const modelsConfig = getModelsConfig();
            const providerEntries = Object.entries(modelsConfig);
            
            const currentModel = editor.notebook.metadata?.model;
            const currentProvider = editor.notebook.metadata?.provider;
            const effectiveReasoningEffort = normalizeReasoningEffort(
                editor.notebook.metadata?.reasoning_effort
            ) ?? 'default';

            const modelItems: SelectModelQuickPickItem[] = [];
            let legacyMatched = false;
            for (const [providerName, modelNames] of providerEntries) {
                if (!Array.isArray(modelNames) || modelNames.length === 0) {
                    continue;
                }
                modelItems.push({
                    itemType: 'separator',
                    label: providerName,
                    kind: vscode.QuickPickItemKind.Separator
                });
                for (const modelName of modelNames) {
                    // When provider is stored in metadata, match on both model and provider.
                    // For legacy notebooks without a provider field, fall back to
                    // first-occurrence match on model name only.
                    let isCurrent: boolean;
                    if (currentProvider) {
                        isCurrent = modelName === currentModel && providerName === currentProvider;
                    } else {
                        isCurrent = !legacyMatched && modelName === currentModel;
                        if (isCurrent) {
                            legacyMatched = true;
                        }
                    }
                    const detail = isCurrent ? '$(check) ' + t('selectModel.current') : undefined;
                    modelItems.push({
                        itemType: 'model',
                        value: modelName,
                        provider: providerName,
                        label: modelName,
                        detail,
                        picked: isCurrent
                    });
                }
            }
            
            if (modelItems.length === 0) {
                vscode.window.showErrorMessage(t('selectModel.noModels'));
                return;
            }

            const effortItems: ReasoningEffortQuickPickItem[] = REASONING_EFFORT_SETTING_VALUES.map(value => ({
                itemType: 'reasoningEffort',
                value,
                label: value === 'default' ? t('selectModel.effortDefault') : value,
                description: value === 'default'
                    ? t('selectModel.effortDefaultDesc')
                    : reasoningEffortDescriptions[value],
                detail: value === effectiveReasoningEffort ? '$(check) ' + t('selectModel.current') : undefined,
                picked: value === effectiveReasoningEffort
            }));

            const items: SelectModelQuickPickItem[] = [
                { itemType: 'separator', label: t('selectModel.separatorModels'), kind: vscode.QuickPickItemKind.Separator },
                ...modelItems,
                { itemType: 'separator', label: t('selectModel.separatorReasoning'), kind: vscode.QuickPickItemKind.Separator },
                ...effortItems
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: t(
                    'selectModel.placeHolder',
                    currentModel || 'default',
                    effectiveReasoningEffort === 'default' ? t('selectModel.effortDefault') : effectiveReasoningEffort
                )
            });

            if (!selected || selected.itemType === 'separator') {
                return;
            }

            // Use in-memory metadata as base to preserve unsaved changes.
            const newMetadata = { ...editor.notebook.metadata };
            if (selected.itemType === 'model') {
                newMetadata.model = selected.value;
                newMetadata.provider = selected.provider;
                delete newMetadata.reasoning_effort;
            } else if (selected.value === 'default') {
                delete newMetadata.reasoning_effort;
            } else {
                newMetadata.reasoning_effort = selected.value;
            }

            const edit = new vscode.WorkspaceEdit();
            const nbEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
            edit.set(editor.notebook.uri, [nbEdit]);
            await vscode.workspace.applyEdit(edit);

            if (selected.itemType === 'model') {
                vscode.window.showInformationMessage(
                    t('selectModel.modelChanged', selected.value)
                );
            } else {
                vscode.window.showInformationMessage(t('selectModel.effortChanged', selected.value));
            }
        })
    );
}

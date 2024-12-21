import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import csv from 'csv-parser';
import { stringify } from 'csv-stringify/sync';

export function activate(context: vscode.ExtensionContext) {
  // Command: Extract to ARB
  const extractToArbCommand = vscode.commands.registerCommand(
    'extension.extractToArb',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      let text = editor.document.getText(editor.selection);

      if (!text) {
        vscode.window.showErrorMessage('No text selected.');
        return;
      }

      text = text.replace(/^['"]|['"]$/g, ''); // Remove surrounding quotes

      // Detect placeholders
      const placeholderRegex = /{([^}]+)}/g;
      const placeholders: Record<string, any> = {};
      let match;
      while ((match = placeholderRegex.exec(text)) !== null) {
        placeholders[match[1]] = { type: 'String', fallback: null }; // Default fallback value
      }

      const fileName = path.basename(editor.document.fileName);
      const firstPhraseMatch = fileName.match(
        /^[a-zA-Z]+|(?<=_)[a-zA-Z]+|(?<=-)[a-zA-Z]+/
      );
      const firstPhrase = firstPhraseMatch
        ? firstPhraseMatch[0].toLowerCase()
        : 'default';

      let arbFolderPath = vscode.workspace
        .getConfiguration('extractStringsToArb')
        .get<string>('arbFolderPath');

      if (!arbFolderPath) {
        const arbFolder = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select ARB Folder',
        });

        if (!arbFolder || arbFolder.length === 0) {
          vscode.window.showErrorMessage('No folder selected.');
          return;
        }

        arbFolderPath = arbFolder[0].fsPath;

        await vscode.workspace
          .getConfiguration('extractStringsToArb')
          .update(
            'arbFolderPath',
            arbFolderPath,
            vscode.ConfigurationTarget.Workspace
          );
      }

      const arbFiles = fs
        .readdirSync(arbFolderPath)
        .filter((file) => file.endsWith('.arb'));
      if (arbFiles.length === 0) {
        vscode.window.showErrorMessage(
          'No ARB files found in the selected folder.'
        );
        return;
      }

      try {
        const sanitizedText = text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '');
        const defaultKey = `${firstPhrase}__${sanitizedText}`;
        const key = await vscode.window.showInputBox({
          prompt: 'Enter a key for the string',
          value: defaultKey,
        });
        if (!key) {
          vscode.window.showErrorMessage('Key is required to save the string.');
          return;
        }

        for (const arbFileName of arbFiles) {
          const arbFilePath = path.join(arbFolderPath, arbFileName);
          const targetLang = arbFileName
            .replace(/.*_/, '')
            .replace(/\.arb$/, '');

          let arbContent: Record<string, any> = {};
          try {
            if (fs.existsSync(arbFilePath)) {
              const existingContent = fs.readFileSync(arbFilePath, 'utf8');
              arbContent = JSON.parse(existingContent);
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Error reading ARB file (${arbFileName}): ${
                (error as Error).message
              }`
            );
            continue;
          }

          if (arbContent[key] || arbContent[`@${key}`]) {
            vscode.window.showErrorMessage(
              `Key already exists in ARB file: ${arbFileName}`
            );
            continue;
          }

          arbContent[key] = text;
          arbContent[`@${key}`] = {
            type: 'text',
            placeholders:
              Object.keys(placeholders).length > 0 ? placeholders : undefined,
          };

          try {
            fs.writeFileSync(
              arbFilePath,
              JSON.stringify(arbContent, null, 2),
              'utf8'
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Error writing to ARB file (${arbFileName}): ${
                (error as Error).message
              }`
            );
          }
        }

        vscode.window.showInformationMessage(
          'String extracted to all ARB files successfully.'
        );

        const edit = new vscode.WorkspaceEdit();
        edit.replace(editor.document.uri, editor.selection, `l10n.${key}`);
        await vscode.workspace.applyEdit(edit);

        const workspacePath =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
          vscode.window.showErrorMessage(
            'Workspace folder not found. Cannot run flutter gen-l10n.'
          );
          return;
        }

        exec(
          'flutter gen-l10n',
          { cwd: workspacePath },
          (error, stdout, stderr) => {
            if (error) {
              vscode.window.showErrorMessage(
                `Error running flutter gen-l10n: ${stderr}`
              );
            } else {
              vscode.window.showInformationMessage(
                'flutter gen-l10n executed successfully.'
              );
            }
          }
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          'Error processing ARB files: ' + (error as Error).message
        );
      }
    }
  );

  const contextMenuCommand = vscode.commands.registerCommand(
    'extension.extractToArbFromContextMenu',
    async () => {
      vscode.commands.executeCommand('extension.extractToArb');
    }
  );

  const clearArbPathCommand = vscode.commands.registerCommand(
    'extension.clearArbFolderPath',
    async () => {
      const config = vscode.workspace.getConfiguration('extractStringsToArb');

      await config.update(
        'arbFolderPath',
        undefined,
        vscode.ConfigurationTarget.Global
      );

      // Clear workspace-specific configuration
      await config.update(
        'arbFolderPath',
        undefined,
        vscode.ConfigurationTarget.Workspace
      );

      vscode.window.showInformationMessage(
        'ARB folder paths cleared. You will be prompted to select a folder again next time.'
      );
    }
  );

  context.subscriptions.push(clearArbPathCommand);

  // Command: Visualize ARB Files
  const visualizeArbFilesCommand = vscode.commands.registerCommand(
    'extension.visualizeArbFiles',
    async (fileUri: vscode.Uri) => {
      const folderPath = path.dirname(fileUri.fsPath);
      const arbFiles = fs
        .readdirSync(folderPath)
        .filter((file) => file.endsWith('.arb'));

      if (arbFiles.length === 0) {
        vscode.window.showErrorMessage(
          'No ARB files found in the selected folder.'
        );
        return;
      }

      const translations: Record<string, Record<string, string>> = {};
      const fileKeys = arbFiles.map((file) => path.basename(file, '.arb'));

      for (const file of arbFiles) {
        const fileKey = path.basename(file, '.arb');
        const filePath = path.join(folderPath, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const key of Object.keys(content)) {
          if (!key.startsWith('@')) {
            if (!translations[key]) {
              translations[key] = {};
            }
            translations[key][fileKey] = content[key]; // Use fileKey instead of file
          }
        }
      }

      const panel = vscode.window.createWebviewPanel(
        'arbEditor',
        'Edit ARB Files',
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = getWebviewContent(translations, fileKeys);

      panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
          case 'updateTranslation': {
            const { key, fileKey, value } = message;
            const arbFilePath = path.join(folderPath, `${fileKey}.arb`);

            try {
              const arbContent = JSON.parse(
                fs.readFileSync(arbFilePath, 'utf8')
              );

              // If the key doesn't exist, add it with a 'MISSING' value
              if (arbContent[key] === undefined) {
                arbContent[key] = 'MISSING'; // Default value if missing
                vscode.window.showInformationMessage(
                  `Key "${key}" added to ${fileKey}.arb`
                );
              }

              // Update the value of the key in the ARB file
              arbContent[key] = value.trim() || 'MISSING';

              fs.writeFileSync(
                arbFilePath,
                JSON.stringify(arbContent, null, 2),
                'utf8'
              );
              vscode.window.showInformationMessage(
                `Updated ${key} in ${fileKey}.arb`
              );

              // Refresh the Webview content after update
              const updatedTranslations: Record<
                string,
                Record<string, string>
              > = {};
              for (const file of arbFiles) {
                const fileKey = path.basename(file, '.arb');
                const filePath = path.join(folderPath, file);
                const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                for (const key of Object.keys(content)) {
                  if (!key.startsWith('@')) {
                    if (!updatedTranslations[key]) {
                      updatedTranslations[key] = {};
                    }
                    updatedTranslations[key][fileKey] = content[key];
                  }
                }
              }

              panel.webview.html = getWebviewContent(
                updatedTranslations,
                fileKeys
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Error updating ${fileKey}.arb: ${(error as Error).message}`
              );
            }
            break;
          }

          case 'addNewTranslation': {
            const { key: newKey, translations, metadata } = message;

            for (const fileKey of fileKeys) {
              const arbFilePath = path.join(folderPath, `${fileKey}.arb`);
              const arbContent = JSON.parse(
                fs.readFileSync(arbFilePath, 'utf8')
              );

              if (arbContent[newKey]) {
                vscode.window.showErrorMessage(
                  `Key "${newKey}" already exists in file "${fileKey}.arb".`
                );
                continue;
              }

              // Add the key-value pair and its metadata
              arbContent[newKey] = translations[fileKey] || 'MISSING';
              arbContent[`@${newKey}`] = metadata;

              fs.writeFileSync(
                arbFilePath,
                JSON.stringify(arbContent, null, 2),
                'utf8'
              );
            }

            vscode.window.showInformationMessage(
              `New key "${newKey}" with metadata added successfully.`
            );

            // Refresh the WebView content
            const updatedTranslations: Record<
              string,
              Record<string, string>
            > = {};
            for (const file of arbFiles) {
              const fileKey = path.basename(file, '.arb');
              const filePath = path.join(folderPath, file);
              const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              for (const key of Object.keys(content)) {
                if (!key.startsWith('@')) {
                  if (!updatedTranslations[key]) {
                    updatedTranslations[key] = {};
                  }
                  updatedTranslations[key][fileKey] = content[key];
                }
              }
            }

            panel.webview.html = getWebviewContent(
              updatedTranslations,
              fileKeys
            );
            break;
          }

          case 'exportToCSV':
            const csvFilePath = path.join(folderPath, 'translations.csv');
            exportToCSV(translations, fileKeys, csvFilePath);
            vscode.window.showInformationMessage(
              `CSV exported to ${csvFilePath}`
            );
            break;

          case 'importFromCSV':
            const csvFileUri = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { 'CSV Files': ['csv'] },
              openLabel: 'Select CSV File to Import',
            });

            if (!csvFileUri) {
              vscode.window.showErrorMessage('No CSV file selected.');
              return;
            }

            importFromCSV(csvFileUri[0].fsPath, folderPath, arbFiles, () => {
              // Refresh the webview content
              const updatedTranslations: Record<
                string,
                Record<string, string>
              > = {};
              for (const file of arbFiles) {
                const fileKey = path.basename(file, '.arb');
                const filePath = path.join(folderPath, file);
                const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                for (const key of Object.keys(content)) {
                  if (!key.startsWith('@')) {
                    if (!updatedTranslations[key]) {
                      updatedTranslations[key] = {};
                    }
                    updatedTranslations[key][fileKey] = content[key];
                  }
                }
              }

              panel.webview.html = getWebviewContent(
                updatedTranslations,
                fileKeys
              );
            });

            vscode.window.showInformationMessage('CSV imported successfully.');
            break;

          default:
            break;
        }
      });

      panel.onDidDispose(() => {
        // Regenerate content when reactivated.
        panel.webview.html = getWebviewContent(translations, fileKeys);
      });

      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          const updatedTranslations: Record<
            string,
            Record<string, string>
          > = {};
          for (const file of arbFiles) {
            const fileKey = path.basename(file, '.arb');
            const filePath = path.join(folderPath, file);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const key of Object.keys(content)) {
              if (!key.startsWith('@')) {
                if (!updatedTranslations[key]) {
                  updatedTranslations[key] = {};
                }
                updatedTranslations[key][fileKey] = content[key];
              }
            }
          }
          panel.webview.html = getWebviewContent(updatedTranslations, fileKeys);
        }
      });
    }
  );

  context.subscriptions.push(extractToArbCommand);
  context.subscriptions.push(contextMenuCommand);
  context.subscriptions.push(visualizeArbFilesCommand);
}

function getWebviewContent(
  translations: Record<string, Record<string, string>>,
  fileKeys: string[]
) {
  const headers = fileKeys.map((fileKey) => `<th>${fileKey}</th>`).join('');
  const rows = Object.entries(translations)
    .map(([key, values]) => {
      const cells = fileKeys
        .map((fileKey) => {
          const value = values[fileKey] || 'MISSING';
          const cellStyle =
            value === 'MISSING' ? 'style="background-color: red;"' : '';
          return `<td contenteditable ${cellStyle} data-key="${key}" data-file="${fileKey}">${value}</td>`;
        })
        .join('');
      return `<tr><td>${key}</td>${cells}</tr>`;
    })
    .join('');

  return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <title>Edit ARB Files</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #040404;
                }
                tr:nth-child(even) {
                    background-color: #1d2129;
                }
                input {
                    background: #333;
                    color: #fff;
                    border: 1px solid #444;
                    padding: 4px 8px;
                }
                button {
                    background: #f0f0f0;
                    border-radius: 50px;
                    padding: 4px 12px;
                    margin-right: 5px;
                }
                .sticky-controls {
                    position: sticky;
                    top: 0;
                    background-color: #222;
                    z-index: 1000;
                    padding: 10px;
                    box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.1);
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                }
                .hidden {
                    display: none;
                }
                .smooth {
                    transition: all 0.3s ease;
                }
            </style>
        </head>
        <body>
            <div class="sticky-controls">
                <div id="defaultButtons">
                    <button id="addRow">Add Row</button>
                    <button id="export">Export to CSV</button>
                    <button id="import">Import from CSV</button>
                </div>
                <div id="newRowFields" class="hidden smooth">
                    <input id="newKey" type="text" placeholder="New Key" />
                    ${fileKeys
                      .map(
                        (fileKey) =>
                          `<input data-file="${fileKey}" placeholder="${fileKey}" />`
                      )
                      .join('')}
                    <button id="saveRow">Save</button>
                    <button id="cancelRow">Cancel</button>
                </div>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Key</th>${headers}
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <script>
                const vscode = acquireVsCodeApi();

                const addRowButton = document.getElementById('addRow');
                const saveRowButton = document.getElementById('saveRow');
                const cancelRowButton = document.getElementById('cancelRow');
                const defaultButtons = document.getElementById('defaultButtons');
                const newRowFields = document.getElementById('newRowFields');

                addRowButton.addEventListener('click', () => {
                    defaultButtons.classList.add('hidden');
                    newRowFields.classList.remove('hidden');
                });

                saveRowButton.addEventListener('click', () => {
                    const newKey = document.getElementById('newKey').value.trim();
                    if (!newKey) {
                        alert('Key is required.');
                        return;
                    }

                    const newTranslations = {};
                    document
                        .querySelectorAll('#newRowFields input[data-file]')
                        .forEach((input) => {
                            newTranslations[input.dataset.file] =
                                input.value.trim() || 'MISSING';
                        });

                    vscode.postMessage({
                        command: 'addNewTranslation',
                        key: newKey,
                        translations: newTranslations,
                        metadata: { type: 'text' },
                    });

                    document.getElementById('newKey').value = '';
                    document
                        .querySelectorAll('#newRowFields input[data-file]')
                        .forEach((input) => {
                            input.value = '';
                        });

                    newRowFields.classList.add('hidden');
                    defaultButtons.classList.remove('hidden');
                });

                cancelRowButton.addEventListener('click', () => {
                    newRowFields.classList.add('hidden');
                    defaultButtons.classList.remove('hidden');
                });

                document.querySelectorAll('td[contenteditable]').forEach(cell => {
                    cell.addEventListener('blur', (event) => {
                        const key = event.target.getAttribute('data-key');
                        const file = event.target.getAttribute('data-file');
                        const newValue = event.target.innerText.trim();

                        // Send updated value to the extension
                        vscode.postMessage({
                            command: 'updateTranslation',
                            key: key,
                            fileKey: file,
                            value: newValue
                        });
                    });
                });

                document.getElementById('export').addEventListener('click', () => {
                    vscode.postMessage({ command: 'exportToCSV' });
                });

                document.getElementById('import').addEventListener('click', () => {
                    vscode.postMessage({ command: 'importFromCSV' });
                });
            </script>
        </body>
        </html>
    `;
}

function exportToCSV(
  translations: Record<string, Record<string, string>>,
  fileKeys: string[],
  csvFilePath: string
) {
  const rows = Object.entries(translations).map(([key, values]) => {
    const row = [key];
    for (const fileKey of fileKeys) {
      row.push(values[fileKey] || 'MISSING');
    }
    return row;
  });

  const output = stringify([['Key', ...fileKeys], ...rows]);
  fs.writeFileSync(csvFilePath, output, 'utf8');
}

function importFromCSV(
  csvFilePath: string,
  folderPath: string,
  arbFiles: string[],
  postImportCallback: () => void // Add a callback to refresh the webview
) {
  const fileKeys = arbFiles.map((file) => path.basename(file, '.arb'));
  const translations: Record<string, Record<string, string>> = {};

  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row: any) => {
      const key = row.Key;
      fileKeys.forEach((fileKey) => {
        if (!translations[key]) {
          translations[key] = {};
        }
        translations[key][`${fileKey}.arb`] = row[fileKey];
      });
    })
    .on('end', () => {
      for (const file of arbFiles) {
        const filePath = path.join(folderPath, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const key in translations) {
          if (translations[key][file]) {
            content[key] = translations[key][file];
          }
        }
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
      }

      // Callback to refresh the webview
      postImportCallback();
    });
}

export function deactivate() {}

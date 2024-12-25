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

  const setupFlutterLocalizations = vscode.commands.registerCommand(
    'extension.setupFlutterLocalization',
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage(
          'Please open a workspace folder to use this extension.'
        );
        return;
      }

      const rootPath = workspaceFolders[0].uri.fsPath;

      // 1. Add flutter_localizations dependency and generate: true to pubspec.yaml
      const pubspecPath = path.join(rootPath, 'pubspec.yaml');
      if (fs.existsSync(pubspecPath)) {
        let pubspecContent = fs.readFileSync(pubspecPath, 'utf8');

        // Add flutter_localizations if not exists
        if (!pubspecContent.includes('flutter_localizations')) {
          pubspecContent = pubspecContent.replace(
            /dependencies:\s*\n/,
            'dependencies:\n  flutter_localizations:\n    sdk: flutter\n'
          );
          vscode.window.showInformationMessage(
            'Added flutter_localizations to pubspec.yaml.'
          );
        }

        // Add generate: true under the main flutter: section
        if (!pubspecContent.includes('generate: true')) {
          // Find the main flutter: section (usually contains assets, fonts, etc.)
          const flutterSectionMatch = pubspecContent.match(
            /^flutter:(?:\s*\n(?:\s+.*\n)*)/m
          );

          if (flutterSectionMatch) {
            // Get the indentation level of the flutter: section
            const flutterSection = flutterSectionMatch[0];
            const indentation = '  '; // Standard YAML indentation

            // Check if the section is empty or only has whitespace
            if (flutterSection.trim() === 'flutter:') {
              // If empty, just add generate: true
              pubspecContent = pubspecContent.replace(
                /^flutter:\s*$/m,
                `flutter:\n${indentation}generate: true`
              );
            } else {
              // If not empty, add generate: true as the first item under flutter:
              pubspecContent = pubspecContent.replace(
                /^flutter:\s*\n/m,
                `flutter:\n${indentation}generate: true\n`
              );
            }

            vscode.window.showInformationMessage(
              'Added generate: true to pubspec.yaml under flutter section.'
            );
          } else {
            // If flutter: section doesn't exist, add it
            pubspecContent += '\nflutter:\n  generate: true\n';
            vscode.window.showInformationMessage(
              'Created flutter section with generate: true in pubspec.yaml.'
            );
          }
        }

        fs.writeFileSync(pubspecPath, pubspecContent, 'utf8');
      } else {
        vscode.window.showErrorMessage('pubspec.yaml not found.');
        return;
      }

      // 2. Create l10n.yaml file
      const l10nPath = path.join(rootPath, 'l10n.yaml');
      if (!fs.existsSync(l10nPath)) {
        const l10nContent = `
arb-dir: lib/l10n
template-arb-file: app_en.arb
output-localization-file: app_localizations.dart
`;
        fs.writeFileSync(l10nPath, l10nContent.trim(), 'utf8');
        vscode.window.showInformationMessage('Created l10n.yaml file.');
      }

      // 3. Create lib/l10n/app_en.arb file
      const l10nDir = path.join(rootPath, 'lib', 'l10n');
      if (!fs.existsSync(l10nDir)) {
        fs.mkdirSync(l10nDir, { recursive: true });
      }
      const arbFilePath = path.join(l10nDir, 'app_en.arb');
      if (!fs.existsSync(arbFilePath)) {
        const arbContent = `
{
  "@@locale": "en",
  "hello": "Hello",
  "@hello": {
    "type": "text"
  }
}`;
        fs.writeFileSync(arbFilePath, arbContent.trim(), 'utf8');
        vscode.window.showInformationMessage(
          'Created app_en.arb file in lib/l10n.'
        );
      }

      // 4. Create l10n extension file
      const extensionDir = path.join(l10nDir, 'extension');
      if (!fs.existsSync(extensionDir)) {
        fs.mkdirSync(extensionDir, { recursive: true });
      }

      const l10nExtensionPath = path.join(
        extensionDir,
        'l10n_build_context_extension.dart'
      );
      const extensionContent = `
import 'package:flutter/widgets.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';

extension L10nContextExtension on BuildContext {
  AppLocalizations get localizations => AppLocalizations.of(this)!;
}`;

      fs.writeFileSync(l10nExtensionPath, extensionContent.trim(), 'utf8');
      vscode.window.showInformationMessage(
        'Created l10n BuildContext extension file.'
      );

      // New function to update MaterialApp configuration
      await updateMaterialAppConfiguration(rootPath);

      vscode.window.showInformationMessage(
        'Flutter localization setup completed!'
      );
    }
  );

  async function updateMaterialAppConfiguration(rootPath: string) {
    try {
      const libDir = path.join(rootPath, 'lib');

      // Get main.dart or main_*.dart files
      const mainFiles = fs
        .readdirSync(libDir)
        .filter((file) => file === 'main.dart' || file.startsWith('main_'))
        .map((file) => path.join(libDir, file));

      if (mainFiles.length === 0) {
        vscode.window.showWarningMessage(
          'No main.dart or main_*.dart files found in lib directory.'
        );
        return;
      }

      for (const file of mainFiles) {
        let content = fs.readFileSync(file, 'utf8');

        // Skip if neither MaterialApp nor MaterialApp.router is present
        if (
          !content.includes('MaterialApp(') &&
          !content.includes('MaterialApp.router(')
        ) {
          continue;
        }

        let updatedContent = content;
        let needsUpdate = false;

        // Regex to find MaterialApp or MaterialApp.router and insert localizationsDelegates after the opening parenthesis
        const materialAppRegex = /(MaterialApp(?:\.router)?\s*\()/g;
        updatedContent = updatedContent.replace(materialAppRegex, (match) => {
          // Only add localizationsDelegates if it's not already present
          if (!content.includes('localizationsDelegates:')) {
            needsUpdate = true;
            return `${match}\n      localizationsDelegates: AppLocalizations.localizationsDelegates,`;
          }
          return match;
        });

        // Add the necessary import if missing
        const importStatement =
          "import 'package:flutter_gen/gen_l10n/app_localizations.dart';";
        if (needsUpdate && !content.includes(importStatement)) {
          const lastImportIndex = content.lastIndexOf("import '");
          const endOfLastImport = content.indexOf('\n', lastImportIndex) + 1;
          updatedContent =
            updatedContent.slice(0, endOfLastImport) +
            `${importStatement}\n` +
            updatedContent.slice(endOfLastImport);
        }

        // Write the updated content if changes were made
        if (content !== updatedContent) {
          fs.writeFileSync(file, updatedContent, 'utf8');
          vscode.window.showInformationMessage(
            `Updated MaterialApp configuration in ${path.basename(file)}`
          );
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error updating MaterialApp configuration: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  context.subscriptions.push(setupFlutterLocalizations);
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

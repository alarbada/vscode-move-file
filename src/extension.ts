import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

interface FolderPickItem extends vscode.QuickPickItem {
  fullPath: string // Store the absolute path here
}

async function getAllFoldersInWorkspace(): Promise<string[]> {
  const allFolders: Set<string> = new Set()
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders) {
    return []
  }

  const excludedFolders = new Set([
    'node_modules',
    '.git',
    '.vscode',
    'out',
    'dist',
    '.next',
    '__pycache__',
  ])

  async function findFoldersRecursive(dir: string) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (excludedFolders.has(entry.name)) {
            continue
          }
          const fullPath = path.join(dir, entry.name)
          allFolders.add(fullPath)
          await findFoldersRecursive(fullPath)
        }
      }
    } catch (err) {
      // console.warn(`Error reading directory ${dir}:`, err); // Log for debugging if needed
      // Silently ignore errors like permission denied for simplicity
    }
  }

  for (const folder of workspaceFolders) {
    allFolders.add(folder.uri.fsPath) // Add the root workspace folder itself
    await findFoldersRecursive(folder.uri.fsPath)
  }

  return Array.from(allFolders).sort()
}

async function showSimpleFolderQuickPick(folders: string[]): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders || []
  const workspaceRootPaths = workspaceFolders.map((wf) => wf.uri.fsPath)

  const items: FolderPickItem[] = folders.map((folderPath) => {
    let displayLabel = folderPath // Default fallback if not in any workspace root
    const numWorkspaceRoots = workspaceFolders.length

    for (const rootPath of workspaceRootPaths) {
      if (folderPath.startsWith(rootPath)) {
        // Check if folderPath is under this rootPath
        const relative = path.relative(rootPath, folderPath)
        const rootName = path.basename(rootPath)

        if (relative === '') {
          // folderPath is a workspace root itself
          displayLabel = numWorkspaceRoots > 1 ? `${rootName}${path.sep}./` : './'
        } else {
          // folderPath is a subfolder of a workspace root
          displayLabel =
            numWorkspaceRoots > 1 ? `${rootName}${path.sep}./${relative}` : `./${relative}`
        }
        break // Found the corresponding workspace root, so break from loop
      }
    }

    return {
      label: displayLabel,
      description: undefined,
      detail: undefined,
      fullPath: folderPath,
    }
  })

  const selectedItem = await vscode.window.showQuickPick<FolderPickItem>(items, {
    placeHolder: 'Select destination folder (fuzzy search on path/name)',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true, // Keep open even if focus shifts briefly
  })

  return selectedItem ? selectedItem.fullPath : undefined
}

async function moveFileCore(sourcePath: string, targetPath: string): Promise<void> {
  if (sourcePath === targetPath) {
    vscode.window.showInformationMessage('Source and target are the same. No move needed.')
    return
  }

  // Ensure the file is saved
  const uri = vscode.Uri.file(sourcePath)
  const document = await vscode.workspace.openTextDocument(uri)
  if (document.isDirty) {
    await document.save()
  }

  // Close the document if it's open in any visible editor
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.fsPath === sourcePath) {
      // workbench.action.closeActiveEditor might not be the one we want if multiple groups.
      // A safer way is to show the document and then close.
      await vscode.window.showTextDocument(editor.document, editor.viewColumn)
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      // Wait a brief moment for the close operation to complete
      await new Promise((resolve) => setTimeout(resolve, 100))
      break
    }
  }

  // Ensure target directory exists. This should be guaranteed by picker, but good practice
  const targetDir = path.dirname(targetPath)
  try {
    await fs.promises.mkdir(targetDir, { recursive: true })
  } catch (error) {
    // If mkdir fails (e.g. permission issue), rename will likely fail too.
    // We log it but proceed, as rename might handle some cases or provide a better error.
    console.warn(`Could not ensure target directory ${targetDir} exists:`, error)
  }

  // Move the file
  await fs.promises.rename(sourcePath, targetPath)
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('moveFile.move', async () => {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active file to move.')
      return
    }

    const currentFilePath = activeEditor.document.uri.fsPath
    const currentFileName = path.basename(currentFilePath)
    // const currentDir = path.dirname(currentFilePath);

    try {
      const allFolders = await getAllFoldersInWorkspace()
      if (allFolders.length === 0) {
        vscode.window.showInformationMessage(
          'No suitable folders found in the workspace to move the file to.',
        )
        return
      }

      const targetFolder = await showSimpleFolderQuickPick(allFolders)
      if (!targetFolder) {
        // User cancelled QuickPick
        return
      }

      const targetPath = path.join(targetFolder, currentFileName)

      // Prevent moving a file into itself or its current containing folder if name is same
      if (currentFilePath === targetPath) {
        vscode.window.showInformationMessage('File is already in the selected destination folder.')
        return
      }

      await moveFileCore(currentFilePath, targetPath)

      const newDocumentUri = vscode.Uri.file(targetPath)
      await vscode.workspace.openTextDocument(newDocumentUri)
      await vscode.window.showTextDocument(newDocumentUri)

      vscode.window.showInformationMessage(`Moved '${currentFileName}' to '${targetFolder}'.`)
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error moving file: ${error instanceof Error ? error.message : String(error)}`,
      )
      console.error('Error moving file:', error)
    }
  })

  context.subscriptions.push(disposable)
}

export function deactivate() {}

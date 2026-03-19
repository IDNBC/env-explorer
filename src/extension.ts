import * as vscode from 'vscode';
import { exec, ExecException } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface PythonQuickPickItem extends vscode.QuickPickItem {
    description: string;
}

// 簡易多言語リソース
const locale = vscode.env.language;
const i18n = {
    ja: {
        selectPy: "ステップ 1: 使用するPythonバージョンを選択",
        inputName: "ステップ 2: 仮想環境のフォルダ名を入力",
        exists: "は既に存在します。別の名前を入力するか削除してください。",
        creating: "を作成中...",
        success: "仮想環境が作成されました！",
        failed: "作成に失敗しました: ",
        confirmDel: "件のパッケージを削除しますか？",
        restoring: "パッケージを復元中...",
        restoreSuccess: "パッケージを復元しました。"
    },
    en: {
        selectPy: "Step 1: Select Python version",
        inputName: "Step 2: Enter virtual environment folder name",
        exists: " already exists. Use a different name or delete it.",
        creating: "Creating ",
        success: "Virtual environment created!",
        failed: "Failed to create: ",
        confirmDel: "Uninstall selected packages?",
        restoring: "Restoring packages...",
        restoreSuccess: "Packages restored successfully."
    }
}[locale.startsWith('ja') ? 'ja' : 'en'];

export function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
    const scriptPath = path.join(context.extensionPath, 'inspect_env.py');

    const provider = new EnvDataProvider(workspaceRoot, scriptPath);
    const treeView = vscode.window.createTreeView('envExplorer', { treeDataProvider: provider, canSelectMany: true });


    // --- ここから追加：自動監視機能 ---
    if (workspaceRoot) {
        // フォルダの作成や削除を監視
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '*')
        );

        // フォルダが変わったらリストを更新
        watcher.onDidCreate(() => provider.refresh());
        watcher.onDidDelete(() => provider.refresh());
        watcher.onDidChange(() => provider.refresh());

        context.subscriptions.push(watcher);
    }

    const DELETED_STACK_KEY = 'deletedPackageStack';

    // 1. リフレッシュ
    vscode.commands.registerCommand('env-explorer.refresh', async () => await provider.refresh());

    // 2. 仮想環境作成 (名前入力 + エラー修正版)
    vscode.commands.registerCommand('env-explorer.createVenv', async () => {
        if (!workspaceRoot) return;

        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) return;
        const api: any = pythonExtension.isActive ? pythonExtension.exports : await pythonExtension.activate();
        const envs = api.environments.known;

        const items: PythonQuickPickItem[] = envs.map((e: any) => ({
            label: e.version ? `Python ${e.version.major}.${e.version.minor}` : "Unknown Python",
            description: e.executable.uri.fsPath
        }));

        const selectedPython = await vscode.window.showQuickPick(items, { title: i18n.selectPy });
        if (!selectedPython) return;

        const venvName = await vscode.window.showInputBox({
            prompt: i18n.inputName,
            value: ".venv",
            placeHolder: ".venv"
        });
        if (!venvName) return;

        const venvPath = path.join(workspaceRoot, venvName);
        if (fs.existsSync(venvPath)) {
            vscode.window.showErrorMessage(`'${venvName}' ${i18n.exists}`);
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${i18n.creating} ${venvName}...`,
        }, async () => {
            return new Promise((resolve) => {
                // Windowsのエラー回避のため、引用符の扱いを変更
                // shell: true を使用し、コマンド全体を一つの文字列として渡す
                const cmd = `"${selectedPython.description}" -m venv "${venvName}"`;
                exec(cmd, { cwd: workspaceRoot, shell: 'cmd.exe' }, async (err: ExecException | null, stdout, stderr) => {
                    if (err) {
                        vscode.window.showErrorMessage(`${i18n.failed} ${stderr || err.message}`);
                    } else {
                        vscode.window.showInformationMessage(`'${venvName}' ${i18n.success}`);
                        // 確実に反映させるために少し待機してからリフレッシュ（Windowsのファイル同期待ち）
                        setTimeout(() => provider.refresh(), 500);
                    }
                    resolve(null);
                });
            });
        });
    });

    // 3. アンインストール
    vscode.commands.registerCommand('env-explorer.bulkUninstall', async (clickedNode: PackageItem) => {
        const selectedNodes = treeView.selection.length > 0 ? treeView.selection : [clickedNode];
        const packagesToDelete = selectedNodes.filter(n => n.contextValue === 'packageItem');
        if (packagesToDelete.length === 0) return;

        const confirm = await vscode.window.showWarningMessage(`${packagesToDelete.length}${i18n.confirmDel}`, { modal: true }, 'OK');
        if (confirm !== 'OK') return;

        const installString = packagesToDelete.map(p => `${p.name}==${p.version}`).join(' ');
        let stack = context.globalState.get<string[]>(DELETED_STACK_KEY) || [];
        stack.push(installString);
        if (stack.length > 5) stack.shift(); 
        await context.globalState.update(DELETED_STACK_KEY, stack);
        vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', true);

        const pythonPath = packagesToDelete[0].envPath || 'python';

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Uninstalling..." }, () => {
            return new Promise((resolve) => {
                exec(`"${pythonPath}" -m pip uninstall ${packagesToDelete.map(p => p.name).join(' ')} -y`, { cwd: workspaceRoot }, async (err) => {
                    if (!err) {
                        await provider.refresh();
                    }
                    resolve(null);
                });
            });
        });
    });

    // 4. 復元
    vscode.commands.registerCommand('env-explorer.undoUninstall', async () => {
        let stack = context.globalState.get<string[]>(DELETED_STACK_KEY) || [];
        if (stack.length === 0) return;

        const installString = stack[stack.length - 1];
        const pythonPath = await provider.getActivePythonPath();
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: i18n.restoring,
        }, () => {
            return new Promise((resolve) => {
                exec(`"${pythonPath}" -m pip install ${installString}`, { cwd: workspaceRoot }, async (err) => {
                    if (!err) {
                        vscode.window.showInformationMessage(i18n.restoreSuccess);
                        stack.pop();
                        await context.globalState.update(DELETED_STACK_KEY, stack);
                        if (stack.length === 0) vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', false);
                        await provider.refresh();
                    }
                    resolve(null);
                });
            });
        });
    });

    const initialStack = context.globalState.get<string[]>(DELETED_STACK_KEY) || [];
    vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', initialStack.length > 0);
}

class EnvDataProvider implements vscode.TreeDataProvider<PackageItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PackageItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private cachedActivePath: string = "python";

    constructor(private workspaceRoot: string | undefined, private scriptPath: string) {
        this.refresh();
    }

    public async refresh(): Promise<void> {
        this.cachedActivePath = await this.getActivePythonPath();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PackageItem): vscode.TreeItem { return element; }

    async getChildren(element?: PackageItem): Promise<PackageItem[]> {
        if (!this.workspaceRoot) return [];

        if (!element) {
            const items: PackageItem[] = [];
            // グローバル
            items.push(new PackageItem("Global Environment", "System Default", 0, [], vscode.TreeItemCollapsibleState.Collapsed, 'envGroup', 'python'));

            // フォルダ内をスキャンして全ての仮想環境をリストアップ
            try {
                const files = fs.readdirSync(this.workspaceRoot);
                for (const file of files) {
                    const fullPath = path.join(this.workspaceRoot, file);
                    if (fs.statSync(fullPath).isDirectory()) {
                        const isWin = process.platform === 'win32';
                        const pyPath = isWin 
                            ? path.join(fullPath, 'Scripts', 'python.exe')
                            : path.join(fullPath, 'bin', 'python');
                        
                        if (fs.existsSync(pyPath)) {
                            items.push(new PackageItem(`Venv: ${file}`, pyPath, 0, [], vscode.TreeItemCollapsibleState.Collapsed, 'envGroup', pyPath));
                        }
                    }
                }
            } catch (e) {}
            return items;
        }

        if (element.contextValue === 'envGroup') {
            const pythonPath = element.envPath || 'python';
            return new Promise((resolve) => {
                exec(`"${pythonPath}" "${this.scriptPath}"`, { cwd: this.workspaceRoot }, (err: ExecException | null, stdout: string) => {
                    if (err || !stdout) return resolve([]);
                    try {
                        const pkgs = JSON.parse(stdout.trim());
                        const items = pkgs.map((pkg: any) => 
                            new PackageItem(pkg.name, pkg.version, pkg.size, pkg.requires, vscode.TreeItemCollapsibleState.None, 'packageItem', pythonPath)
                        );
                        resolve(items.sort((a: any, b: any) => b.sizeInBytes - a.sizeInBytes));
                    } catch (e) { resolve([]); }
                });
            });
        }
        return [];
    }

    public async getActivePythonPath(): Promise<string> {
        if (!this.workspaceRoot) return 'python';
        const isWin = process.platform === 'win32';
        
        // デフォルトの .venv を優先
        const defaultVenv = isWin 
            ? path.join(this.workspaceRoot, '.venv', 'Scripts', 'python.exe')
            : path.join(this.workspaceRoot, '.venv', 'bin', 'python');

        if (fs.existsSync(defaultVenv)) return defaultVenv;

        try {
            const pyExt = vscode.extensions.getExtension('ms-python.python');
            if (pyExt) {
                const api: any = pyExt.isActive ? pyExt.exports : await pyExt.activate();
                const pathStr = api.environments?.getActiveEnvironmentPath?.(vscode.workspace.workspaceFolders?.[0].uri)?.path;
                if (pathStr && fs.existsSync(pathStr)) return pathStr;
            }
        } catch {}

        return isWin ? 'python' : 'python3';
    }
}

class PackageItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly version: string,
        public readonly sizeInBytes: number,
        public readonly requires: string[],
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly envPath?: string
    ) {
        const label = sizeInBytes > 0 ? `${name} (${(sizeInBytes / (1024 * 1024)).toFixed(1)} MB)` : name;
        super(label, collapsibleState);
        this.description = version && version !== "not installed" ? `v${version}` : version;
        
        if (contextValue === 'envGroup') {
            this.iconPath = new vscode.ThemeIcon(envPath === 'python' ? "globe" : "device-desktop");
        } else {
            this.iconPath = new vscode.ThemeIcon("package");
        }
    }
}
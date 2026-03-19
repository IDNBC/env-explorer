import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
    const scriptPath = path.join(context.extensionPath, 'inspect_env.py');

    const provider = new EnvDataProvider(workspaceRoot, scriptPath);
    const treeView = vscode.window.createTreeView('envExplorer', { treeDataProvider: provider, canSelectMany: true });

    const LAST_DELETED_PKG_KEY = 'lastDeletedPackage';

    // 1. リフレッシュ
    vscode.commands.registerCommand('env-explorer.refresh', () => provider.refresh());

    // 2. 仮想環境作成
    vscode.commands.registerCommand('env-explorer.createVenv', async () => {
        if (!workspaceRoot) return;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Creating Virtual Environment (.venv)...",
        }, async () => {
            const pythonPath = await provider.getActivePythonPath();
            return new Promise((resolve) => {
                exec(`"${pythonPath}" -m venv .venv`, { cwd: workspaceRoot }, (err) => {
                    if (err) vscode.window.showErrorMessage("Failed: " + err.message);
                    else vscode.window.showInformationMessage(".venv created!");
                    provider.refresh();
                    resolve(null);
                });
            });
        });
    });

    // 3. アンインストール（削除前に情報を保存する）
    vscode.commands.registerCommand('env-explorer.bulkUninstall', async (clickedNode: PackageItem) => {
        const selectedNodes = treeView.selection.length > 0 ? treeView.selection : [clickedNode];
        const packagesToDelete = selectedNodes.filter(n => n.contextValue === 'packageItem');

        if (packagesToDelete.length === 0) return;

        const names = packagesToDelete.map(p => p.name);
        const confirm = await vscode.window.showWarningMessage(`${names.length}件のパッケージを削除しますか？`, { modal: true }, '削除');

        if (confirm === '削除') {
            // ★削除前に復元用の情報を保存 (例: "pandas==2.1.1 requests==2.31.0")
            const installString = packagesToDelete.map(p => `${p.name}==${p.version}`).join(' ');
            await context.globalState.update(LAST_DELETED_PKG_KEY, installString);
            vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', true);

            // 削除対象のPythonパスを使用
            const pythonPath = packagesToDelete[0].envPath || 'python';

            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Uninstalling..." }, () => {
                return new Promise((resolve) => {
                    exec(`"${pythonPath}" -m pip uninstall ${names.join(' ')} -y`, { cwd: workspaceRoot }, (err) => {
                        if (err) vscode.window.showErrorMessage("Uninstall failed");
                        else {
                            vscode.window.showInformationMessage("Selected packages uninstalled.");
                            provider.refresh();
                        }
                        resolve(null);
                    });
                });
            });
        }
    });

    // 4. 【追加】復元（Undo）コマンド
    vscode.commands.registerCommand('env-explorer.undoUninstall', async () => {
        const installString = context.globalState.get<string>(LAST_DELETED_PKG_KEY);
        if (!installString) {
            vscode.window.showErrorMessage("No package to restore.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `最後に削除したパッケージを復元しますか？\n(${installString})`,
            { modal: true }, '復元'
        );

        if (confirm === '復元') {
            const pythonPath = await provider.getActivePythonPath();
            
            // デバッグログ
            console.log(`★Attempting Undo with: ${pythonPath}`);
            console.log(`★Install String: ${installString}`);

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Restoring packages...`,
            }, () => {
                return new Promise((resolve) => {
                    exec(`"${pythonPath}" -m pip install ${installString}`, { cwd: workspaceRoot }, (err, stdout, stderr) => {
                        if (err) {
                            console.error("Undo Error:", stderr);
                            vscode.window.showErrorMessage("Restore failed: " + err.message);
                        } else {
                            vscode.window.showInformationMessage("Packages restored successfully.");
                            // 成功したら情報をクリア
                            context.globalState.update(LAST_DELETED_PKG_KEY, undefined);
                            vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', false);
                            provider.refresh();
                        }
                        resolve(null);
                    });
                });
            });
        }
    });

    // 起動時にUndo可能か確認
    const hasUndoInfo = context.globalState.get<string>(LAST_DELETED_PKG_KEY) !== undefined;
    vscode.commands.executeCommand('setContext', 'env-explorer.canUndo', hasUndoInfo);
}

class EnvDataProvider implements vscode.TreeDataProvider<PackageItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PackageItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private packagesMap: Map<string, any[]> = new Map();

    // 【追加】取得したパスを保持しておく変数
    private cachedActivePath: string = "Detecting...";

    constructor(private workspaceRoot: string | undefined, private scriptPath: string) {
        // コンストラクタで先にパスを計算し始める
        this.updateActivePath();
    }

    // 非同期でパスを更新し、終わったらツリーをリフレッシュする
    private async updateActivePath() {
        this.cachedActivePath = await this.getActivePythonPath();
        this.refresh(); // パスが確定したので表示を更新
    }

    refresh(): void {
        this.packagesMap.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PackageItem): vscode.TreeItem { return element; }

    async getChildren(element?: PackageItem): Promise<PackageItem[]> {
        if (!this.workspaceRoot) return [];

        // 1. トップレベル：キャッシュされたパスを表示に使う
        if (!element) {
            const venvName = path.basename(this.workspaceRoot);
            
            return [
                new PackageItem("Global Environment", "System Default", 0, [], vscode.TreeItemCollapsibleState.Collapsed, 'envGroup', 'python'),
                // ここで await せず、変数に入れるだけにする
                new PackageItem(`Virtual Env (${venvName})`, this.cachedActivePath, 0, [], vscode.TreeItemCollapsibleState.Collapsed, 'envGroup', 'active')
            ];
        }

        // 2. 第2レベル（展開されたとき）
        if (element.contextValue === 'envGroup') {
            // 実行するときだけ最新のパスを取得する（ここは展開時のみなので await してもOK）
            const pythonPath = element.envPath === 'active' ? await this.getActivePythonPath() : 'python';
            
            return new Promise((resolve) => {
                console.log(`Using Python Path: ${pythonPath}`);
                exec(`"${pythonPath}" "${this.scriptPath}"`, { cwd: this.workspaceRoot }, (err, stdout) => {
                    if (err || !stdout) return resolve([]);
                    try {
                        const pkgs = JSON.parse(stdout.trim());
                        this.packagesMap.set(element.label as string, pkgs);
                        const items = pkgs.map((pkg: any) => 
                            new PackageItem(pkg.name, pkg.version, pkg.size, pkg.requires, vscode.TreeItemCollapsibleState.Collapsed, 'packageItem', pythonPath)
                        );
                        resolve(items.sort((a: any, b: any) => b.sizeInBytes - a.sizeInBytes));
                    } catch (e) { resolve([]); }
                });
            });
        }

        // 3. 第3レベル：依存関係を表示
        if (element.contextValue === 'packageItem') {
            // 親（環境）の名前を見つける
            const pkgs = Array.from(this.packagesMap.values()).flat();
            return element.requires.map(reqName => {
                const dep = pkgs.find(p => p.name.toLowerCase() === reqName.toLowerCase());
                return new PackageItem(reqName, dep ? dep.version : "not installed", 0, [], vscode.TreeItemCollapsibleState.None, 'depItem');
            });
        }

        return [];
    }

    public async getActivePythonPath(): Promise<string> {
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot) return 'python';

    const isWin = process.platform === 'win32';
    
    // 【優先1】物理的な .venv フォルダを直接チェック
    // これが一番確実です（VS Codeの認識が遅れていても見つけられるため）
    const venvPython = isWin 
        ? path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(workspaceRoot, '.venv', 'bin', 'python');

    if (fs.existsSync(venvPython)) {
        console.log(`Found physical .venv: ${venvPython}`);
        return venvPython;
    }

    // 【優先2】VS Code の Python 拡張機能の設定を確認
    try {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (pythonExtension) {
            if (!pythonExtension.isActive) await pythonExtension.activate();
            const api = pythonExtension.exports;
            const details = api.environments.getExecutionDetails(vscode.workspace.workspaceFolders?.[0].uri);
            if (details?.execCommand && details.execCommand.length > 0) {
                console.log(`Found via Extension API: ${details.execCommand[0]}`);
                return details.execCommand[0];
            }
        }
    } catch (err) {
        console.error("Python extension integration error:", err);
    }

    // 【優先3】どちらもなければシステム標準
    console.log("No virtual env found, using system default.");
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
        
        // アイコンの使い分け
        if (contextValue === 'envGroup') {
            this.iconPath = new vscode.ThemeIcon(envPath === 'python' ? "globe" : "device-desktop");
        } else if (contextValue === 'packageItem') {
            this.iconPath = new vscode.ThemeIcon("package");
        } else {
            this.iconPath = new vscode.ThemeIcon("extensions");
        }
    }
}
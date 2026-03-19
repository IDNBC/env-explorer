import os
import json
import sys
from importlib import metadata

def get_dir_size(path):
    total = 0
    try:
        if not os.path.exists(path): return 0
        for root, _, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except: pass
    except: pass
    return total

def main():
    result = []
    try:
        # すべての配布パッケージをスキャン
        dists = list(metadata.distributions())
        
        for dist in dists:
            try:
                name = dist.metadata['Name']
                version = dist.version
                
                # 依存関係の取得（パースエラーを防ぐため簡略化）
                requires = []
                if dist.requires:
                    for r in dist.requires:
                        # 複雑な条件式を除去して名前だけ抽出
                        req_name = r.split()[0].split(';')[0].split('>')[0].split('=')[0].split('<')[0].split('!')[0]
                        requires.append(req_name)
                
                # パッケージの物理パスを特定
                pkg_size = 0
                try:
                    # locate_file('') はパッケージのルートディレクトリを指す
                    location = dist.locate_file('')
                    if location:
                        location = str(location)
                        # フォルダ候補を検証
                        search_names = [name, name.replace('-', '_'), name.lower(), name.lower().replace('-', '_')]
                        for n in search_names:
                            p = os.path.join(location, n)
                            if os.path.exists(p):
                                pkg_size = get_dir_size(p)
                                break
                except:
                    pkg_size = 0

                result.append({
                    "name": name,
                    "version": version,
                    "size": pkg_size,
                    "requires": list(set(requires)) # 重複除去
                })
            except Exception:
                continue # 個別のパッケージ取得失敗は無視して次へ

    except Exception as e:
        result = [{"name": f"Error: {str(e)}", "version": "0.0", "size": 0, "requires": []}]

    print(json.dumps(result))

if __name__ == "__main__":
    main()
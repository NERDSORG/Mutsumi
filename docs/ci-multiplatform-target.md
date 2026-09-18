# CI 构建与发布目标状态

## 目标

GitHub Actions 由两个独立的 workflow 组成：

1. **日常 CI**（`ci.yml`）：`push` / `pull_request` 到 `main` 分支时只运行 `check`（类型检查 + 编译），不产出 VSIX。
2. **发布 CI**（`release.yml`）：通过 `workflow_dispatch` 手动触发，构建 1 个 universal VSIX，自动从 `package.json` 读取版本号创建 git tag，并发布 GitHub Release 上传该 `.vsix`。

不自动发布到 VS Code Marketplace。不自动修改 `package.json`。

## 决策结论

- **构建产物**：单个 universal VSIX（`mutsumi-universal`），无平台特定 VSIX，无原生构件处理
- **版本号来源**：从 `package.json` 自动读取，workflow 不接收输入参数
- **触发方式**：
  - 日常 CI：`push` / `pull_request` 到 `main`
  - 发布 CI：`workflow_dispatch` 手动点击触发
- **发布目标**：GitHub Release（不发布到 VS Code Marketplace）
- **package.json 更新**：由用户在本地手动完成，然后 push 到 main
- **Node 版本**：固定 `24.x`
- **WASM 处理**：发布 CI 中必须重新下载 `assets/tree-sitter/*.wasm`（project_outline 依赖）
- **本次不做**：
  - 不发布到 VS Code Marketplace
  - 不自动 bump version
  - 不发 RC/alpha/beta 版本

## Workflow 结构

### `ci.yml`（日常检查）

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    name: Check
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup pnpm
      - setup node 24.x
      - pnpm install --frozen-lockfile
      - pnpm run check-types
      - pnpm run compile
```

### `release.yml`（手动发布）

```yaml
name: Release

on:
  workflow_dispatch:

jobs:
  check:
    # 与 ci.yml 相同的 check job（install --frozen-lockfile → check-types → compile）

  package:
    name: Package VSIX
    needs: check
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup pnpm
      - setup node 24.x
      - pnpm install --frozen-lockfile
      - 下载 tree-sitter WASM（download_wasm.py，重试 3 次）
      - pnpm run compile
      - pnpm exec vsce package（不带 --target）
      - upload artifact mutsumi-universal（./*.vsix, if-no-files-found: error）

  release:
    name: Create Release
    needs: package
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - checkout
      - read version from package.json
      - download artifact mutsumi-universal
      - softprops/action-gh-release 创建 Release，files: artifacts/mutsumi-universal/*.vsix
```

## 发布流程

1. 用户在本地更新 `package.json` 的 `version` 字段
2. 用户 `git commit` 并 `git push` 到 `main`
3. 用户打开 GitHub Actions → `Release` workflow → 点击 `Run workflow`
4. CI 自动：
   - 运行 check
   - 构建 universal VSIX（含 WASM 下载）
   - 从 `package.json` 读取版本号
   - 创建 tag `v{version}`
   - 创建 GitHub Release `Mutsumi v{version}`
   - 上传 `.vsix` 文件到 Release

## 风险

- tag 创建如果重复（例如 package.json 版本未更新就再次触发 release），GitHub Action 会报错。需要确保每次发布前都手动更新 package.json 版本
- `softprops/action-gh-release` 如果 tag 已存在且输入中没有设置，会报错。需要确保每次发布版本唯一

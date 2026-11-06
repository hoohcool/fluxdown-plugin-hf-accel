# FluxDown 插件：HuggingFace 加速

[FluxDown](https://fluxdown.com) 的 resolver 插件（`hoohcool@hf-accel`）：下载 HuggingFace 文件时自动探测镜像可用性并改写到 hf-mirror.com，全部镜像不可用则回退 HF 直连——加速失败绝不阻断下载。

## 工作方式

对**本次要下载的这个文件**，在所有适用镜像上并行发起 `GET + Range: bytes=0-65535`（64 KB 采样）探测，一次探测同时验证**可用性**与**链路质量**：

- 状态 `200/206` 视为可用；全部失败 → 放行 HF 直连，绝不把登录页或错误页当文件存盘。
- 探测到 `206` 时回填 `rangeSupported`，引擎直接按多线程分段规划下载。
- 大文件（Xet/LFS）经镜像 `302` 跳转 cas-bridge.xethub.hf.co CDN 直取（签名链接，约 1 小时有效）；小文件由镜像 resolve-cache 直出。重定向统一手动跟随（最多 3 跳），兼容宿主自动跟随的情形。
- 同一链接会记住上次选中的镜像（storage 内 LRU，12 小时有效），断点续传恢复时不换源，避免 ETag 校验不一致导致整段重下。

## 覆盖的链接形态

仅处理 `/resolve/` 文件直链，覆盖三种仓库类型：

```
https://huggingface.co/<owner>/<repo>/resolve/<ref>/<path>          模型文件
https://huggingface.co/datasets/<owner>/<repo>/resolve/<ref>/<path> 数据集文件
https://huggingface.co/spaces/<owner>/<repo>/resolve/<ref>/<path>   Space 文件
```

改写方式为 host 替换（`huggingface.co` → `hf-mirror.com`），path 与 query 原样保留。仓库主页、讨论区等非文件链接一律放行，不做改写。

## 安全边界

- 任务自带 `Cookie` 或 `Authorization` 头时**直接放行直连**，绝不把用户凭据发往第三方镜像。
- Gated Repo（如 meta-llama/Llama 系列）：仅在镜像返回 `401/403` 且用户已配置 Access Token 时，才附带 `Authorization: Bearer` 重试一次；公开仓库的探测与下载全程不携带 token。
- token 只在同源跳转中保留，一旦重定向到其他 host（如 xethub CDN，签名 URL 自带鉴权）立即丢弃，避免凭据外泄。
- 镜像把 gated 仓库跳转到登录页的情形（`text/html` 响应）永不视为可用，防止把登录页当文件下载。

## 设置

| 设置项 | 说明 |
|---|---|
| 加速模式 | `自动（探测可用性）` / `固定 hf-mirror`（不可用时仍回退其他可用源）/ `直连（禁用加速）` |
| 附加镜像前缀 | 每行一个 `https://` 前缀（gh-proxy 风格转发，完整 HF 链接直接拼在其后，例如 `https://your-proxy.example.com/`），自动参与探测；内置的 hf-mirror.com 为 host 替换式改写，无需在此重复填写 |
| HuggingFace Access Token | 仅 Gated Repo 需要，公开模型留空即可。创建方式：[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) 创建只读 Fine-grained Token（勾选 Read）。注意：token 会经过第三方镜像站，介意请勿填写 |
| 详细日志 | 记录每个镜像的探测状态码与耗时 |

## 安装

- **插件市场**：上架后直接在 FluxDown 插件市场搜索「HuggingFace 加速」。
- **手动安装**：从 [Releases](https://github.com/hoohcool/fluxdown-plugin-hf-accel/releases/latest) 下载 `hf-accel-<version>.fxplug` 导入 FluxDown。

## 打包与发布

```sh
node scripts/pack.mjs
# dist/hf-accel-<version>.fxplug + .sha256（确定性构建，字节可复现）
```

发布即打上更高版本号的 Git 标签并发 GitHub Release（非草稿、非预发布），附件放**恰好一个** `.fxplug`。插件已在 [fluxdown-plugin-index](https://github.com/zerx-lab/fluxdown-plugin-index) 登记（`hoohcool@hf-accel`），之后每次 Release 由索引自动收录，无需再提 PR。

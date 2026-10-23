# AgentDock × DeepSeek Web（实验性扩展）

让 DeepSeek 网页版通过 Chrome/Edge 扩展与本地桥接调用现有 AgentDock。**本集成不会修改当前 AgentDock、NexusDock、Tailscale 或 DSH Bot 服务。** 采用独立端口和人工确认，不提供默认无人值守权限。

## 结构

- extension：仅匹配 https://chat.deepseek.com/ 的 Manifest V3 浏览器扩展。配对令牌存于扩展自身存储，不放进网页对话或网页 DOM。
- bridge：Node.js 20+、零 npm 依赖，仅监听 127.0.0.1:18461。使用标准 MCP Streamable HTTP 调用现有 AgentDock（默认 http://127.0.0.1:8765/mcp）。
- tools：ad_tree / ad_read / ad_search 是读权限；ad_edit 写权限和 ad_handoff 多步任务默认关闭。
- multi-step：ad_handoff 可交给已有 AgentDock ACP profile（默认 codex），或配置 DSH CLI 运行 dsh --profile headless。两者均需人工启用，并具有操作系统账号权限，不属于强隔离沙箱。

DeepSeek 规划并输出工具请求；扩展显示请求；用户逐项确认；本地桥接核验并执行；结果留在扩展面板，用户检查后手动复制到聊天。**不会自动将文件内容或工具结果上传到 DeepSeek。**

## 在 Windows 开发机试用

在 Windows PowerShell：

1. 进入 C:\PARAOS\02Areas-自动化\agentdock-src\integrations\deepseek-web\bridge。
2. 执行 node pair.js "C:\单独准备的非敏感测试工作区"，创建只存在本机的 config.local.json。不要使用整个 C 盘、PARAOS 或真实业务文件夹作为初始授权目录。
3. 启动已安装的 AgentDock。若 AgentDock 的 MCP 服务要求 Bearer 认证，仅在启动桥接的本地终端设置环境变量 AGENTDOCK_WEB_UPSTREAM_TOKEN。扩展配对令牌与 AgentDock 服务令牌不同；不得将任何令牌粘贴进 DeepSeek 网页聊天。
4. 执行 node server.js。
5. 在 Edge 打开 edge://extensions（Chrome 使用 chrome://extensions），启用开发者模式，加载本目录 extension 文件夹。在浏览器工具栏打开该扩展，填入步骤 2 本地终端生成的 64 位令牌，点击「连接测试」。
6. 打开 https://chat.deepseek.com/，新建独立对话，在右下角 AgentDock 面板点击「复制协议」，自行粘贴发送。看到 DeepSeek 输出工具调用时点击「检查 AI 工具请求」，确认后点击「确认执行」。先读合成测试文件验证结果。
7. 在扩展中核对结果；确定可外发时，才点击「复制结果」并手动发回 DeepSeek。

浏览器扩展与桥接不支持自动安装、生产部署或自动外发。

## 能力与开关

| 工具 | 调用 AgentDock | 默认 |
| --- | --- | --- |
| ad_tree | list_dir，最多 3 级和 60 项 | 开启 |
| ad_read | read_file，每次最多 120 行和 12 KB | 开启 |
| ad_search | search_text，纯文本最多 20 项 | 开启 |
| ad_edit | file_edit，精确唯一匹配替换 | 关闭 |
| ad_handoff | acp_session、acp_prompt 或 dsh headless | 关闭 |

改动 config.local.json 的 allowWrites 和 allowHandoff 为 true 后重启服务，才允许高权限功能。将 backend 设为 acp 或 dsh。使用 dsh 时需安装对应 CLI，必要时将 dshExecutable 设为本机的明确可执行文件路径；它不会自动安装 DSH-PRO。当前 Windows 环境中尚未找到 dsh 命令。

## 安全与限制

- 单独随机配对令牌、Bearer 鉴权、Host/Origin 限制、请求限速和体积上限。桥接只监听 loopback，未配置公网隧道。
- 工作区白名单使用 w0 等别名；拒绝绝对路径、.. 路径穿越、链接、.env、凭据、私钥和常见敏感目录；工具输出对常见密钥文本进行初步遮盖。
- 浏览器 AI 输出被视作不可信数据，每次手动批准，并须人工审查工具结果，尤其是个人资料、合同、价格、财务与健康信息。
- 仅记录时间、工具名、工作区别名、成功状态和错误码，不写入工具正文、密钥或文件内容。配置文件被 Git 忽略。
- **重大限制**：ACP/DSH 子代理仍具有运行它的 Windows 账号权限；桥接的目录白名单不构成 OS 层权限隔离。当前版本不可证明信息不会被子代理的其他工具或模型通道外发。真实业务使用前，需要独立账户/容器隔离、Windows 本地脱敏和完整审批验收。
- DeepSeek 网页 DOM 不是稳定接口，页面改版可能导致扩展无法读取响应；使用网页自动化还可能受到网站规则限制。本版本不代用户自动发送请求。
- 运行中的 handoff 状态只存桥接内存；桥接重启后不能恢复轮询。ACP 和 DSH 两类执行器的真实端到端验收仍待完成。

## 验证

在 bridge 文件夹中执行 npm test（Node 自带测试运行器）；检查 Node 语法与 extension/manifest.json。测试使用临时合成目录及模拟 MCP，不修改业务资料。通过测试只说明最小接口和安全规则有效，不能代替真实 DeepSeek 页面、生产 AgentDock 鉴权及 DSH/ACP 的手工验收。

## 致谢

设计参考 seek635/DSH-PRO（MIT License）：https://github.com/seek635/DSH-PRO 。本模块独立实现，侧重复用现有 AgentDock MCP 能力、人工批准和结果外发审批，未复制参考项目的实现代码。

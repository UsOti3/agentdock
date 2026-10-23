# AgentDock × DeepSeek Web 0.2.0

让 DeepSeek 网页提出任务，通过浏览器扩展调用本机 AgentDock；复杂任务交给 DSH（DeepSeek Harness 执行器）连续执行。

**当前状态：后端真实文件操作和 DSH 多步任务已通过；扩展已编写并做消息接口测试，但尚未在用户已登录的 DeepSeek 网页完成验收。不能称为整个网页链路已经交付。** 详见 [VERIFICATION.md](VERIFICATION.md)。

## 已经能做什么

本地桥接已实际调用安装在 Windows 上的 AgentDock，完成目录查看、文件读取、搜索与精确修改。DSH 已实际读取两个数字，计算并写入结果文件，再次读取验证。不是只有模拟测试。

本次 Windows 配置使用 **MCP（模型上下文协议）标准输入输出通道，即 stdio**：桥接启动一个独立的 AgentDock 子进程，与它直接交换消息。它有单独的状态目录，不读取原 AgentDock 的服务令牌，不改变现有 8765 端口服务、NexusDock 或 DSH Bot。

浏览器只连接本机 `127.0.0.1:18461`，使用新生成的独立配对令牌。模型调用复用已有 DSH 的 VPS（远程服务器）适配器；不会为此配置 Windows 直连 OpenAI 的备用通道。这是本次配置的路线，不是对整个操作系统网络流量的保证。

## 日常入口

在本目录双击：

| 文件 | 用途 |
| --- | --- |
| `SETUP.cmd` | 首次生成本机配置和虚构测试文件夹；已有配置时拒绝覆盖 |
| `START.cmd` | 启动桥接，必须通过真实 AgentDock 检查才报告成功；重复启动会复用已有服务 |
| `STOP.cmd` | 停止本集成，并检查连接是否关闭；不关闭原 AgentDock 或 DSH Bot |
| `PAIR.cmd` | 仅把本集成的新配对令牌复制到本机剪贴板，不在聊天或日志打印它 |

运行状态也可在 `bridge` 目录执行 `node manage.js status` 查看。

本次安装的授权文件夹是 `%LOCALAPPDATA%\AgentDockDeepSeekWeb\workspace`，其中只有虚构示例。**已部署配置保持只读；写入和多步任务只在隔离验收中临时开启，不能误解为已经向网页开放全部电脑权限。** 没有增加登录自动启动任务。

## 浏览器首次连接

1. 在 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，开启开发者模式，加载本目录 `extension` 文件夹。
2. 双击 `PAIR.cmd`，在浏览器工具栏打开本扩展的弹窗，把令牌粘贴到配对输入框并保存。令牌绝不能发到 DeepSeek 聊天。
3. 确保 `START.cmd` 已运行，点击扩展的「连接测试」。此检查会真实连到 AgentDock，不只是检查桥接是否启动。
4. 在 `https://chat.deepseek.com/` 新建独立对话。右下角面板点击「复制协议」，手动粘贴发送。看到 AI 输出工具请求后，点击「检查 AI 工具请求」，核对路径和操作，再点击「确认执行」。
5. 工具结果先显示在扩展中；核对不含敏感信息后才手动复制回聊天。程序不会自动发送文件内容或聊天消息。

本轮远程浏览器连接返回 403，因而以上步骤未代用户完成。若由远程助手继续操作，需要用户先在该 Chrome 的 `chrome://inspect/#remote-debugging` 允许调试连接，并在提示时批准连接；不能通过修改浏览器文件绕过授权，也不应将调试端口暴露到公网。

## 工具和权限

| 网页工具 | 本机能力 | 默认权限 |
| --- | --- | --- |
| `ad_tree` | AgentDock `list_dir` | 开启 |
| `ad_read` | AgentDock `read_file` | 开启 |
| `ad_search` | AgentDock `search_text`，先列出可访问文件再搜索 | 开启 |
| `ad_edit` | AgentDock `file_edit`，精确唯一匹配替换 | 关闭 |
| `ad_handoff` | `dsh --profile headless --json` 或已有 HTTP ACP 后端 | 关闭 |

`bridge/config.local.json` 是本机私有配置，已被 Git 忽略。只有经确认设置 `allowWrites` / `allowHandoff` 并重启后，写入/交接能力才出现。首次联调只应对虚构测试目录开启。

DSH NEXT 的命令行入口在安装包内，不一定出现在 PATH。Windows 配置脚本会定位现有安装，以 Electron 的 Node 模式运行包内 CLI。原桌面 VPS 插件不被修改；本集成在自己的本机数据目录生成依赖路径适配副本。`headless-local.patch.yml` 仅在本次命令行启动时生效，不修改原 desktop/headless 配置。

可保留 `transport: "http"` 连接自行配置的 AgentDock MCP HTTP 服务；其认证仍由服务本身要求。此次验收使用 stdio，未读取、复制或验证原 HTTP 服务令牌。新的隔离 stdio 进程没有配置 ACP（Agent 客户端协议）执行器，本次真实多步验收使用 DSH，而非 ACP。

## 验证命令

在 `bridge` 目录：

```powershell
npm test          # 单元、安全和扩展消息接口测试，不调用真实模型
npm run test:live # 调用本机已安装 AgentDock，只处理新建的虚构文件
npm run test:dsh  # 额外调用现有 VPS 模型和真实 DSH，会使用模型额度
```

真实测试在临时目录中创建和删除自己的合成数据，不读取业务资料。调用真实模型的测试不纳入云端自动检查。

## 保护措施与限制

本地端口、随机配对令牌、Host/Origin 校验和限流共同保护入口。桥接仅开放明确列出的工具，拒绝越出目录、常见敏感文件名、符号链接、硬链接及 Windows 特殊路径。搜索会在读取正文之前建立安全文件列表。扩展令牌只允许扩展可信上下文读取，网页脚本模拟的按钮点击不被接受。审计不可写时，在执行操作前拒绝请求。

取消和超时必须等待子进程关闭才标为停止；请求取消失败时，不会谎报“已取消”或释放并发锁。桥接停止会清理自己的执行器；不会终止用户原有程序。

**这些不是操作系统级隔离或完整脱敏。** AgentDock/DSH 仍以当前 Windows 用户运行，无法据此证明恶意任务绝不访问其他目录。文件名拦截和常见令牌遮盖也不能识别全部合同、财务或个人敏感信息。真实业务文件进入模型前仍需专门脱敏、人工复核及更强隔离。

DeepSeek 网页结构可能变化，真实网页选择器尚未验收。浏览器接口测试通过不能替代真实页面测试。模型和网络可能超时；已观察到早期超时及后续成功，不能据单次成功声称无人值守稳定。运行状态保存在桥接内存，重启后不恢复旧任务；不得在不确定任务状态时重复交接。

## 来源

交互设计参考 [seek635/DSH-PRO](https://github.com/seek635/DSH-PRO)（MIT License），本模块独立实现并复用 AgentDock。新增集成不改仓库原 Go 核心，也不要求重新安装 AgentDock。

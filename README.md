# Sub2API 账户用量

Windows 11 系统托盘中的 Sub2API 管理员账户用量监控工具。

应用启动后常驻系统托盘：

- 托盘图标使用官方图标，鼠标悬浮时显示一行当前账户用量提示。
- 单击托盘图标打开详细用量面板，再次单击托盘、点击关闭按钮或点击其他区域关闭面板。
- 可常驻显示半透明悬浮条，按账户上下切换显示已用量；悬浮条可拖动、边缘吸附并记忆位置。
- 托盘右键可打开设置、切换悬浮条置顶状态和退出应用。
- 点击账户名称查看最近 30 天请求数和 Token 趋势。
- 支持 Admin API Key、邮箱密码、TOTP 两步验证和 JWT 自动刷新。

## 开发运行

环境要求：Node.js 20 或更高版本。

```powershell
npm install
npm start
```

开发模式会自动打开悬浮面板；正式版本默认显示系统托盘图标和悬浮条。

## 打包 Windows 安装程序

```powershell
npm run check
npm run dist:win
```

安装程序输出到 `release/Sub2API 账户用量 Setup 1.0.0.exe`。如需免安装目录版本：

```powershell
npm run dist:portable
```

当前安装包为 x64、NSIS、未签名版本。Windows SmartScreen 可能对未签名安装包显示提示；正式发布时应配置代码签名证书。

## 配置和安全

首次打开面板后，在“设置”中填写 Sub2API 服务根地址，例如：

```text
https://sub2api.example.com
```

不要追加 `/api/v1`。可配置：

- 自动刷新间隔，默认 300 秒，最小 30 秒。
- 多账户托盘提示切换间隔，默认 5 秒，最小 1 秒。
- HTTP 请求超时和可信私有部署的自签名 TLS 选项。
- 自动更新地址，默认检查 `https://github.com/tsiens/sub2api-account-usage` 的最新 Release，也可以替换为其他 GitHub 仓库或包含 `latest.yml` 的更新目录。
- 自动刷新到点时，如果系统空闲时间不小于刷新间隔则跳过本次请求；手动刷新不受影响。
- 悬浮条是否显示和是否置顶；悬浮条位置会在移动后保存。
- 悬浮条置顶只作用于普通窗口；检测到其他程序全屏时会自动隐藏，退出全屏后恢复。

鉴权信息保存在 Electron `safeStorage` 中，Windows 上由系统凭据保护。管理员密码不会保存。

应用数据位于 Windows 用户目录下的 `sub2api-account-usage` 文件夹，包含加密配置和 `app.log` 日志。

## GitHub Release

推送与 `package.json` 版本一致的 Tag 后，GitHub Actions 会自动运行检查，并构建 NSIS 安装程序和 portable exe，随后创建 GitHub Release。

例如当前版本发布为 `v1.0.0`：

```powershell
git add .
git commit -m "Electron Windows 应用初始版本"
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

## API

应用使用以下管理员接口：

```text
/api/v1/auth/login
/api/v1/auth/login/2fa
/api/v1/auth/refresh
/api/v1/admin/accounts
/api/v1/admin/accounts/usage/batch
/api/v1/admin/accounts/<id>/stats
```

Electron 主进程从 `src/main.js` 启动。

## 许可证

MIT

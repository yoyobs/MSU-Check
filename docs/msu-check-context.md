# MSU 查账网站导入上下文

导入日期：2026-05-19

## 导入来源

- 旧会话名称：MSU查账网站
- 旧会话 ID：`019e3410-8256-7703-9315-bb7c4a36931b`
- 旧会话文件：`C:\Users\001\.codex\sessions\2026\05\17\rollout-2026-05-17T11-52-37-019e3410-8256-7703-9315-bb7c4a36931b.jsonl`
- 原始备份已复制到：`docs/imported-msu-check-thread-019e3410.jsonl`
- 旧源码位置：`E:\个人项目文件\MSU查账网\https-msu-explorer-xangle-io`
- 当前工作区：`C:\Users\001\Documents\冒险岛`

## 项目状态

当前工作区已经导入旧源码和 Git 历史，最新提交为：

- `6e2eb25 Color history sender and receiver names`

远程仓库：

- `https://github.com/yoyobs/MSU-Check.git`

线上站点：

- `https://msu-check.vercel.app/`

## 用户最初需求

用户想做一个网站，用于在 `https://msu-explorer.xangle.io/` 上查账。

最初版本设想是：

- 输入发送者地址
- 输入接收者地址
- 输入金额
- 点击查询
- 如果没有查到，就显示还没收到钱

后续项目逐步改成基于 Excel 名单的 NESO 转账历史查看工具。

## 当前产品逻辑

网站名称是：大锅菜查账专用网。

当前页面左侧不再是交易者 A/B 查询表单，而是 Excel 名单列表：

- 地址来源：`data/address-book.xlsx`
- 每个人有昵称和地址
- 点击左侧任意名单成员
- 右侧自动筛选这个人与名单内其他人的 NESO 互转记录
- 自动刷新保留，每 15 秒按当前选中人刷新一次
- 右侧只显示 `NESO` Transfer 记录
- 发送方昵称显示红色
- 接收方昵称显示绿色

## 重要技术决策

- 使用 Node.js 原生 HTTP server，不使用 Express。
- 前端是单文件 `public/index.html`。
- 依赖 `xlsx` 读取 Excel 地址簿。
- 通过 Xangle API 拉取 MSU Explorer 数据。
- 查询真实 NESO 转账时不能只看交易顶层 `to` 地址，因为顶层地址可能是合约地址。
- 正确逻辑是读取交易详情里的 token transfer logs，也就是代码里的 `E20TLI` / Transfer 数据。
- 只保留 token symbol 为 `NESO` 的 transfer。
- 金额展示会去掉多余小数 0，并加千分位分隔符。

## 主要已完成变更

- 创建基础查账网站。
- 增加地址下拉列表和后台编辑方案。
- 改为使用本地 Excel 地址簿。
- 增加 `一键更新.bat`，用于更新代码和表格后推送。
- 查询金额输入框被移除，改为交易列表。
- 实时转账历史面板被加入右侧。
- 右侧历史改为只显示系统名单内地址互转。
- 历史扫描窗口反复调试，最终核心是 7 天 NESO transfer log 扫描。
- NXPC 文案改为 NESO。
- 左侧 A/B 查询逻辑曾改为双向 NESO 查询，后来整体取消。
- 最终左侧变成 Excel 名单列表，点击人名驱动右侧筛选。
- 右侧昵称颜色：发送方红色，接收方绿色。
- 网站更新检测 toast 已加入。
- 网站标题改为大锅菜查账专用网。

## 常用验证

```powershell
npm install
npm start
```

或指定端口：

```powershell
$env:PORT='3002'
npm start
```

语法检查：

```powershell
node --check server.js
```

旧线程中常用推送命令：

```powershell
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main
```

## 注意事项

- 不要提交 `node_modules/`。
- 不要提交 `data/admin-password.txt`。
- 修改 `data/address-book.xlsx` 后，线上要通过 GitHub/Vercel 重新部署才能更新名单。
- 如果右侧没有记录，常见原因是双方没有都在 Excel 名单里，或最近 7 天没有 NESO transfer。
- 如果用户问为什么顶层地址和真实收款地址不一致，要说明顶层 `to` 可能是合约，真实 NESO 收款方来自 transfer logs。

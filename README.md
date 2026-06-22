# 📚 PKU DDL Helper

北大教学网作业 & 测试 DDL 自动提取，支持 Notion 同步。

## ✨ 功能

- 🔐 **一键登录** — 通过 IAAA OAuth 登录北大教学网
- 📋 **自动提取** — 自动抓取所有课程的作业和测试截止时间
- 📊 **焦虑值** — 可视化展示你的 DDL 压力
- ➕ **手动添加** — 支持手动添加自定义 DDL
- 🏷️ **课程筛选** — 按课程过滤，忽略不重要的课
- 🔄 **一键刷新** — 不用重新登录即可更新 DDL
- 🔗 **Notion 同步** — 一键创建数据库并同步到 Notion

## 🚀 快速开始

### 环境要求

- Node.js >= 16
- 北大教学网账号

### 安装

```bash
git clone https://github.com/zhaoyizhang-ai/pkuddl.git
cd pkuddl
npm install
```

### 运行

```bash
npm start
```

打开浏览器访问 `http://localhost:3000`

## 📖 使用说明

1. 输入学号和密码登录（OTP 可选）
2. 等待系统自动抓取所有课程的 DDL
3. 在列表中查看、标记、删除 DDL
4. 点击「刷新」按钮更新数据（无需重新登录）
5. 在「Notion」标签页配置同步

## 🔗 Notion 同步配置

### 方式一：一键创建（推荐）

1. 在 Notion 中新建一个空白页面
2. 创建一个 [Notion Integration](https://www.notion.so/my-integrations)
3. 复制 Integration Token
4. 复制页面 URL 中 `notion.so/` 后面的 ID
5. 在工具中填写 Token 和页面 ID，点击「一键创建」

### 方式二：手动创建

1. 创建 Notion 数据库，包含以下属性：
   - `Name` (Title)
   - `课程` (Select)
   - `截止时间` (Date)
   - `状态` (Select: 未完成/已完成/已过期)
   - `作业ID` (Rich Text)
2. 复制数据库 ID 填入工具

## 📁 项目结构

```
pkuddl/
├── server.js          # 后端服务
├── public/
│   └── index.html     # 前端页面
├── data.json          # 本地数据存储（自动生成，已 gitignore）
├── package.json
└── README.md
```

## ⚠️ 注意事项

- 数据保存在本地 `data.json`，重启服务器不会丢失
- 由于北大教学网 SSL 证书问题，需要禁用证书验证
- 建议在本地或内网环境使用

## 📝 更新日志

### v1.1.0
- ✨ 支持测试/Quiz DDL 抓取
- ✨ 添加一键刷新功能（无需重新登录）
- ✨ 数据持久化（重启不丢失）
- 📝 添加 README 文档

### v1.0.0
- 🎉 初始版本
- ✨ IAAA OAuth 登录
- ✨ 作业 DDL 自动提取
- ✨ Notion 同步

## 📄 License

ISC

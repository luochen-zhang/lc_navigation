# 🧭 洛宸导航站 · 让你的书签管理优雅如诗

> 一个基于 Cloudflare Workers + D1 + KV 的轻量级导航站，集前台展示、后台管理、分类拖拽排序、访客提交审核于一体。  
> 不花哨，但该有的都有，还带点小幽默 🤡。

---

## 📖 简介

你是否还在为浏览器书签栏的“乱葬岗”而头痛？  
是否想拥有一个自己专属的、可随时随地方便管理的导航页？  
这个项目就是为你准备的——**自带后台管理面板**，支持**分类拖拽排序**、**链接一键导入导出**、**访客提交待审核**，还贴心地内置了**自动获取网站图标**的“魔术棒”功能 ✨。

前台采用毛玻璃设计，自适应移动端，自带一句“每日一言”和快速搜索框；后台功能强大，你甚至可以直接拖拽卡片调整分类顺序，刷新页面即生效。

技术栈极其清爽：**Cloudflare Workers + D1 数据库 + KV 存储**，部署简单，免费额度足够个人使用，拿来即用，随心改造。

---

## ✨ 特性一览

| 模块 | 亮点 |
|------|------|
| 🏠 **前台展示** | 毛玻璃质感，自适应布局，按分类展示书签，支持搜索过滤 |
| 🔍 **快捷搜索** | 首页集成百度 / Google 双搜索，一键直达 |
| 📅 **每日一言** | 集成 Hitokoto API，每天一句治愈小短句 |
| 🔧 **后台管理** | 完整的 CRUD，支持分页、搜索、按分类筛选 |
| 🏷️ **分类排序** | 拖拽分类卡片即可调整前台顺序（支持自定义排序值） |
| 🔗 **链接排序** | 表格内拖拽行即交换排序（分页模式）或插入排序（全量模式），灵活智能 |
| 📤 **导入 / 导出** | 一键导出所有链接为 JSON，也支持批量导入，迁移数据超方便 |
| ✅ **访客提交** | 可开启公开提交功能，新链接进入待审核表，管理员后台审批 |
| 🎨 **站点设置** | 动态修改站名、图标、版权、背景图、博客链接，无需改代码 |
| 🔐 **安全认证** | 基于 Cookie + KV 的会话管理，登录即享 12 小时有效期 |

---

## 🚀 部署指南

> 整个部署过程大约需要 **10 分钟**，准备好你的 Cloudflare 账号即可。

### 1. 准备工作
- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号
- 已开通 Workers 和 D1 数据库（免费套餐即可）
- 可选：一个自定义域名（用于绑定 Worker）

### 2. 克隆项目
```bash
git clone https://github.com//luochen-zhang/lc_navigation.git
cd nav-site
```

### 3. 配置数据库
在 Cloudflare Dashboard 中创建 D1 数据库，比如命名为 `nav-db`。  
然后执行以下 SQL 创建表结构（可在 Worker 的 `wrangler.toml` 中配置，或直接在 D1 控制台执行）：

```sql
-- 主链接表
CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  logo TEXT,
  desc TEXT,
  catelog TEXT NOT NULL,
  sort_order INTEGER DEFAULT 9999,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 待审核表
CREATE TABLE pending_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  logo TEXT,
  desc TEXT,
  catelog TEXT NOT NULL,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 分类排序表（用于自定义分类顺序）
CREATE TABLE category_orders (
  catelog TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);
```

### 4. 配置 KV 存储
在 Cloudflare Dashboard 中创建一个 KV 命名空间，**NAV_AUTH**，用于存储会话和站点配置。  
然后在 `wrangler.toml` 中绑定：

```toml
kv_namespaces = [
  { binding = "NAV_AUTH", id = "your-kv-id" }
]
```

### 5. 设置管理员账号
首次启动后，需要通过 Cloudflare 的 `KV` 控制台手动写入管理员账号密码：
手动创建KV对
**admin_username：your-admin-nam
admin_password：your-strong-password**

```bash
# 使用 wrangler 命令行
wrangler kv:key put --binding=NAV_AUTH "admin_username" "your-admin-name"
wrangler kv:key put --binding=NAV_AUTH "admin_password" "your-strong-password"
```

### 6. 部署 Worker
直接将index.js代码复制到worker

完成后，访问你的 Worker 域名（或自定义域名）即可看到前台页面，访问 `/admin` 进入后台登录。

---

## 🧰 升级指南

后续版本更新时，只需拉取最新代码，重新部署即可：

```bash
git pull origin main
wrangler deploy
```


---

## 👨‍💻 开发指南

### 项目结构
```
.
├── index.js          # 主入口（包含所有路由、业务逻辑、前端模板）
└── README.md         # 你正在看的文档
```

> 注：为了简便，前端模板（HTML/CSS/JS）直接内嵌在 `index.js` 中，方便单文件部署。当然你也可以拆出来按需调整。

### 本地调试
```bash
wrangler dev
```
即可在 `http://localhost:8787` 预览，支持热重载。

### 核心 API 预览
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/config` | GET | 分页获取链接列表（支持分类、关键词过滤） |
| `/api/config` | POST | 新增链接（需登录） |
| `/api/config/:id` | PUT | 更新链接（需登录） |
| `/api/config/:id` | DELETE | 删除链接（需登录） |
| `/api/config/import` | POST | 批量导入 JSON（需登录） |
| `/api/config/export` | GET | 导出全部链接为 JSON（需登录） |
| `/api/pending` | GET | 获取待审核列表（需登录） |
| `/api/pending/:id` | PUT | 批准待审核链接（需登录） |
| `/api/pending/:id` | DELETE | 拒绝待审核链接（需登录） |
| `/api/categories` | GET | 获取所有分类及其链接数（需登录） |
| `/api/categories/:name` | PUT | 更新分类排序值或重置（需登录） |
| `/api/site/config` | GET / PUT | 获取/更新站点设置（PUT 需登录） |
| `/admin` | GET / POST | 登录页面 / 登录验证 |
| `/admin/logout` | POST | 退出登录 |

---

## 🤝 贡献指南

欢迎提交 Issue 和 PR！  
如果你有好的想法，请先开 Issue 讨论，避免重复劳动。  
代码风格尽量保持现有简洁风格，并确保功能测试通过。

---

## 📝 更新日志

### v1.0.0 (2026-07-18)
- 🎉 首个正式版本发布
- ✅ 支持完整的前后台功能
- ✨ 分类拖拽排序、链接拖拽排序（交换/插入模式）
- 🔐 基于 KV 的会话认证
- 📤 数据导入导出
- 🖼️ 动态站点配置（背景图、站名等）

---

## 📸 效果截图

### 前台首页
<img width="1902" height="886" alt="屏幕截图 2026-07-18 090226" src="https://github.com/user-attachments/assets/562e8c32-4e2e-424c-be52-eea5d7583122" />
<img width="1920" height="888" alt="屏幕截图 2026-07-18 090248" src="https://github.com/user-attachments/assets/67ced63a-f3b7-4934-924d-d0bdd9bde95e" />
*毛玻璃设计，清爽干净，一页展示所有分类。*

### 后台管理概览
<img width="1920" height="883" alt="屏幕截图 2026-07-18 090308" src="https://github.com/user-attachments/assets/d58e177a-96fc-495f-baf2-dbfc1d426d6e" />
*总览统计 + 分类卡片拖拽排序，所见即所得。*

### 链接管理表格
<img width="1900" height="670" alt="屏幕截图 2026-07-18 090343" src="https://github.com/user-attachments/assets/a2185303-524c-4960-a8ee-6d97a69f0539" />
*支持分页、搜索、筛选，且拖拽行即可调整排序。*

### 站点设置
<img width="1891" height="841" alt="屏幕截图 2026-07-18 090505" src="https://github.com/user-attachments/assets/235ccc30-8fe0-40bb-a7e6-a486d90d14d2" />
*实时修改站名、图标、背景图等，无需重新部署。*

---

## 📜 许可证

MIT © [luochen-zhang](https://github.com/luochen-zhang)

---

**觉得有用的话，给个 ⭐ 吧～ 你的鼓励是我更新的最大动力！**

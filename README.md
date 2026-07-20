# 🧭 智能导航站 · 让你的书签管理优雅如诗

> 一个基于 Cloudflare Workers + D1 + KV 的轻量级导航站，集前台展示、后台管理、分类拖拽排序、访客提交审核、链接健康检查于一体。  
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
| 🩺 **链接健康检查** | 批量检测链接可用性，后台显示健康状态（🟢 正常 / 🔴 异常） |
| 🔧 **后台管理** | 完整的 CRUD，支持分页、搜索、按分类筛选 |
| 🏷️ **分类排序** | 拖拽分类卡片即可调整前台顺序（支持自定义排序值） |
| ✏️ **分类重命名** | 一键修改分类名称，自动同步所有链接和排序记录 |
| 🗑️ **分类删除增强** | 删除分类时自动删除该分类下所有链接 |
| 🔗 **链接排序** | 表格内拖拽行即可排序，支持插入 / 交换两种模式 |
| ✅ **批量操作** | 支持批量删除、批量修改分类，效率翻倍 |
| 📤 **导入 / 导出** | 一键导出所有链接为 JSON，支持按分类导出，导入时自动去重 |
| 👥 **访客提交** | 可开启公开提交功能，新链接进入待审核表，管理员后台审批 |
| 🎨 **站点设置** | 动态修改站名、图标、版权、背景图、博客链接，无需改代码 |
| 🔐 **安全认证** | 基于 Cookie + KV 的会话管理，登录即享 12 小时有效期 |
| 🚀 **性能优化** | 站点配置 5 分钟内存缓存，减少 KV 读取次数 |

---

## 🚀 部署指南

> 整个部署过程大约需要 **10 分钟**，准备好你的 Cloudflare 账号即可。

### 1. 准备工作
- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号
- 已开通 Workers 和 D1 数据库（免费套餐即可）
- 可选：一个自定义域名（用于绑定 Worker）

### 2. 克隆项目
```bash
git clone https://github.com/your-username/nav-site.git
cd nav-site
```

### 3. 配置数据库
在 Cloudflare Dashboard 中创建 D1 数据库，比如命名为 `nav-db`。  
然后执行以下 SQL 创建表结构：

```sql
-- ============================================================
-- 1. sites 表（链接主表）
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  logo TEXT,
  desc TEXT,
  catelog TEXT NOT NULL,
  sort_order INTEGER DEFAULT 9999,
  create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  health_status INTEGER DEFAULT 0,        -- 0=未检查, 1=正常, 2=异常
  health_error TEXT,                      -- 异常原因
  health_checked_at TIMESTAMP
);

-- 索引优化（提升查询性能）
CREATE INDEX IF NOT EXISTS idx_sites_catelog ON sites(catelog);
CREATE INDEX IF NOT EXISTS idx_sites_sort_order ON sites(sort_order);
CREATE INDEX IF NOT EXISTS idx_sites_health_status ON sites(health_status);

-- ============================================================
-- 2. pending_sites 表（待审核链接）
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  logo TEXT,
  desc TEXT,
  catelog TEXT NOT NULL,
  create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_catelog ON pending_sites(catelog);

-- ============================================================
-- 3. category_orders 表（分类排序）
-- ============================================================
CREATE TABLE IF NOT EXISTS category_orders (
  catelog TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);
```

### 4. 配置 KV 存储
在 Cloudflare Dashboard 中创建一个 KV 命名空间，例如 `NAV_AUTH`，用于存储会话和站点配置。  
然后在 `wrangler.toml` 中绑定：

```toml
kv_namespaces = [
  { binding = "NAV_AUTH", id = "your-kv-id" }
]
```

### 5. 设置管理员账号
首次启动后，需要通过 `wrangler` 或 Cloudflare 的 `KV` 控制台手动写入管理员账号密码：

```bash
# 使用 wrangler 命令行
wrangler kv:key put --binding=NAV_AUTH "admin_username" "your-admin-name"
wrangler kv:key put --binding=NAV_AUTH "admin_password" "your-strong-password"
```

### 6. 部署 Worker
```bash
wrangler deploy
```

完成后，访问你的 Worker 域名（或自定义域名）即可看到前台页面，访问 `/admin` 进入后台登录。

---

## 🧰 升级指南（v1 → v2）

如果你是从 v1 版本升级，需要执行以下数据库迁移：

```sql
-- 新增健康检查字段
ALTER TABLE sites ADD COLUMN health_status INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN health_error TEXT;
ALTER TABLE sites ADD COLUMN health_checked_at TIMESTAMP;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_sites_catelog ON sites(catelog);
CREATE INDEX IF NOT EXISTS idx_sites_sort_order ON sites(sort_order);
CREATE INDEX IF NOT EXISTS idx_sites_health_status ON sites(health_status);
CREATE INDEX IF NOT EXISTS idx_pending_catelog ON pending_sites(catelog);
```

然后拉取最新代码重新部署即可：
```bash
git pull origin main
wrangler deploy
```

---

## 👨‍💻 开发指南

### 项目结构
```
.
├── index-v2.js   # 主入口（包含所有路由、业务逻辑、前端模板）
├── wrangler.toml       # Cloudflare 配置
├── 数据库.txt           # 数据库表结构 SQL
└── README.md           # 你正在看的文档
```

> 注：为了简便，前端模板（HTML/CSS/JS）直接内嵌在主文件中，方便单文件部署。当然你也可以拆出来按需调整。

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
| `/api/config/:id` | GET | 获取单条链接详情（需登录） |
| `/api/config/:id` | PUT | 更新链接（需登录） |
| `/api/config/:id` | DELETE | 删除链接（需登录） |
| `/api/config/batch-sort` | PUT | 批量更新排序（需登录） |
| `/api/config/import` | POST | 批量导入 JSON（需登录，自动去重） |
| `/api/config/export` | GET | 导出全部/分类链接为 JSON（需登录） |
| `/api/pending` | GET | 获取待审核列表（需登录） |
| `/api/pending/:id` | PUT | 批准待审核链接（需登录） |
| `/api/pending/:id` | DELETE | 拒绝待审核链接（需登录） |
| `/api/categories` | GET | 获取所有分类及其链接数（需登录） |
| `/api/categories/:name` | PUT | 更新排序值 / 重命名 / 重置（需登录） |
| `/api/sites/batch` | DELETE | 批量删除链接（需登录） |
| `/api/sites/batch/category` | PUT | 批量修改分类（需登录） |
| `/api/health/check-batch` | POST | 批量检查链接健康状态（需登录） |
| `/api/site/config` | GET / PUT | 获取/更新站点设置（PUT 需登录） |
| `/admin` | GET / POST | 登录页面 / 登录验证 |
| `/admin/logout` | GET | 退出登录 |

---

## 🤝 贡献指南

欢迎提交 Issue 和 PR！  
如果你有好的想法，请先开 Issue 讨论，避免重复劳动。  
代码风格尽量保持现有简洁风格，并确保功能测试通过。

---

## 📝 更新日志

### v2.0.0 (2026-07-20)
- 🩺 **新增链接健康检查**：支持批量检测当前页链接可用性，概览页显示健康/异常统计
- ✅ **批量操作**：支持批量删除、批量修改分类，配合复选框选择
- ✏️ **分类重命名**：一键修改分类名称，自动同步所有数据
- 🗑️ **分类删除增强**：删除分类时自动删除该分类下所有链接
- 📥 **导入去重**：导入时自动跳过已存在的链接（基于 name+url）
- 📤 **分类导出**：支持按分类导出数据
- 🚀 **站点配置缓存**：KV 读取增加 5 分钟内存缓存，提升性能
- 🎨 **UI 全面升级**：
  - Toast 轻提示替代底部消息
  - 加载指示器（带进度文案）
  - 确认弹窗（告别 `confirm` 弹窗）
  - 健康状态图标（🟢 正常 / 🔴 异常）
  - 侧边栏分类高亮
  - 搜索空状态提示
- 🧹 **代码优化**：移除冗余函数，API 路由更清晰

### v1.0.0 (2026-07-18)
- 🎉 首个正式版本发布
- ✅ 支持完整的前后台功能
- ✨ 分类拖拽排序、链接拖拽排序（交换/插入模式）
- 🔐 基于 KV 的会话认证
- 📤 数据导入导出
- 🖼️ 动态站点配置（背景图、站名等）

---

## 📸 效果截图

> 以下为示意位置，你可将实际截图放在 `docs/` 目录下，并在此处引用。

### 前台首页
<img width="1894" height="885" alt="捕获" src="https://github.com/user-attachments/assets/f0d90f39-dd03-4ae4-b2f0-90ca76dc055d" />
<img width="1920" height="888" alt="屏幕截图 2026-07-18 090248" src="https://github.com/user-attachments/assets/67ced63a-f3b7-4934-924d-d0bdd9bde95e" />
*毛玻璃设计，清爽干净，一页展示所有分类。*

### 后台概览（v2 新增健康统计）
<img width="1919" height="887" alt="1" src="https://github.com/user-attachments/assets/2e9e3869-b60d-4178-a6bd-3e7a5f429dcd" />

*总览统计 + 健康链接/异常链接卡片 + 分类拖拽排序。*

### 链接管理（v2 新增复选框 & 健康状态）
<img width="1892" height="875" alt="2" src="https://github.com/user-attachments/assets/471719a2-fb6d-4f50-926c-11166d74875d" />
*支持分页、搜索、筛选，复选框批量操作，健康状态一目了然。*

### 站点设置
<img width="1891" height="841" alt="屏幕截图 2026-07-18 090505" src="https://github.com/user-attachments/assets/235ccc30-8fe0-40bb-a7e6-a486d90d14d2" />
*实时修改站名、图标、背景图等，无需重新部署。*


## 📜 许可证

MIT © [luochen-zhang](https://github.com/luochen-zhang)

---

**觉得有用的话，给个 ⭐ 吧～ 你的鼓励是我更新的最大动力！**

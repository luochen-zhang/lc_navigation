// ============================================================
// 工具函数
// ============================================================
function escapeHTML(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  try {
    const direct = new URL(trimmed);
    if (direct.protocol === 'http:' || direct.protocol === 'https:') {
      return direct.href;
    }
  } catch (error) {
    try {
      const fallback = new URL(`https://${trimmed}`);
      if (fallback.protocol === 'http:' || fallback.protocol === 'https:') {
        return fallback.href;
      }
    } catch (e) { return ''; }
  }
  return '';
}

function normalizeSortOrder(value) {
  if (value === undefined || value === null || value === '') return 9999;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.max(-2147483648, Math.min(2147483647, Math.round(parsed)));
  }
  return 9999;
}

function isSubmissionEnabled(env) {
  const flag = env.ENABLE_PUBLIC_SUBMISSION;
  if (flag === undefined || flag === null) return true;
  return String(flag).trim().toLowerCase() === 'true';
}

// ============================================================
// 会话管理
// ============================================================
const SESSION_COOKIE_NAME = 'nav_admin_session';
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) { acc[pair] = ''; } else {
        acc[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
      return acc;
    }, {});
}

function buildSessionCookie(token, options = {}) {
  const { maxAge = SESSION_TTL_SECONDS } = options;
  const segments = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  return segments.join('; ');
}

async function createAdminSession(env) {
  const token = crypto.randomUUID();
  await env.NAV_AUTH.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

async function refreshAdminSession(env, token, payload) {
  await env.NAV_AUTH.put(`${SESSION_PREFIX}${token}`, payload, { expirationTtl: SESSION_TTL_SECONDS });
}

async function destroyAdminSession(env, token) {
  if (!token) return;
  await env.NAV_AUTH.delete(`${SESSION_PREFIX}${token}`);
}

async function validateAdminSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return { authenticated: false };
  const sessionKey = `${SESSION_PREFIX}${token}`;
  const payload = await env.NAV_AUTH.get(sessionKey);
  if (!payload) return { authenticated: false };
  await refreshAdminSession(env, token, payload);
  return { authenticated: true, token };
}

async function isAdminAuthenticated(request, env) {
  const { authenticated } = await validateAdminSession(request, env);
  return authenticated;
}

// ============================================================
// 站点配置 KV 读写 + 内存缓存
// ============================================================
const SITE_CONFIG_PREFIX = 'site_config:';
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedConfig() {
  const cached = globalThis._siteConfigCache;
  if (cached && cached.expire > Date.now()) return cached.data;
  return null;
}

function setCachedConfig(data) {
  globalThis._siteConfigCache = { data, expire: Date.now() + CACHE_TTL_MS };
}

function clearConfigCache() {
  delete globalThis._siteConfigCache;
}

async function getSiteConfig(env) {
  const cached = getCachedConfig();
  if (cached) return cached;
  const defaults = {
    site_name: '洛宸导航',
    site_icon: 'https://img.lcit.cc.cd/file/1784204385655_主页.png',
    site_copyright: '洛宸导航',
    site_blog: 'https://lcbg.cc.cd/',
    site_background: 'https://bj.lcit.cc.cd/'
  };
  try {
    const data = await env.NAV_AUTH.get(SITE_CONFIG_PREFIX + 'data');
    if (data) {
      const parsed = JSON.parse(data);
      const config = { ...defaults, ...parsed };
      setCachedConfig(config);
      return config;
    }
  } catch (e) { /* ignore */ }
  setCachedConfig(defaults);
  return defaults;
}

async function setSiteConfig(env, config) {
  await env.NAV_AUTH.put(SITE_CONFIG_PREFIX + 'data', JSON.stringify(config));
  clearConfigCache();
}

// ============================================================
// 健康检查核心函数（仅保留批量检查）
// ============================================================
async function checkSingleUrl(url, retries = 2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let resp = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeout);
    if (!resp.ok && [405, 403, 404, 421, 501, 503, 521].includes(resp.status)) {
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 8000);
      resp = await fetch(url, {
        method: 'GET',
        signal: controller2.signal,
        redirect: 'follow',
        headers: {
          'Range': 'bytes=0-0',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache'
        }
      });
      clearTimeout(timeout2);
    }
    const ok = resp.status >= 200 && resp.status < 400;
    return { status: resp.status, ok, error: ok ? null : `HTTP ${resp.status}` };
  } catch (e) {
    clearTimeout(timeout);
    if (retries > 0 && (e.name === 'AbortError' || e.message.includes('timeout') || e.message.includes('abort'))) {
      await new Promise(r => setTimeout(r, 1500));
      return checkSingleUrl(url, retries - 1);
    }
    return { status: 0, ok: false, error: e.message || '连接失败' };
  }
}

async function checkBatchSites(ids, env) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.NAV_DB.prepare(
    `SELECT id, url FROM sites WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const results_arr = [];
  for (const site of results) {
    const result = await checkSingleUrl(site.url);
    const status = result.ok ? 1 : 2;
    const errorMsg = result.ok ? null : (result.error || `HTTP ${result.status}`);
    await env.NAV_DB.prepare(
      `UPDATE sites SET health_status = ?, health_checked_at = datetime('now', '+8 hours'), health_error = ? WHERE id = ?`
    ).bind(status, errorMsg, site.id).run();
    results_arr.push({ id: site.id, url: site.url, status, error: errorMsg, ...result });
  }
  return results_arr;
}

// ============================================================
// API 处理
// ============================================================
const api = {
  async handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace('/api', '');
    const method = request.method;
    const id = url.pathname.split('/').pop();

    try {
      // ---- 站点配置 ----
      if (path === '/site/config') {
        if (method === 'GET') {
          return new Response(JSON.stringify({ code: 200, data: await getSiteConfig(env) }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (method === 'PUT') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          const body = await request.json();
          const { site_name, site_icon, site_copyright, site_blog, site_background } = body;
          const config = {
            site_name: site_name?.trim() || '洛宸导航',
            site_icon: sanitizeUrl(site_icon) || 'https://img.lcit.cc.cd/file/1784204385655_主页.png',
            site_copyright: site_copyright?.trim() || '洛宸导航',
            site_blog: sanitizeUrl(site_blog) || 'https://lcbg.cc.cd/',
            site_background: sanitizeUrl(site_background) || 'https://bj.lcit.cc.cd/'
          };
          await setSiteConfig(env, config);
          return new Response(JSON.stringify({ code: 200, message: '站点配置已更新' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return this.errorResponse('Method Not Allowed', 405);
      }

      // ---- 单条查询 ----
      if (path.startsWith('/config/') && /^\d+$/.test(id) && method === 'GET') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        try {
          const { results } = await env.NAV_DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).all();
          if (results.length === 0) return this.errorResponse('Not Found', 404);
          return new Response(JSON.stringify({ code: 200, data: results[0] }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return this.errorResponse(`Failed to fetch config: ${e.message}`, 500);
        }
      }

      // ---- 配置列表 ----
      if (path === '/config') {
        if (method === 'GET') return await this.getConfig(request, env, ctx, url);
        if (method === 'POST') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          return await this.createConfig(request, env, ctx);
        }
        return this.errorResponse('Method Not Allowed', 405);
      }

      // ---- 批量排序 ----
      if (path === '/config/batch-sort' && method === 'PUT') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.batchSortConfig(request, env, ctx);
      }

      // ---- 批量删除 ----
      if (path === '/sites/batch' && method === 'DELETE') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.batchDeleteSites(request, env, ctx);
      }

      // ---- 批量修改分类 ----
      if (path === '/sites/batch/category' && method === 'PUT') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.batchUpdateCategory(request, env, ctx);
      }

      // ---- 公开提交 ----
      if (path === '/config/submit' && method === 'POST') {
        if (!isSubmissionEnabled(env)) return this.errorResponse('Public submission disabled', 403);
        return await this.submitConfig(request, env, ctx);
      }

      // ---- 分类 ----
      if (path === '/categories' && method === 'GET') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.getCategories(request, env, ctx);
      }
      if (path.startsWith('/categories/')) {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        const categoryName = decodeURIComponent(path.replace('/categories/', ''));
        if (method === 'PUT') {
          const body = await request.json().catch(() => ({}));
          if (body.rename) {
            const newName = body.rename.trim();
            if (!newName || newName === categoryName) {
              return this.errorResponse('新分类名无效或相同', 400);
            }
            try {
              await env.NAV_DB.prepare('UPDATE sites SET catelog = ? WHERE catelog = ?').bind(newName, categoryName).run();
              await env.NAV_DB.prepare('UPDATE category_orders SET catelog = ? WHERE catelog = ?').bind(newName, categoryName).run();
              return new Response(JSON.stringify({ code: 200, message: '分类重命名成功' }), {
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (e) {
              return this.errorResponse(`重命名失败: ${e.message}`, 500);
            }
          }
          if (body && body.reset) {
            await env.NAV_DB.prepare('DELETE FROM category_orders WHERE catelog = ?').bind(categoryName).run();
            return new Response(JSON.stringify({ code: 200, message: 'Category order reset successfully' }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const sortOrderValue = normalizeSortOrder(body ? body.sort_order : undefined);
          await env.NAV_DB.prepare(
            `INSERT INTO category_orders (catelog, sort_order) VALUES (?, ?) ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order`
          ).bind(categoryName, sortOrderValue).run();
          return new Response(JSON.stringify({ code: 200, message: 'Category order updated successfully' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return this.errorResponse('Method Not Allowed', 405);
      }

      // ---- 单条配置操作 ----
      if (path === `/config/${id}` && /^\d+$/.test(id)) {
        if (method === 'PUT') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          return await this.updateConfig(request, env, ctx, id);
        }
        if (method === 'DELETE') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          return await this.deleteConfig(request, env, ctx, id);
        }
        return this.errorResponse('Method Not Allowed', 405);
      }

      // ---- 待审核 ----
      if (path.startsWith('/pending/') && /^\d+$/.test(id)) {
        if (method === 'PUT') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          return await this.approvePendingConfig(request, env, ctx, id);
        }
        if (method === 'DELETE') {
          if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
          return await this.rejectPendingConfig(request, env, ctx, id);
        }
        return this.errorResponse('Method Not Allowed', 405);
      }
      if (path === '/pending' && method === 'GET') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.getPendingConfig(request, env, ctx, url);
      }

      // ---- 导入导出 ----
      if (path === '/config/import' && method === 'POST') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.importConfig(request, env, ctx);
      }
      if (path === '/config/export' && method === 'GET') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        return await this.exportConfig(request, env, ctx, url);
      }

      // ---- 健康检查 - 仅保留批量检查（当前页） ----
      if (path === '/health/check-batch' && method === 'POST') {
        if (!(await isAdminAuthenticated(request, env))) return this.errorResponse('Unauthorized', 401);
        const body = await request.json();
        const { ids } = body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return this.errorResponse('请提供要检查的链接 ID 列表', 400);
        }
        if (ids.length > 50) {
          return this.errorResponse('单次最多检查 50 个链接', 400);
        }
        const results = await checkBatchSites(ids, env);
        return new Response(JSON.stringify({ code: 200, data: results }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return this.errorResponse('Not Found', 404);
    } catch (error) {
      return this.errorResponse(`Internal Server Error: ${error.message}`, 500);
    }
  },

  // ----- 业务方法 -----
  async getConfig(request, env, ctx, url) {
    const catalog = url.searchParams.get('catalog');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
    const keyword = url.searchParams.get('keyword');
    const offset = (page - 1) * pageSize;
    try {
      let query = `SELECT id, name, url, logo, \`desc\`, catelog, sort_order, create_time, update_time,
         health_status, health_error, health_checked_at
         FROM sites ORDER BY sort_order ASC, create_time DESC LIMIT ? OFFSET ?`;
      let countQuery = `SELECT COUNT(*) as total FROM sites`;
      let queryBindParams = [pageSize, offset];
      let countQueryParams = [];

      if (catalog) {
        query = `SELECT id, name, url, logo, \`desc\`, catelog, sort_order, create_time, update_time,
           health_status, health_error, health_checked_at
           FROM sites WHERE catelog = ? ORDER BY sort_order ASC, create_time DESC LIMIT ? OFFSET ?`;
        countQuery = `SELECT COUNT(*) as total FROM sites WHERE catelog = ?`;
        queryBindParams = [catalog, pageSize, offset];
        countQueryParams = [catalog];
      }

      if (keyword) {
        const likeKeyword = `%${keyword}%`;
        query = `SELECT id, name, url, logo, \`desc\`, catelog, sort_order, create_time, update_time,
           health_status, health_error, health_checked_at
           FROM sites WHERE name LIKE ? OR url LIKE ? OR catelog LIKE ? OR \`desc\` LIKE ? ORDER BY sort_order ASC, create_time DESC LIMIT ? OFFSET ?`;
        countQuery = `SELECT COUNT(*) as total FROM sites WHERE name LIKE ? OR url LIKE ? OR catelog LIKE ? OR \`desc\` LIKE ?`;
        queryBindParams = [likeKeyword, likeKeyword, likeKeyword, likeKeyword, pageSize, offset];
        countQueryParams = [likeKeyword, likeKeyword, likeKeyword, likeKeyword];

        if (catalog) {
          query = `SELECT id, name, url, logo, \`desc\`, catelog, sort_order, create_time, update_time,
             health_status, health_error, health_checked_at
             FROM sites WHERE catelog = ? AND (name LIKE ? OR url LIKE ? OR catelog LIKE ? OR \`desc\` LIKE ?) ORDER BY sort_order ASC, create_time DESC LIMIT ? OFFSET ?`;
          countQuery = `SELECT COUNT(*) as total FROM sites WHERE catelog = ? AND (name LIKE ? OR url LIKE ? OR catelog LIKE ? OR \`desc\` LIKE ?)`;
          queryBindParams = [catalog, likeKeyword, likeKeyword, likeKeyword, likeKeyword, pageSize, offset];
          countQueryParams = [catalog, likeKeyword, likeKeyword, likeKeyword, likeKeyword];
        }
      }

      const { results } = await env.NAV_DB.prepare(query).bind(...queryBindParams).all();
      const countResult = await env.NAV_DB.prepare(countQuery).bind(...countQueryParams).first();
      const total = countResult ? countResult.total : 0;

      return new Response(
        JSON.stringify({ code: 200, data: results, total, page, pageSize }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      return this.errorResponse(`Failed to fetch config data: ${e.message}`, 500);
    }
  },

  async getPendingConfig(request, env, ctx, url) {
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);
    const offset = (page - 1) * pageSize;
    try {
      const { results } = await env.NAV_DB.prepare(
        `SELECT * FROM pending_sites ORDER BY create_time DESC LIMIT ? OFFSET ?`
      ).bind(pageSize, offset).all();
      const countResult = await env.NAV_DB.prepare(`SELECT COUNT(*) as total FROM pending_sites`).first();
      const total = countResult ? countResult.total : 0;
      return new Response(
        JSON.stringify({ code: 200, data: results, total, page, pageSize }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      return this.errorResponse(`Failed to fetch pending config data: ${e.message}`, 500);
    }
  },

  async approvePendingConfig(request, env, ctx, id) {
    try {
      const { results } = await env.NAV_DB.prepare('SELECT * FROM pending_sites WHERE id = ?').bind(id).all();
      if (results.length === 0) return this.errorResponse('Pending config not found', 404);
      const config = results[0];
      await env.NAV_DB.prepare(
        `INSERT INTO sites (name, url, logo, desc, catelog, sort_order) VALUES (?, ?, ?, ?, ?, 9999)`
      ).bind(config.name, config.url, config.logo, config.desc, config.catelog).run();
      await env.NAV_DB.prepare('DELETE FROM pending_sites WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ code: 200, message: 'Pending config approved successfully' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to approve pending config : ${e.message}`, 500);
    }
  },

  async rejectPendingConfig(request, env, ctx, id) {
    try {
      await env.NAV_DB.prepare('DELETE FROM pending_sites WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ code: 200, message: 'Pending config rejected successfully' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to reject pending config: ${e.message}`, 500);
    }
  },

  async submitConfig(request, env, ctx) {
    try {
      if (!isSubmissionEnabled(env)) return this.errorResponse('Public submission disabled', 403);
      const config = await request.json();
      const { name, url, logo, desc, catelog } = config;
      const sanitizedName = (name || '').trim();
      const sanitizedUrl = (url || '').trim();
      const sanitizedCatelog = (catelog || '').trim();
      const sanitizedLogo = (logo || '').trim() || null;
      const sanitizedDesc = (desc || '').trim() || null;
      if (!sanitizedName || !sanitizedUrl || !sanitizedCatelog) {
        return this.errorResponse('Name, URL and Catelog are required', 400);
      }
      await env.NAV_DB.prepare(
        `INSERT INTO pending_sites (name, url, logo, desc, catelog) VALUES (?, ?, ?, ?, ?)`
      ).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, sanitizedCatelog).run();
      return new Response(JSON.stringify({ code: 201, message: '提交成功，等待管理员审核' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to submit config : ${e.message}`, 500);
    }
  },

  async createConfig(request, env, ctx) {
    try {
      const config = await request.json();
      const { name, url, logo, desc, catelog, sort_order } = config;
      const sanitizedName = (name || '').trim();
      const sanitizedUrl = (url || '').trim();
      const sanitizedCatelog = (catelog || '').trim();
      const sanitizedLogo = (logo || '').trim() || null;
      const sanitizedDesc = (desc || '').trim() || null;
      const sortOrderValue = normalizeSortOrder(sort_order);
      if (!sanitizedName || !sanitizedUrl || !sanitizedCatelog) {
        return this.errorResponse('Name, URL and Catelog are required', 400);
      }
      const insert = await env.NAV_DB.prepare(
        `INSERT INTO sites (name, url, logo, desc, catelog, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, sanitizedCatelog, sortOrderValue).run();
      return new Response(JSON.stringify({ code: 201, message: 'Config created successfully', insert }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to create config : ${e.message}`, 500);
    }
  },

  async updateConfig(request, env, ctx, id) {
    try {
      const config = await request.json();
      const { name, url, logo, desc, catelog, sort_order } = config;
      const sanitizedName = (name || '').trim();
      const sanitizedUrl = (url || '').trim();
      const sanitizedCatelog = (catelog || '').trim();
      const sanitizedLogo = (logo || '').trim() || null;
      const sanitizedDesc = (desc || '').trim() || null;
      const sortOrderValue = normalizeSortOrder(sort_order);
      if (!sanitizedName || !sanitizedUrl || !sanitizedCatelog) {
        return this.errorResponse('Name, URL and Catelog are required', 400);
      }
      const update = await env.NAV_DB.prepare(
        `UPDATE sites SET name = ?, url = ?, logo = ?, desc = ?, catelog = ?, sort_order = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, sanitizedCatelog, sortOrderValue, id).run();
      return new Response(JSON.stringify({ code: 200, message: 'Config updated successfully', update }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to update config: ${e.message}`, 500);
    }
  },

  async deleteConfig(request, env, ctx, id) {
    try {
      const del = await env.NAV_DB.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ code: 200, message: 'Config deleted successfully', del }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to delete config: ${e.message}`, 500);
    }
  },

  async batchSortConfig(request, env, ctx) {
    try {
      const body = await request.json();
      const { items } = body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return this.errorResponse('请提供排序数据', 400);
      }
      if (items.length > 500) {
        return this.errorResponse('单次最多排序 500 条', 400);
      }
      const caseSql = items.map((item) => {
        return `WHEN id = ${parseInt(item.id)} THEN ${normalizeSortOrder(item.sort_order)}`;
      }).join(' ');
      await env.NAV_DB.prepare(
        `UPDATE sites SET sort_order = CASE ${caseSql} ELSE sort_order END, update_time = CURRENT_TIMESTAMP`
      ).run();
      return new Response(JSON.stringify({ code: 200, message: `已更新 ${items.length} 条排序` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`批量排序失败: ${e.message}`, 500);
    }
  },

  async batchDeleteSites(request, env, ctx) {
    try {
      const body = await request.json();
      const { ids } = body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return this.errorResponse('请提供要删除的 ID 列表', 400);
      }
      if (ids.length > 100) {
        return this.errorResponse('单次最多删除 100 条', 400);
      }
      const placeholders = ids.map(() => '?').join(',');
      await env.NAV_DB.prepare(`DELETE FROM sites WHERE id IN (${placeholders})`).bind(...ids).run();
      return new Response(JSON.stringify({ code: 200, message: `已删除 ${ids.length} 条` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`批量删除失败: ${e.message}`, 500);
    }
  },

  async batchUpdateCategory(request, env, ctx) {
    try {
      const body = await request.json();
      const { ids, category } = body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return this.errorResponse('请提供要修改的 ID 列表', 400);
      }
      if (!category || !category.trim()) {
        return this.errorResponse('请提供目标分类', 400);
      }
      if (ids.length > 100) {
        return this.errorResponse('单次最多修改 100 条', 400);
      }
      const placeholders = ids.map(() => '?').join(',');
      await env.NAV_DB.prepare(
        `UPDATE sites SET catelog = ?, update_time = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      ).bind(category.trim(), ...ids).run();
      return new Response(JSON.stringify({ code: 200, message: `已更新 ${ids.length} 条分类为 "${category.trim()}"` }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`批量修改分类失败: ${e.message}`, 500);
    }
  },

  async importConfig(request, env, ctx) {
    try {
      const jsonData = await request.json();
      let sitesToImport = [];
      if (Array.isArray(jsonData)) {
        sitesToImport = jsonData;
      } else if (jsonData && typeof jsonData === 'object' && Array.isArray(jsonData.data)) {
        sitesToImport = jsonData.data;
      } else {
        return this.errorResponse('Invalid JSON data. Must be an array or object with "data" key.', 400);
      }

      if (sitesToImport.length === 0) {
        return new Response(JSON.stringify({ code: 200, message: '导入成功，但文件中没有数据。' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const MAX_IMPORT = 5000;
      if (sitesToImport.length > MAX_IMPORT) {
        return this.errorResponse(`单次最多导入 ${MAX_IMPORT} 条，当前 ${sitesToImport.length} 条`, 400);
      }

      const existingMap = new Map();
      const { results: existing } = await env.NAV_DB.prepare(`SELECT name, url FROM sites`).all();
      existing.forEach(row => {
        existingMap.set(`${row.name}|||${row.url}`, true);
      });

      let imported = 0, skipped = 0, skippedList = [];
      const insertStatements = [];
      for (const item of sitesToImport) {
        const name = (item.name || '').trim();
        const url = (item.url || '').trim();
        if (!name || !url) continue;
        const key = `${name}|||${url}`;
        if (existingMap.has(key)) {
          skipped++;
          skippedList.push({ name, url, reason: '已存在' });
          continue;
        }
        const logo = (item.logo || '').trim() || null;
        const desc = (item.desc || '').trim() || null;
        const catelog = (item.catelog || '').trim() || '未分类';
        const sortOrder = normalizeSortOrder(item.sort_order);
        insertStatements.push(
          env.NAV_DB.prepare(
            `INSERT INTO sites (name, url, logo, desc, catelog, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(name, url, logo, desc, catelog, sortOrder)
        );
        imported++;
        if (insertStatements.length >= 100) {
          await env.NAV_DB.batch(insertStatements);
          insertStatements.length = 0;
        }
      }
      if (insertStatements.length > 0) {
        await env.NAV_DB.batch(insertStatements);
      }

      return new Response(JSON.stringify({
        code: 201,
        message: `导入完成：成功 ${imported} 条，跳过 ${skipped} 条（已存在）`,
        imported, skipped,
        skippedList: skippedList.slice(0, 50)
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return this.errorResponse(`Failed to import config : ${error.message}`, 500);
    }
  },

  async exportConfig(request, env, ctx, url) {
    try {
      const catalog = url.searchParams.get('catalog');
      const MAX_EXPORT = 5000;
      let query = 'SELECT * FROM sites ORDER BY sort_order ASC, create_time DESC';
      let params = [];
      if (catalog && catalog.trim()) {
        query = 'SELECT * FROM sites WHERE catelog = ? ORDER BY sort_order ASC, create_time DESC';
        params = [catalog.trim()];
      }

      const { results } = await env.NAV_DB.prepare(query).bind(...params).all();
      if (results.length > MAX_EXPORT) {
        return this.errorResponse(`数据量 ${results.length} 条超过导出上限 ${MAX_EXPORT} 条，请使用分类导出`, 400);
      }

      const pureJsonData = JSON.stringify(results, null, 2);
      const filename = catalog ? `config_${catalog}.json` : 'config.json';
      return new Response(pureJsonData, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`
        }
      });
    } catch (e) {
      return this.errorResponse(`Failed to export config: ${e.message}`, 500);
    }
  },

  async getCategories(request, env, ctx) {
    try {
      const categoryOrderMap = new Map();
      try {
        const { results: orderRows } = await env.NAV_DB.prepare('SELECT catelog, sort_order FROM category_orders').all();
        orderRows.forEach(row => {
          categoryOrderMap.set(row.catelog, normalizeSortOrder(row.sort_order));
        });
      } catch (error) {
        if (!/no such table/i.test(error.message || '')) throw error;
      }

      const { results } = await env.NAV_DB.prepare(`
        SELECT catelog, COUNT(*) AS site_count, MIN(sort_order) AS min_site_sort
        FROM sites GROUP BY catelog
      `).all();

      const data = results.map(row => ({
        catelog: row.catelog,
        site_count: row.site_count,
        sort_order: categoryOrderMap.has(row.catelog)
          ? categoryOrderMap.get(row.catelog)
          : normalizeSortOrder(row.min_site_sort),
        explicit: categoryOrderMap.has(row.catelog),
        min_site_sort: row.min_site_sort === null ? 9999 : normalizeSortOrder(row.min_site_sort)
      }));

      data.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        if (a.min_site_sort !== b.min_site_sort) return a.min_site_sort - b.min_site_sort;
        return a.catelog.localeCompare(b.catelog, 'zh-Hans-CN', { sensitivity: 'base' });
      });

      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return this.errorResponse(`Failed to fetch categories: ${e.message}`, 500);
    }
  },

  errorResponse(message, status) {
    return new Response(JSON.stringify({ code: status, message }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// ============================================================
// 后台管理页面处理
// ============================================================
const admin = {
  async handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/admin/logout') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const { token } = await validateAdminSession(request, env);
      if (token) await destroyAdminSession(env, token);
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': buildSessionCookie('', { maxAge: 0 }),
        },
      });
    }

    if (url.pathname === '/admin') {
      if (request.method === 'POST') {
        const formData = await request.formData();
        const name = (formData.get('name') || '').trim();
        const password = (formData.get('password') || '').trim();
        const storedUsername = await env.NAV_AUTH.get('admin_username');
        const storedPassword = await env.NAV_AUTH.get('admin_password');
        const isValid = storedUsername && storedPassword && name === storedUsername && password === storedPassword;
        if (isValid) {
          const token = await createAdminSession(env);
          return new Response(null, {
            status: 302,
            headers: {
              'Location': '/admin',
              'Set-Cookie': buildSessionCookie(token),
            },
          });
        }
        return this.renderLoginPage('账号或密码错误，请重试。');
      }

      const session = await validateAdminSession(request, env);
      if (session.authenticated) {
        const config = await getSiteConfig(env);
        return this.renderAdminPage(config);
      }
      return this.renderLoginPage();
    }

    if (url.pathname.startsWith('/static')) return this.handleStatic(request, env, ctx);
    return new Response('页面不存在', { status: 404 });
  },

  async handleStatic(request, env, ctx) {
    const url = new URL(request.url);
    const filePath = url.pathname.replace('/static/', '');
    let contentType = 'text/plain';
    if (filePath.endsWith('.css')) contentType = 'text/css';
    if (filePath.endsWith('.js')) contentType = 'application/javascript';

    try {
      const fileContent = await this.getFileContent(filePath);
      return new Response(fileContent, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400'
        }
      });
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  },

  async getFileContent(filePath) {
    const fileContents = {
      'admin.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>__SITE_NAME__ - 管理</title>
  <link rel="icon" href="__SITE_ICON__" type="image/png" />
  <link rel="stylesheet" href="/static/admin.css" />
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet" />
</head>
<body>
  <div class="app">
    <!-- 侧边栏 -->
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">📚 __SITE_NAME__</div>
      <nav class="sidebar-nav">
        <a href="#" class="nav-item active" data-page="dashboard"><span class="nav-icon">📊</span> 概览</a>
        <a href="#" class="nav-item" data-page="links"><span class="nav-icon">🔗</span> 链接管理</a>
        <a href="#" class="nav-item" data-page="pending"><span class="nav-icon">⏳</span> 待审核</a>
        <a href="#" class="nav-item" data-page="categories"><span class="nav-icon">🏷️</span> 分类管理</a>
        <a href="#" class="nav-item" data-page="settings"><span class="nav-icon">⚙️</span> 站点设置</a>
      </nav>
    </aside>

    <!-- 主内容 -->
    <main class="main-content">
      <header class="topbar">
        <h1 id="pageTitle">概览</h1>
        <a href="/admin/logout" class="logout-btn-top" style="text-decoration:none;">🚪 退出登录</a>
      </header>

      <div class="page-container">
        <!-- 概览页 -->
        <section id="page-dashboard" class="page active">
          <div class="stats-grid">
            <div class="stat-card total">
              <div class="stat-number" id="totalCount">0</div>
              <div class="stat-label">总链接数</div>
            </div>
            <div class="stat-card total" style="background:linear-gradient(135deg,#22c55e,#16a34a);">
              <div class="stat-number" id="healthOkCount">0</div>
              <div class="stat-label">✅ 健康链接</div>
            </div>
            <div class="stat-card total" style="background:linear-gradient(135deg,#ef4444,#dc2626);">
              <div class="stat-number" id="healthFailCount">0</div>
              <div class="stat-label">❌ 异常链接</div>
            </div>
            <div class="stat-card import-export-card">
              <div class="import-export-actions">
                <input type="file" id="importFile" accept=".json" style="display:none;" />
                <button id="importBtn" class="btn-secondary">📥 导入</button>
                <button id="exportBtn" class="btn-secondary">📤 导出</button>
              </div>
              <div class="stat-label">数据导入 / 导出</div>
            </div>
          </div>
          <div class="category-section">
            <div class="category-section-header">
              <span class="category-section-title">📂 分类导航排序</span>
              <span class="category-section-hint">拖拽卡片调整顺序</span>
            </div>
            <div class="category-cards" id="categoryCards"></div>
          </div>
        </section>

        <!-- 链接管理页 -->
        <section id="page-links" class="page">
          <div class="toolbar">
            <div class="toolbar-left">
              <select id="catalogFilter"><option value="">全部分类</option></select>
              <select id="pageSizeSelect">
                <option value="10">10条/页</option>
                <option value="50">50条/页</option>
                <option value="100">100条/页</option>
              </select>
              <input type="text" id="searchInput" placeholder="🔍 搜索" />
              <button id="checkPageHealthBtn" class="btn-secondary" style="background:#22c55e;color:#fff;">🩺 检查当前页</button>
            </div>
            <div class="toolbar-right">
              <button id="addLinkBtn" class="btn-primary">➕ 添加</button>
              <button id="batchDeleteBtn" class="btn-secondary" style="color:#ef4444;">🗑️ 批量删除</button>
              <button id="batchCategoryBtn" class="btn-secondary">📂 批量改分类</button>
            </div>
          </div>
          <div id="message" class="message" style="display:none;"></div>
          <div class="table-wrapper">
            <table>
              <thead><tr>
                <th style="width:30px;"><input type="checkbox" id="selectAll" /></th>
                <th style="width:30px;">#</th>
                <th>ID</th>
                <th>名称</th>
                <th>URL</th>
                <th>Logo</th>
                <th>描述</th>
                <th>分类</th>
                <th>排序</th>
                <th>健康值</th>
                <th>检查时间</th>
                <th>操作</th>
              </tr></thead>
              <tbody id="configTableBody"></tbody>
            </table>
          </div>
          <div class="pagination">
            <button id="prevPage" disabled>上一页</button>
            <span id="currentPage">1</span> / <span id="totalPages">1</span>
            <button id="nextPage" disabled>下一页</button>
          </div>
          <div class="drag-hint" id="dragHint">💡 选择分类后可拖拽排序</div>
        </section>

        <!-- 待审核页 -->
        <section id="page-pending" class="page">
          <div class="toolbar"><span class="pending-hint">⏳ 等待审核</span></div>
          <div class="table-wrapper">
            <table>
              <thead><tr><th>ID</th><th>名称</th><th>URL</th><th>Logo</th><th>描述</th><th>分类</th><th>操作</th></tr></thead>
              <tbody id="pendingTableBody"></tbody>
            </table>
          </div>
          <div class="pagination">
            <button id="pendingPrevPage" disabled>上一页</button>
            <span id="pendingCurrentPage">1</span> / <span id="pendingTotalPages">1</span>
            <button id="pendingNextPage" disabled>下一页</button>
          </div>
        </section>

        <!-- 分类管理页 -->
        <section id="page-categories" class="page">
          <div class="category-toolbar">
            <p>📝 管理分类（数字越小越靠前）</p>
            <button id="refreshCategories" class="btn-secondary">🔄 刷新</button>
          </div>
          <div class="table-wrapper">
            <table>
              <thead><tr><th>分类</th><th>书签数量</th><th>排序值</th><th>操作</th></tr></thead>
              <tbody id="categoryTableBody"></tbody>
            </table>
          </div>
        </section>

        <!-- 站点设置页 -->
        <section id="page-settings" class="page">
          <div class="settings-container">
            <h2>站点基本设置</h2>
            <form id="settingsForm">
              <div class="form-group"><label>网站名称</label><input type="text" id="siteName" value="__SITE_NAME__" /></div>
              <div class="form-group"><label>网站图标</label><input type="text" id="siteIcon" value="__SITE_ICON__" /></div>
              <div class="form-group"><label>版权信息</label><input type="text" id="siteCopyright" value="__SITE_COPYRIGHT__" /></div>
              <div class="form-group"><label>博客链接</label><input type="text" id="siteBlog" value="__SITE_BLOG__" /></div>
              <div class="form-group"><label>背景图片</label><input type="text" id="siteBackground" value="__SITE_BACKGROUND__" /></div>
              <button type="submit" class="btn-primary">保存设置</button>
            </form>
            <div id="settingsMessage" class="message" style="display:none;"></div>
          </div>
        </section>
      </div>
    </main>
  </div>

  <!-- 添加/编辑弹窗 -->
  <div id="linkModal" class="modal">
    <div class="modal-content">
      <span class="modal-close">&times;</span>
      <h2 id="modalTitle">添加链接</h2>
      <form id="linkForm">
        <input type="hidden" id="editId" />
        <div class="form-group"><label>名称 *</label><input type="text" id="linkName" required /></div>
        <div class="form-group"><label>URL *</label><input type="text" id="linkUrl" required /></div>
        <div class="form-group">
          <label>Logo (可选)</label>
          <div class="logo-input-group">
            <input type="text" id="linkLogo" />
            <button type="button" class="magic-btn" data-url-input="linkUrl" data-logo-input="linkLogo">✨ 获取</button>
          </div>
        </div>
        <div class="form-group"><label>描述</label><input type="text" id="linkDesc" /></div>
        <div class="form-group">
          <label>分类 *</label>
          <input type="text" id="linkCatelog" required list="catalogDatalist" />
          <datalist id="catalogDatalist"></datalist>
        </div>
        <div class="form-group"><label>排序值</label><input type="number" id="linkSortOrder" /></div>
        <div class="form-actions">
          <button type="button" class="btn-secondary" id="cancelModal">取消</button>
          <button type="submit" class="btn-primary" id="submitLinkBtn">保存</button>
        </div>
      </form>
    </div>
  </div>

  <!-- 批量修改分类弹窗 -->
  <div id="batchCategoryModal" class="modal">
    <div class="modal-content">
      <span class="modal-close" id="batchCategoryClose">&times;</span>
      <h2>批量修改分类</h2>
      <form id="batchCategoryForm">
        <div class="form-group">
          <label>目标分类</label>
          <input type="text" id="batchCategoryInput" required list="catalogDatalist2" />
          <datalist id="catalogDatalist2"></datalist>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-secondary" id="batchCategoryCancel">取消</button>
          <button type="submit" class="btn-primary">确认修改</button>
        </div>
      </form>
    </div>
  </div>

  <!-- 重命名分类弹窗 -->
  <div id="renameModal" class="modal">
    <div class="modal-content">
      <span class="modal-close" id="renameModalClose">&times;</span>
      <h2>重命名分类</h2>
      <form id="renameForm">
        <div class="form-group"><label>新分类名称</label><input type="text" id="renameInput" required /></div>
        <div class="form-actions">
          <button type="button" class="btn-secondary" id="renameCancel">取消</button>
          <button type="submit" class="btn-primary">保存</button>
        </div>
      </form>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <div id="confirmModal" class="modal">
    <div class="modal-content" style="max-width:420px;">
      <h2 id="confirmTitle">确认操作</h2>
      <p id="confirmMessage" style="color:#475569;margin:12px 0 20px;"></p>
      <div class="form-actions">
        <button type="button" class="btn-secondary" id="confirmCancel">取消</button>
        <button type="button" class="btn-primary" id="confirmOk" style="background:#ef4444;">确认</button>
      </div>
    </div>
  </div>

  <!-- 加载指示器 -->
  <div id="globalLoader" class="global-loader" style="display:none;">
    <div class="loader-overlay">
      <div class="loader-spinner"></div>
      <div class="loader-check"></div>
      <p id="loaderText" class="loader-text">处理中...</p>
      <button id="loaderClose" class="loader-close" style="display:none;">✕</button>
    </div>
  </div>

  <script src="/static/admin.js"></script>
</body>
</html>`,
      'admin.css': `/* ===== 全局重置 ===== */
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Noto Sans SC', sans-serif;
  background: #f1f5f9;
  color: #0f172a;
  height: 100vh;
  overflow: hidden;
}
.app { display: flex; height: 100vh; }

/* ===== 侧边栏 ===== */
.sidebar {
  width: 220px;
  background: #0f172a;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding: 24px 0 20px;
}
.sidebar-brand { font-size: 20px; font-weight: 700; padding: 0 20px 32px; color: #f1f5f9; }
.sidebar-nav { flex: 1; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  color: #94a3b8;
  text-decoration: none;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: 0.2s;
  font-size: 15px;
  position: relative;
}
.nav-item:hover { background: #1e293b; color: #f1f5f9; }
.nav-item.active { background: #1e293b; border-left-color: #818cf8; color: #f1f5f9; }
.nav-icon { font-size: 18px; width: 24px; text-align: center; }

/* ===== 主内容 ===== */
.main-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #f8fafc; }
.topbar {
  background: #fff;
  padding: 14px 32px;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.topbar h1 { font-size: 22px; font-weight: 600; color: #0f172a; }
.logout-btn-top {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  padding: 8px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: #475569;
  transition: 0.2s;
  font-weight: 500;
  text-decoration: none;
}
.logout-btn-top:hover { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }

.page-container { flex: 1; overflow-y: auto; padding: 24px 32px 40px; }
.page { display: none; }
.page.active { display: block; }

/* ===== 统计卡片 ===== */
.stats-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 28px;
}
.stat-card {
  background: #fff;
  border-radius: 14px;
  padding: 20px 28px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  flex: 1 1 180px;
  min-width: 140px;
}
.stat-card.total { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; }
.stat-number { font-size: 34px; font-weight: 700; }
.stat-label { font-size: 14px; opacity: 0.85; margin-top: 4px; }
.import-export-card { display: flex; flex-direction: column; justify-content: center; background: #fff; }
.import-export-actions { display: flex; gap: 10px; margin-bottom: 6px; align-items: center; }
.import-export-actions .btn-secondary { padding: 6px 18px; font-size: 14px; }

/* ===== 分类卡片 ===== */
.category-section {
  background: #fff;
  border-radius: 14px;
  padding: 20px 24px 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.category-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.category-section-title { font-size: 16px; font-weight: 600; color: #0f172a; }
.category-section-hint { font-size: 13px; color: #94a3b8; }
.category-cards { display: flex; flex-wrap: wrap; gap: 10px; }
.category-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px 18px;
  cursor: grab;
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
}
.category-card:active { cursor: grabbing; }
.category-card.dragging { opacity: 0.4; }
.category-card .cat-name { font-weight: 500; font-size: 14px; }
.category-card .cat-count { background: #e2e8f0; padding: 0 12px; border-radius: 12px; font-size: 12px; color: #475569; }
.category-card .drag-icon { color: #94a3b8; font-size: 16px; }

/* ===== 工具栏 ===== */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  background: #fff;
  padding: 12px 18px;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.toolbar-left { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }
.toolbar select, .toolbar input {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  background: #fff;
}
.toolbar input[type="text"] { min-width: 160px; }

/* ===== 按钮 ===== */
.btn-primary {
  background: #4f46e5;
  color: #fff;
  border: none;
  padding: 6px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: 0.2s;
}
.btn-primary:hover { background: #4338ca; }
.btn-secondary {
  background: #f1f5f9;
  color: #334155;
  border: 1px solid #d1d5db;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: 0.2s;
}
.btn-secondary:hover { background: #e2e8f0; }

/* ===== 表格 ===== */
.table-wrapper {
  overflow-x: auto;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 900px; table-layout: auto; }
th {
  background: #f8fafc;
  text-align: left;
  padding: 8px 10px;
  font-weight: 600;
  color: #475569;
  border-bottom: 2px solid #e2e8f0;
  white-space: nowrap;
}
td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
tr:hover td { background: #fafbfc; }
tr.dragging td { background: #e0e7ff; }

input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  vertical-align: middle;
  cursor: pointer;
  display: inline-block;
}

.health-loading {
  display: inline-block;
  animation: spin 1s linear infinite;
  font-size: 16px;
}
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.actions { display: flex; gap: 4px; flex-wrap: wrap; }
.actions button { padding: 2px 8px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer; }
.edit-btn { background: #3b82f6; color: #fff; }
.edit-btn:hover { background: #2563eb; }
.del-btn { background: #ef4444; color: #fff; }
.del-btn:hover { background: #dc2626; }
.approve-btn { background: #22c55e; color: #fff; }
.approve-btn:hover { background: #16a34a; }
.reject-btn { background: #f59e0b; color: #fff; }
.reject-btn:hover { background: #d97706; }
.health-ok { color: #22c55e; font-weight: 600; }
.health-fail { color: #ef4444; font-weight: 600; cursor: help; }
.health-unknown { color: #94a3b8; }

/* ===== 分页 ===== */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
}
.pagination button {
  background: #f1f5f9;
  border: 1px solid #d1d5db;
  padding: 4px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.pagination button:disabled { opacity: 0.5; cursor: not-allowed; }

.drag-hint { margin-top: 12px; font-size: 13px; color: #94a3b8; text-align: center; }

/* ===== 消息 ===== */
.message { padding: 10px 16px; border-radius: 8px; margin-bottom: 12px; display: none; }
.message.success { background: #dcfce7; color: #166534; display: block; }
.message.error { background: #fee2e2; color: #991b1b; display: block; }

/* ===== 模态框 ===== */
.modal {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,0.5);
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal.active { display: flex; }
.modal-content {
  background: #fff;
  border-radius: 14px;
  padding: 28px 32px;
  max-width: 520px;
  width: 92%;
  max-height: 90vh;
  overflow-y: auto;
  position: relative;
  box-shadow: 0 20px 60px rgba(0,0,0,0.15);
}
.modal-close {
  position: absolute;
  top: 10px;
  right: 16px;
  font-size: 28px;
  cursor: pointer;
  color: #94a3b8;
}
.modal-close:hover { color: #475569; }
.modal h2 { margin-bottom: 16px; font-size: 20px; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-weight: 500; margin-bottom: 4px; font-size: 14px; color: #475569; }
.form-group input, .form-group textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}
.form-group input:focus, .form-group textarea:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
.logo-input-group { display: flex; gap: 8px; }
.logo-input-group input { flex: 1; }
.magic-btn {
  background: #e2e8f0;
  border: none;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: #334155;
}
.magic-btn:hover { background: #cbd5e1; }
.form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }

/* ===== 分类管理 ===== */
.category-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
  background: #fff;
  padding: 12px 18px;
  border-radius: 10px;
}
.category-toolbar p { font-size: 14px; color: #64748b; margin: 0; }
.category-sort-input { width: 80px; padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; }
.category-actions { display: flex; gap: 4px; }
.category-actions button { padding: 3px 10px; font-size: 12px; border-radius: 4px; border: none; cursor: pointer; }
.category-save-btn { background: #3b82f6; color: #fff; }
.category-save-btn:hover { background: #2563eb; }
.category-rename-btn { background: #8b5cf6; color: #fff; }
.category-rename-btn:hover { background: #7c3aed; }
.category-delete-btn { background: #ef4444; color: #fff; }
.category-delete-btn:hover { background: #dc2626; }

/* ===== 站点设置 ===== */
.settings-container {
  background: #fff;
  border-radius: 14px;
  padding: 30px;
  max-width: 600px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.settings-container h2 { margin-bottom: 24px; font-size: 20px; }
.settings-container .form-group { margin-bottom: 20px; }
.settings-container .form-group input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}

/* ===== 加载指示器 ===== */
.global-loader {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(15,23,42,0.4);
  backdrop-filter: blur(4px);
}
.global-loader.show { display: flex; }
.loader-overlay {
  background: #fff;
  border-radius: 16px;
  padding: 32px 40px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.2);
  text-align: center;
  min-width: 200px;
  position: relative;
}
.loader-spinner {
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  border: 4px solid #e2e8f0;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.loader-text { font-size: 16px; color: #0f172a; margin: 0; font-weight: 500; }
.loader-close {
  position: absolute;
  top: 8px;
  right: 12px;
  background: none;
  border: none;
  font-size: 20px;
  color: #94a3b8;
  cursor: pointer;
  display: none;
}
.loader-close:hover { color: #475569; }
.loader-check {
  font-size: 48px;
  color: #22c55e;
  margin-bottom: 8px;
  display: none;
}
.loader-check.show { display: block; }
.loader-spinner.hidden { display: none; }

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .sidebar { width: 60px; padding: 16px 0; }
  .sidebar-brand { font-size: 0; padding: 0 0 20px 0; justify-content: center; }
  .sidebar-brand::before { content: "📚"; font-size: 24px; }
  .nav-item span:not(.nav-icon) { display: none; }
  .nav-item { justify-content: center; padding: 14px 0; }
  .topbar { padding: 12px 16px; }
  .topbar h1 { font-size: 18px; }
  .page-container { padding: 16px; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar-left, .toolbar-right { flex-wrap: wrap; }
  .stats-grid { flex-direction: column; }
  .category-cards { justify-content: center; }
  .logout-btn-top { font-size: 13px; padding: 6px 14px; }
  .settings-container { padding: 20px; }
}`,
      'admin.js': `// ============================================================
// 全局状态
// ============================================================
let currentPage = 1, pageSize = 10, totalItems = 0;
let currentCatalog = '', currentKeyword = '';
let pendingPage = 1, pendingPageSize = 10, pendingTotal = 0;
let allCategories = [];
let renameCategory = '';
let selectedIds = new Set();

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const pages = {
  dashboard: $('page-dashboard'),
  links: $('page-links'),
  pending: $('page-pending'),
  categories: $('page-categories'),
  settings: $('page-settings'),
};
const navItems = $$('.nav-item');
const pageTitle = $('pageTitle');

const totalCountEl = $('totalCount');
const healthOkCount = $('healthOkCount');
const healthFailCount = $('healthFailCount');
const categoryCardsEl = $('categoryCards');

const configBody = $('configTableBody');
const prevBtn = $('prevPage'), nextBtn = $('nextPage');
const currentPageSpan = $('currentPage'), totalPagesSpan = $('totalPages');
const catalogFilter = $('catalogFilter'), pageSizeSelect = $('pageSizeSelect');
const searchInput = $('searchInput'), addLinkBtn = $('addLinkBtn');
const importBtn = $('importBtn'), exportBtn = $('exportBtn'), importFile = $('importFile');
const messageEl = $('message');
const dragHint = $('dragHint');
const selectAll = $('selectAll');
const batchDeleteBtn = $('batchDeleteBtn');
const batchCategoryBtn = $('batchCategoryBtn');
const checkPageHealthBtn = $('checkPageHealthBtn');

const pendingBody = $('pendingTableBody');
const pendingPrev = $('pendingPrevPage'), pendingNext = $('pendingNextPage');
const pendingCurrent = $('pendingCurrentPage'), pendingTotalPages = $('pendingTotalPages');

const categoryBody = $('categoryTableBody');
const refreshCatsBtn = $('refreshCategories');

const settingsForm = $('settingsForm');
const siteNameInput = $('siteName'), siteIconInput = $('siteIcon');
const siteCopyrightInput = $('siteCopyright'), siteBlogInput = $('siteBlog');
const siteBackgroundInput = $('siteBackground');
const settingsMessage = $('settingsMessage');

const linkModal = $('linkModal');
const modalClose = linkModal.querySelector('.modal-close');
const modalTitle = $('modalTitle');
const linkForm = $('linkForm');
const editId = $('editId');
const linkName = $('linkName'), linkUrl = $('linkUrl'), linkLogo = $('linkLogo');
const linkDesc = $('linkDesc'), linkCatelog = $('linkCatelog'), linkSortOrder = $('linkSortOrder');
const cancelModal = $('cancelModal');
const catalogDatalist = $('catalogDatalist');
const submitLinkBtn = $('submitLinkBtn');

const renameModal = $('renameModal');
const renameInput = $('renameInput');
const renameCancel = $('renameCancel');
const renameModalClose = $('renameModalClose');

const batchCategoryModal = $('batchCategoryModal');
const batchCategoryInput = $('batchCategoryInput');
const batchCategoryClose = $('batchCategoryClose');
const batchCategoryCancel = $('batchCategoryCancel');

const confirmModal = $('confirmModal');
const confirmTitle = $('confirmTitle');
const confirmMessage = $('confirmMessage');
const confirmOk = $('confirmOk');
const confirmCancel = $('confirmCancel');

const loader = $('globalLoader');
const loaderText = $('loaderText');
const loaderSpinner = loader.querySelector('.loader-spinner');
const loaderCheck = loader.querySelector('.loader-check');
const loaderClose = $('loaderClose');
// ============================================================
// Toast 通知（右上角轻提示）
// ============================================================
// ============================================================
// Toast 通知（右上角轻提示）
// ============================================================
function showToast(message, type = 'success', duration = 2000) {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  
  const icon = document.createElement('span');
  icon.textContent = type === 'success' ? '✅' : '❌';
  const msg = document.createElement('span');
  msg.textContent = message;
  
  toast.appendChild(icon);
  toast.appendChild(msg);
  
  Object.assign(toast.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    zIndex: '10000',
    padding: '12px 24px',
    background: type === 'success' ? '#22c55e' : '#ef4444',
    color: '#fff',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: '500',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    fontFamily: "'Noto Sans SC', sans-serif",
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    opacity: '0',
    transform: 'translateY(-12px)',
    transition: 'opacity 0.3s ease, transform 0.3s ease',
    pointerEvents: 'none',
    maxWidth: '420px'
  });
  
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-12px)';
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ============================================================
// 加载指示器
// ============================================================
function showLoader(text = '处理中...') {
  loader.style.display = 'flex';
  loaderText.textContent = text;
  loaderSpinner.classList.remove('hidden');
  loaderCheck.classList.remove('show');
  loaderClose.style.display = 'none';
  document.querySelectorAll('button:not(.loader-close)').forEach(btn => btn.disabled = true);
}
function hideLoader() {
  loader.style.display = 'none';
  document.querySelectorAll('button').forEach(btn => btn.disabled = false);
}
function showLoaderDone(text = '完成！') {
  loaderText.textContent = text;
  loaderSpinner.classList.add('hidden');
  loaderCheck.classList.add('show');
  loaderClose.style.display = 'block';
  document.querySelectorAll('button:not(.loader-close)').forEach(btn => btn.disabled = false);
}
loaderClose.addEventListener('click', hideLoader);
// ============================================================
// 确认弹窗
// ============================================================
function showConfirm(title, message, onConfirm) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmModal.classList.add('active');
  confirmOk.onclick = function() {
    confirmModal.classList.remove('active');
    if (onConfirm) onConfirm();
  };
}
confirmCancel.addEventListener('click', () => confirmModal.classList.remove('active'));
confirmModal.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });

// ============================================================
// 工具函数
// ============================================================
function escapeHTML(v) { return v == null ? '' : String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function normalizeUrl(v) { let t = String(v||'').trim(); return /^https?:\\/\\//i.test(t) ? t : (/^[\\w.-]+\\.[\\w.-]+/.test(t) ? 'https://'+t : ''); }
function showMessage(msg, type, target) {
  target = target || messageEl;
  target.textContent = msg;
  target.className = 'message ' + type;
  target.style.display = 'block';
  setTimeout(() => { target.style.display = 'none'; }, 4000);
}
function getHealthIcon(status, error) {
  if (status === 1) return '<span class="health-ok">🟢 正常</span>';
  if (status === 2) {
    const errMsg = error || '未知错误';
    return '<span class="health-fail" title="异常原因: ' + escapeHTML(errMsg) + '">🔴 异常</span>';
  }
  return '<span class="health-unknown">⚪ 未检查</span>';
}


// ============================================================
// 导航切换
// ============================================================
navItems.forEach(item => {
  item.addEventListener('click', function(e) {
    e.preventDefault();
    const page = this.dataset.page;
    navItems.forEach(n => n.classList.remove('active'));
    this.classList.add('active');
    Object.keys(pages).forEach(key => pages[key].classList.toggle('active', key === page));
    const titles = {
      dashboard:'概览', links:'链接管理', pending:'待审核',
      categories:'分类管理', settings:'站点设置'
    };
    pageTitle.textContent = titles[page] || page;
    if (page === 'dashboard') { loadDashboard(); }
    if (page === 'links') fetchConfigs();
    if (page === 'pending') fetchPending();
    if (page === 'categories') fetchCategories();
    if (page === 'settings') loadSettings();
  });
});

// ============================================================
// 概览页
// ============================================================
async function loadDashboard() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    if (data.code === 200) {
      const cats = data.data || [];
      let total = cats.reduce((s, c) => s + c.site_count, 0);
      totalCountEl.textContent = total;
      allCategories = cats;
      const curVal = catalogFilter.value;
      catalogFilter.innerHTML = '<option value="">全部分类</option>';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.catelog;
        opt.textContent = c.catelog + ' (' + c.site_count + ')';
        catalogFilter.appendChild(opt);
      });
      if (curVal) catalogFilter.value = curVal;
      catalogDatalist.innerHTML = cats.map(c => '<option value="'+escapeHTML(c.catelog)+'">').join('');
      document.getElementById('catalogDatalist2').innerHTML = cats.map(c => '<option value="'+escapeHTML(c.catelog)+'">').join('');
      renderCategoryCards(cats);
      // 健康统计
      const totalRes = await fetch('/api/config?page=1&pageSize=10000');
      const totalData = await totalRes.json();
      if (totalData.code === 200) {
        const allSites = totalData.data || [];
        const ok = allSites.filter(s => s.health_status === 1).length;
        const fail = allSites.filter(s => s.health_status === 2).length;
        healthOkCount.textContent = ok;
        healthFailCount.textContent = fail;
      }
    }
  } catch(e) { console.error(e); }
}

function renderCategoryCards(cats) {
  categoryCardsEl.innerHTML = '';
  cats.forEach(c => {
    const card = document.createElement('div');
    card.className = 'category-card';
    card.draggable = true;
    card.dataset.catelog = c.catelog;
    card.innerHTML = \`<span class="drag-icon">⠿</span><span class="cat-name">\${escapeHTML(c.catelog)}</span><span class="cat-count">\${c.site_count}</span>\`;
    categoryCardsEl.appendChild(card);
  });
  bindCategoryDrag();
}

let dragSrcCard = null;
function bindCategoryDrag() {
  const cards = categoryCardsEl.querySelectorAll('.category-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', function(e) {
      dragSrcCard = this;
      e.dataTransfer.effectAllowed = 'move';
      this.classList.add('dragging');
    });
    card.addEventListener('dragend', function() { this.classList.remove('dragging'); });
    card.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    card.addEventListener('drop', function(e) {
      e.preventDefault();
      if (dragSrcCard && dragSrcCard !== this) {
        const parent = this.parentNode;
        const all = Array.from(parent.children);
        const si = all.indexOf(dragSrcCard);
        const ti = all.indexOf(this);
        if (si < ti) parent.insertBefore(dragSrcCard, this.nextSibling);
        else parent.insertBefore(dragSrcCard, this);
        saveCategoryOrder();
      }
    });
  });
}

async function saveCategoryOrder() {
  const cards = categoryCardsEl.querySelectorAll('.category-card');
  const items = [];
  cards.forEach((card, idx) => {
    const cat = card.dataset.catelog;
    if (cat) items.push({ id: cat, sort_order: idx + 1 });
  });
  if (items.length === 0) return;

  try {
    // 并行执行：所有请求同时发出，等待全部完成
    await Promise.all(items.map(item =>
      fetch('/api/categories/' + encodeURIComponent(item.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort_order: item.sort_order })
      })
    ));
    showToast('分类排序已保存 ✅', 'success', 1500);
  } catch (e) {
    showToast('分类排序保存失败 ❌', 'error', 2500);
  }
}

// ============================================================
// 链接管理
// ============================================================
function fetchConfigs(page = currentPage) {
  let effectivePageSize = pageSize;
  if (currentCatalog !== '') effectivePageSize = Math.min(pageSize, 500);
  configBody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:30px;color:#94a3b8;">加载中...</td></tr>';
  let url = \`/api/config?page=\${page}&pageSize=\${effectivePageSize}\`;
  if (currentCatalog) url += \`&catalog=\${encodeURIComponent(currentCatalog)}\`;
  if (currentKeyword) url += \`&keyword=\${encodeURIComponent(currentKeyword)}\`;
  fetch(url).then(r => r.json()).then(data => {
    if (data.code === 200) {
      totalItems = data.total; currentPage = data.page;
      const totalPages = Math.ceil(totalItems / effectivePageSize);
      totalPagesSpan.textContent = totalPages || 1;
      currentPageSpan.textContent = currentPage;
      renderConfigs(data.data);
      updatePagination();
      const allowDrag = currentCatalog !== '';
      dragHint.textContent = allowDrag
        ? '💡 当前分类已显示全部，拖拽插入排序'
        : '💡 选择分类后可拖拽排序';
      $$('#configTableBody tr').forEach(row => {
        const cb = row.querySelector('td input[type="checkbox"]');
        if (cb && selectedIds.has(parseInt(cb.value))) cb.checked = true;
      });
      updateSelectAll();
    } else showMessage(data.message, 'error');
  }).catch(() => showMessage('网络错误', 'error'));
}

function renderConfigs(configs) {
  configBody.innerHTML = '';
  if (!configs || configs.length === 0) {
    configBody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#94a3b8;padding:30px;">暂无数据</td></tr>';
    return;
  }
  const allowDrag = currentCatalog !== '';
  configs.forEach((config, idx) => {
    const row = document.createElement('tr');
    row.draggable = allowDrag;
    row.dataset.id = config.id;
    row.dataset.config = JSON.stringify(config);
    const safeName = escapeHTML(config.name || '');
    const urlDisp = normalizeUrl(config.url) ? \`<a href="\${escapeHTML(normalizeUrl(config.url))}" target="_blank">\${escapeHTML(config.url)}</a>\` : escapeHTML(config.url || '');
    const logoDisp = normalizeUrl(config.logo) ? \`<img src="\${escapeHTML(normalizeUrl(config.logo))}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;" onerror="this.src='https://img.lcit.cc.cd/file/1784435254363_icon_网页.png'" />\` : '—';
    const sortVal = (config.sort_order === 9999 || config.sort_order == null) ? '默认' : config.sort_order;
    const healthHtml = getHealthIcon(config.health_status, config.health_error);
    const checkedAt = config.health_checked_at || '-';
    const handle = allowDrag ? '<span style="cursor:grab;color:#94a3b8;">⠿</span>' : '—';
    const isChecked = selectedIds.has(config.id);
    row.innerHTML = \`
      <td><input type="checkbox" class="row-select" value="\${config.id}" \${isChecked ? 'checked' : ''} /></td>
      <td>\${handle}</td>
      <td>\${config.id}</td>
      <td>\${safeName}</td>
      <td>\${urlDisp}</td>
      <td>\${logoDisp}</td>
      <td>\${escapeHTML(config.desc || '—')}</td>
      <td>\${escapeHTML(config.catelog || '')}</td>
      <td>\${sortVal}</td>
      <td>\${healthHtml}</td>
      <td>\${checkedAt}</td>
      <td class="actions">
        <button class="edit-btn" data-id="\${config.id}">编辑</button>
        <button class="del-btn" data-id="\${config.id}">删除</button>
      </td>
    \`;
    configBody.appendChild(row);
    if (allowDrag) {
      row.addEventListener('dragstart', handleDragStart);
      row.addEventListener('dragover', handleDragOver);
      row.addEventListener('drop', handleDragDrop);
      row.addEventListener('dragend', handleDragEnd);
    }
  });
  bindLinkActions();
  bindRowSelect();
}

function bindRowSelect() {
  $$('.row-select').forEach(cb => {
    cb.addEventListener('change', function() {
      const id = parseInt(this.value);
      if (this.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelectAll();
    });
  });
}

function updateSelectAll() {
  const checkboxes = $$('.row-select');
  const checked = $$('.row-select:checked');
  selectAll.checked = checkboxes.length > 0 && checkboxes.length === checked.length;
}

selectAll.addEventListener('change', function() {
  const checked = this.checked;
  $$('.row-select').forEach(cb => {
    cb.checked = checked;
    const id = parseInt(cb.value);
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
  });
});

let dragSrcRow = null, dragTargetRow = null;

function handleDragStart(e) {
  dragSrcRow = this; dragTargetRow = null;
  e.dataTransfer.effectAllowed = 'move';
  this.style.opacity = '0.5';
}
function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function handleDragDrop(e) {
  e.preventDefault();
  if (dragSrcRow && dragSrcRow !== this) {
    dragTargetRow = this;
    const parent = this.parentNode;
    const rows = Array.from(parent.children);
    const si = rows.indexOf(dragSrcRow), ti = rows.indexOf(this);
    if (si < ti) parent.insertBefore(dragSrcRow, this.nextSibling);
    else parent.insertBefore(dragSrcRow, this);
  }
}
function handleDragEnd(e) {
  this.style.opacity = '1';
  if (!dragSrcRow || !dragTargetRow) { dragSrcRow = null; dragTargetRow = null; return; }

  const isFullView = (currentCatalog !== '') || (totalItems <= pageSize);
  const rows = configBody.querySelectorAll('tr');
  const configs = [];
  rows.forEach(row => {
    if (row.dataset.config) configs.push(JSON.parse(row.dataset.config));
  });

  if (isFullView) {
    const items = configs.map((config, idx) => ({ id: config.id, sort_order: idx + 1 }));
    fetch('/api/config/batch-sort', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    })
      .then(r => r.json())
      .then(data => {
        if (data.code === 200) {
          showToast('排序已保存 ✅', 'success', 1500);
        } else {
          showToast('排序保存失败: ' + data.message, 'error', 2500);
        }
      })
      .catch(() => {
        showToast('网络错误，排序未保存', 'error', 2500);
      });
  } else {
    const srcConfig = JSON.parse(dragSrcRow.dataset.config);
    const tgtConfig = JSON.parse(dragTargetRow.dataset.config);
    const items = [
      { id: srcConfig.id, sort_order: tgtConfig.sort_order },
      { id: tgtConfig.id, sort_order: srcConfig.sort_order }
    ];
    fetch('/api/config/batch-sort', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    })
      .then(r => r.json())
      .then(data => {
        if (data.code === 200) {
          showToast('排序已保存 ✅', 'success', 1500);
        } else {
          showToast('排序保存失败: ' + data.message, 'error', 2500);
        }
      })
      .catch(() => {
        showToast('网络错误，排序未保存', 'error', 2500);
      });
  }

  dragSrcRow = null;
  dragTargetRow = null;
}

function bindLinkActions() {
  $$('.edit-btn').forEach(btn => btn.addEventListener('click', function() { openEditModal(this.dataset.id); }));
  $$('.del-btn').forEach(btn => btn.addEventListener('click', function() { handleDelete(this.dataset.id); }));
}

function updatePagination() {
  prevBtn.disabled = currentPage === 1;
  let effectivePageSize = pageSize;
  if (currentCatalog !== '') effectivePageSize = Math.min(pageSize, 500);
  const totalPages = Math.ceil(totalItems / effectivePageSize);
  nextBtn.disabled = currentPage >= totalPages || totalPages === 0;
}

function handleDelete(id) {
  showConfirm('删除确认', '确定要删除该链接吗？', async function() {
    showLoader('删除中...');
    try {
      const res = await fetch('/api/config/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.code === 200) {
        showLoaderDone('删除成功');
        setTimeout(() => { hideLoader(); fetchConfigs(); loadDashboard(); }, 1200);
      } else {
        showLoaderDone(data.message);
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('网络错误');
      setTimeout(hideLoader, 1500);
    }
  });
}

batchDeleteBtn.addEventListener('click', function() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) { showMessage('请先选择要删除的链接', 'error'); return; }
  showConfirm(\`批量删除确认\`, \`确定要删除选中的 \${ids.length} 个链接吗？\`, async function() {
    showLoader(\`正在删除 \${ids.length} 个链接...\`);
    try {
      const res = await fetch('/api/sites/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      const data = await res.json();
      if (data.code === 200) {
        selectedIds.clear();
        showLoaderDone(\`已删除 \${ids.length} 个链接\`);
        setTimeout(() => { hideLoader(); fetchConfigs(); loadDashboard(); }, 1200);
      } else {
        showLoaderDone(data.message);
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('网络错误');
      setTimeout(hideLoader, 1500);
    }
  });
});

batchCategoryBtn.addEventListener('click', function() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) { showMessage('请先选择要修改的链接', 'error'); return; }
  batchCategoryModal.classList.add('active');
  batchCategoryInput.value = '';
  batchCategoryInput.focus();
});
batchCategoryClose.addEventListener('click', () => batchCategoryModal.classList.remove('active'));
batchCategoryCancel.addEventListener('click', () => batchCategoryModal.classList.remove('active'));
batchCategoryModal.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
document.getElementById('batchCategoryForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const category = batchCategoryInput.value.trim();
  if (!category) { showMessage('请输入目标分类', 'error'); return; }
  const ids = Array.from(selectedIds);
  batchCategoryModal.classList.remove('active');
  showConfirm(\`批量修改分类\`, \`将选中的 \${ids.length} 个链接分类修改为 "\${category}"，确认？\`, async function() {
    showLoader(\`正在修改分类...\`);
    try {
      const res = await fetch('/api/sites/batch/category', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, category })
      });
      const data = await res.json();
      if (data.code === 200) {
        selectedIds.clear();
        showLoaderDone(\`已修改 \${ids.length} 个链接分类\`);
        setTimeout(() => { hideLoader(); fetchConfigs(); loadDashboard(); }, 1200);
      } else {
        showLoaderDone(data.message);
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('网络错误');
      setTimeout(hideLoader, 1500);
    }
  });
});

// 分页健康检查
checkPageHealthBtn.addEventListener('click', function() {
  const rows = configBody.querySelectorAll('tr');
  const ids = [];
  rows.forEach(row => {
    const cb = row.querySelector('td input[type="checkbox"]');
    if (cb) {
      const val = parseInt(cb.value);
      if (!isNaN(val)) ids.push(val);
    }
  });
  if (ids.length === 0) { showMessage('当前页没有可检查的链接', 'error'); return; }
  if (ids.length > 50) { showMessage('当前页超过50个链接，请分批检查', 'error'); return; }
  showLoader(\`正在检查 \${ids.length} 个链接...\`);
  fetch('/api/health/check-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  }).then(r => r.json()).then(data => {
    if (data.code === 200) {
      const ok = data.data.filter(r => r.ok).length;
      const fail = data.data.filter(r => !r.ok).length;
      showLoaderDone(\`检查完成：✅ \${ok} 正常，❌ \${fail} 异常\`);
      setTimeout(() => { hideLoader(); fetchConfigs(); loadDashboard(); }, 1500);
    } else {
      showLoaderDone(data.message);
      setTimeout(hideLoader, 1500);
    }
  }).catch(() => {
    showLoaderDone('网络错误');
    setTimeout(hideLoader, 1500);
  });
});

// ============================================================
// 待审核
// ============================================================
function fetchPending(page = pendingPage) {
  pendingBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">加载中...</td></tr>';
  fetch(\`/api/pending?page=\${page}&pageSize=\${pendingPageSize}\`).then(r => r.json()).then(data => {
    if (data.code === 200) {
      pendingTotal = data.total; pendingPage = data.page;
      pendingTotalPages.textContent = Math.ceil(pendingTotal / pendingPageSize);
      pendingCurrent.textContent = pendingPage;
      renderPending(data.data);
      pendingPrev.disabled = pendingPage === 1;
      pendingNext.disabled = pendingPage >= Math.ceil(pendingTotal / pendingPageSize);
      addPendingBatchButtons();
    } else showMessage(data.message, 'error');
  }).catch(() => showMessage('网络错误', 'error'));
}

function addPendingBatchButtons() {
  const toolbar = document.querySelector('#page-pending .toolbar');
  if (!toolbar || toolbar.querySelector('.batch-actions')) return;
  const batchDiv = document.createElement('div');
  batchDiv.className = 'batch-actions';
  batchDiv.innerHTML = \`
    <button id="batchApproveBtn" class="btn-primary" style="background:#22c55e;">✅ 批量通过</button>
    <button id="batchRejectBtn" class="btn-primary" style="background:#f59e0b;">❌ 批量拒绝</button>
  \`;
  toolbar.appendChild(batchDiv);
  $('batchApproveBtn').addEventListener('click', function() { batchApprove(this); });
  $('batchRejectBtn').addEventListener('click', function() { batchReject(this); });
}

function getPendingIds() {
  const rows = pendingBody.querySelectorAll('tr');
  const ids = [];
  rows.forEach(row => {
    const btn = row.querySelector('.approve-btn');
    if (btn) ids.push(parseInt(btn.dataset.id));
  });
  return ids;
}

function batchApprove(btn) {
  const ids = getPendingIds();
  if (ids.length === 0) { showMessage('当前页无待审核项', 'error'); return; }
  showConfirm(\`批量通过\`, \`确定要通过 \${ids.length} 条待审核链接吗？\`, async function() {
    btn.disabled = true; btn.textContent = '处理中...';
    showLoader(\`正在通过 \${ids.length} 条...\`);
    for (const id of ids) { await fetch('/api/pending/' + id, { method: 'PUT' }); }
    showLoaderDone(\`已通过 \${ids.length} 条\`);
    setTimeout(() => {
      hideLoader(); btn.disabled = false; btn.textContent = '✅ 批量通过';
      fetchPending(); fetchConfigs(); loadDashboard();
    }, 1200);
  });
}

function batchReject(btn) {
  const ids = getPendingIds();
  if (ids.length === 0) { showMessage('当前页无待审核项', 'error'); return; }
  showConfirm(\`批量拒绝\`, \`确定要拒绝 \${ids.length} 条待审核链接吗？\`, async function() {
    btn.disabled = true; btn.textContent = '处理中...';
    showLoader(\`正在拒绝 \${ids.length} 条...\`);
    for (const id of ids) { await fetch('/api/pending/' + id, { method: 'DELETE' }); }
    showLoaderDone(\`已拒绝 \${ids.length} 条\`);
    setTimeout(() => {
      hideLoader(); btn.disabled = false; btn.textContent = '❌ 批量拒绝';
      fetchPending();
    }, 1200);
  });
}

function renderPending(list) {
  pendingBody.innerHTML = '';
  if (!list || list.length === 0) {
    pendingBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:30px;">暂无待审核数据</td></tr>';
    return;
  }
  list.forEach(c => {
    const row = document.createElement('tr');
    const logoDisp = normalizeUrl(c.logo) ? \`<img src="\${escapeHTML(normalizeUrl(c.logo))}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;" onerror="this.src='https://img.lcit.cc.cd/file/1784435254363_icon_网页.png'" />\` : '—';
    row.innerHTML = \`
      <td>\${c.id}</td>
      <td>\${escapeHTML(c.name)}</td>
      <td><a href="\${escapeHTML(normalizeUrl(c.url)||'#')}" target="_blank">\${escapeHTML(c.url)}</a></td>
      <td>\${logoDisp}</td>
      <td>\${escapeHTML(c.desc || '—')}</td>
      <td>\${escapeHTML(c.catelog)}</td>
      <td class="actions">
        <button class="approve-btn" data-id="\${c.id}">✅ 批准</button>
        <button class="reject-btn" data-id="\${c.id}">❌ 拒绝</button>
      </td>
    \`;
    pendingBody.appendChild(row);
  });
  $$('.approve-btn').forEach(btn => btn.addEventListener('click', function() { handleApprove(this.dataset.id); }));
  $$('.reject-btn').forEach(btn => btn.addEventListener('click', function() { handleReject(this.dataset.id); }));
}

function handleApprove(id) {
  showConfirm('批准确认', '确定批准该链接吗？', async function() {
    showLoader('批准中...');
    try {
      const res = await fetch('/api/pending/' + id, { method: 'PUT' });
      const data = await res.json();
      if (data.code === 200) {
        showLoaderDone('批准成功');
        setTimeout(() => { hideLoader(); fetchPending(); fetchConfigs(); loadDashboard(); }, 1200);
      } else {
        showLoaderDone(data.message);
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('网络错误');
      setTimeout(hideLoader, 1500);
    }
  });
}
function handleReject(id) {
  showConfirm('拒绝确认', '确定拒绝该链接吗？', async function() {
    showLoader('拒绝中...');
    try {
      const res = await fetch('/api/pending/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.code === 200) {
        showLoaderDone('拒绝成功');
        setTimeout(() => { hideLoader(); fetchPending(); }, 1200);
      } else {
        showLoaderDone(data.message);
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('网络错误');
      setTimeout(hideLoader, 1500);
    }
  });
}

// ============================================================
// 分类管理
// ============================================================
function fetchCategories() {
  categoryBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:30px;color:#94a3b8;">加载中...</td></tr>';
  fetch('/api/categories').then(r => r.json()).then(data => {
    if (data.code === 200) renderCategoryTable(data.data || []);
    else showMessage(data.message, 'error');
  }).catch(() => showMessage('网络错误', 'error'));
}

function renderCategoryTable(cats) {
  categoryBody.innerHTML = '';
  if (!cats || cats.length === 0) {
    categoryBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:30px;color:#94a3b8;">暂无分类</td></tr>';
    return;
  }
  cats.forEach(c => {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td>\${escapeHTML(c.catelog)}</td>
      <td>\${c.site_count}</td>
      <td><input type="number" class="category-sort-input" value="\${c.explicit ? c.sort_order : ''}" placeholder="\${c.sort_order}" data-category="\${escapeHTML(c.catelog)}" /></td>
      <td class="category-actions">
        <button class="category-save-btn" data-category="\${escapeHTML(c.catelog)}">💾 保存</button>
        <button class="category-rename-btn" data-category="\${escapeHTML(c.catelog)}">✏️ 修改</button>
        <button class="category-delete-btn" data-category="\${escapeHTML(c.catelog)}">🗑️ 删除</button>
      </td>
    \`;
    categoryBody.appendChild(row);
  });
  $$('.category-save-btn').forEach(btn => btn.addEventListener('click', saveCategoryValue));
  $$('.category-rename-btn').forEach(btn => btn.addEventListener('click', openRenameModal));
  $$('.category-delete-btn').forEach(btn => btn.addEventListener('click', deleteCategory));
}

function openRenameModal(e) {
  const btn = e.target;
  const cat = btn.dataset.category;
  renameCategory = cat;
  renameInput.value = cat;
  renameModal.classList.add('active');
  renameInput.focus();
  renameInput.select();
}
renameModalClose.addEventListener('click', () => renameModal.classList.remove('active'));
renameCancel.addEventListener('click', () => renameModal.classList.remove('active'));
renameModal.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });

document.getElementById('renameForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const newName = renameInput.value.trim();
  if (!newName) { showMessage('分类名不能为空', 'error'); return; }
  if (newName === renameCategory) { showMessage('新名称与旧名称相同', 'error'); return; }
  const exists = allCategories.some(c => c.catelog === newName);
  if (exists) { showMessage('该分类已存在', 'error'); return; }
  showLoader('重命名分类...');
  try {
    const res = await fetch('/api/categories/' + encodeURIComponent(renameCategory), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rename: newName })
    });
    const data = await res.json();
    if (data.code === 200) {
      showLoaderDone('重命名成功');
      setTimeout(() => {
        hideLoader(); renameModal.classList.remove('active');
        fetchCategories(); loadDashboard(); fetchConfigs();
      }, 1200);
    } else {
      showLoaderDone(data.message);
      setTimeout(hideLoader, 1500);
    }
  } catch(e) {
    showLoaderDone('网络错误');
    setTimeout(hideLoader, 1500);
  }
});

async function saveCategoryValue(e) {
  const btn = e.target;
  const cat = btn.dataset.category;
  const input = btn.closest('tr').querySelector('.category-sort-input');
  const val = input.value.trim();
  if (!val) { showMessage('请输入排序值', 'error'); return; }
  const num = Number(val);
  if (!Number.isFinite(num)) { showMessage('请输入有效数字', 'error'); return; }
  showLoader('更新排序值...');
  try {
    const res = await fetch('/api/categories/' + encodeURIComponent(cat), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sort_order: num })
    });
    const data = await res.json();
    if (data.code === 200) {
      showLoaderDone('更新成功');
      setTimeout(() => { hideLoader(); fetchCategories(); loadDashboard(); }, 1200);
    } else {
      showLoaderDone(data.message);
      setTimeout(hideLoader, 1500);
    }
  } catch(e) {
    showLoaderDone('网络错误');
    setTimeout(hideLoader, 1500);
  }
}

async function deleteCategory(e) {
  const btn = e.target;
  const cat = btn.dataset.category;
  const catInfo = allCategories.find(c => c.catelog === cat);
  const count = catInfo ? catInfo.site_count : 0;
  if (count === 0) {
    showConfirm(\`删除分类\`, \`分类 "\${cat}" 下没有链接，确认删除此分类？\`, async function() {
      showLoader('删除分类...');
      try {
        await fetch('/api/categories/' + encodeURIComponent(cat), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reset: true })
        });
        showLoaderDone('分类已删除');
        setTimeout(() => { hideLoader(); fetchCategories(); loadDashboard(); }, 1200);
      } catch(e) {
        showLoaderDone('删除失败');
        setTimeout(hideLoader, 1500);
      }
    });
    return;
  }
  showConfirm(\`删除分类及链接\`, \`分类 "\${cat}" 下共有 \${count} 个链接，删除分类将同时删除这些链接，确认继续？\`, async function() {
    showLoader(\`正在删除分类及 \${count} 个链接...\`);
    try {
      const res = await fetch('/api/config?catalog=' + encodeURIComponent(cat) + '&page=1&pageSize=9999');
      const data = await res.json();
      if (data.code === 200) {
        const ids = data.data.map(item => item.id);
        if (ids.length > 0) {
          await fetch('/api/sites/batch', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
          });
        }
        await fetch('/api/categories/' + encodeURIComponent(cat), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reset: true })
        });
        showLoaderDone(\`已删除分类 "\${cat}" 及 \${ids.length} 个链接\`);
        setTimeout(() => {
          hideLoader(); fetchCategories(); loadDashboard(); fetchConfigs();
        }, 1500);
      } else {
        showLoaderDone('获取链接列表失败');
        setTimeout(hideLoader, 1500);
      }
    } catch(e) {
      showLoaderDone('操作失败: ' + e.message);
      setTimeout(hideLoader, 1500);
    }
  });
}

// ============================================================
// 站点设置
// ============================================================
function loadSettings() {
  fetch('/api/site/config').then(r => r.json()).then(data => {
    if (data.code === 200) {
      siteNameInput.value = data.data.site_name || '';
      siteIconInput.value = data.data.site_icon || '';
      siteCopyrightInput.value = data.data.site_copyright || '';
      siteBlogInput.value = data.data.site_blog || '';
      siteBackgroundInput.value = data.data.site_background || '';
    }
  }).catch(() => showMessage('加载设置失败', 'error', settingsMessage));
}

settingsForm.addEventListener('submit', function(e) {
  e.preventDefault();
  const payload = {
    site_name: siteNameInput.value.trim(),
    site_icon: siteIconInput.value.trim(),
    site_copyright: siteCopyrightInput.value.trim(),
    site_blog: siteBlogInput.value.trim(),
    site_background: siteBackgroundInput.value.trim()
  };
  showLoader('保存设置...');
  fetch('/api/site/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(data => {
    if (data.code === 200) {
      showLoaderDone('设置已保存，页面即将刷新...');
      setTimeout(() => { hideLoader(); location.reload(); }, 1500);
    } else {
      showLoaderDone(data.message || '保存失败');
      setTimeout(hideLoader, 1500);
    }
  }).catch(() => {
    showLoaderDone('网络错误');
    setTimeout(hideLoader, 1500);
  });
});

// ============================================================
// 模态框（添加/编辑）
// ============================================================
function openModal(title, data) {
  modalTitle.textContent = title;
  if (data) {
    editId.value = data.id;
    linkName.value = data.name || '';
    linkUrl.value = data.url || '';
    linkLogo.value = data.logo || '';
    linkDesc.value = data.desc || '';
    linkCatelog.value = data.catelog || '';
    linkSortOrder.value = (data.sort_order === 9999 || data.sort_order == null) ? '' : data.sort_order;
  } else {
    editId.value = '';
    linkName.value = '';
    linkUrl.value = '';
    linkLogo.value = '';
    linkDesc.value = '';
    linkCatelog.value = '';
    linkSortOrder.value = '';
  }
  submitLinkBtn.disabled = false;
  submitLinkBtn.textContent = '保存';
  linkModal.classList.add('active');
}
function closeModal() {
  linkModal.classList.remove('active');
  submitLinkBtn.disabled = false;
  submitLinkBtn.textContent = '保存';
}
modalClose.addEventListener('click', closeModal);
cancelModal.addEventListener('click', closeModal);
linkModal.addEventListener('click', function(e) { if (e.target === this) closeModal(); });

linkForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  if (submitLinkBtn.disabled) return;
  submitLinkBtn.disabled = true;
  submitLinkBtn.textContent = '添加中...';

  const payload = {
    name: linkName.value.trim(),
    url: linkUrl.value.trim(),
    logo: linkLogo.value.trim(),
    desc: linkDesc.value.trim(),
    catelog: linkCatelog.value.trim(),
  };
  const sortVal = linkSortOrder.value.trim();
  if (sortVal !== '') payload.sort_order = Number(sortVal);
  const id = editId.value;
  const url = id ? '/api/config/' + id : '/api/config';
  const method = id ? 'PUT' : 'POST';
  showLoader(id ? '更新中...' : '添加中...');
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.code === 200 || data.code === 201) {
      showLoaderDone(id ? '更新成功' : '添加成功');
      setTimeout(() => {
        hideLoader(); closeModal(); fetchConfigs(); loadDashboard();
        submitLinkBtn.disabled = false; submitLinkBtn.textContent = '保存';
      }, 1200);
    } else {
      showLoaderDone(data.message);
      setTimeout(() => { hideLoader(); submitLinkBtn.disabled = false; submitLinkBtn.textContent = '保存'; }, 1500);
    }
  } catch(e) {
    showLoaderDone('网络错误');
    setTimeout(() => { hideLoader(); submitLinkBtn.disabled = false; submitLinkBtn.textContent = '保存'; }, 1500);
  }
});

async function openEditModal(id) {
  try {
    const res = await fetch('/api/config/' + id);
    const data = await res.json();
    if (data.code === 200) openModal('编辑链接', data.data);
    else showMessage('未找到数据', 'error');
  } catch(e) {
    showMessage('网络错误', 'error');
  }
}
addLinkBtn.addEventListener('click', () => openModal('添加链接', null));

// ============================================================
// 魔法棒
// ============================================================
function magicFillFavicon(urlInputId, logoInputId) {
  const urlInput = $(urlInputId);
  const logoInput = $(logoInputId);
  if (!urlInput || !logoInput) { showMessage('输入框未找到', 'error'); return; }
  const url = urlInput.value.trim();
  if (!url) { showMessage('请先输入网址', 'error'); return; }
  let domain;
  try { domain = new URL(url).hostname; } catch(e) {
    let clean = url.replace(/^https?:\\/\\//i, '').replace(/^\\/\\//, '');
    domain = clean.split('/')[0].split('?')[0];
  }
  if (!domain) { showMessage('无法提取域名', 'error'); return; }
  logoInput.value = \`https://www.faviconextractor.com/favicon/\${domain}?larger=true\`;
}
document.querySelectorAll('.magic-btn').forEach(btn => {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    const urlInputId = this.dataset.urlInput;
    const logoInputId = this.dataset.logoInput;
    if (urlInputId && logoInputId) magicFillFavicon(urlInputId, logoInputId);
  });
});

// ============================================================
// 导入导出
// ============================================================
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const data = JSON.parse(ev.target.result);
      const count = Array.isArray(data) ? data.length : (data.data ? data.data.length : 0);
      showLoader(\`正在导入 \${count} 条数据...\`);
      fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(r => r.json()).then(d => {
        if (d.code === 201 || d.code === 200) {
          let msg = \`✅ 导入完成！成功 \${d.imported || count} 条\`;
          if (d.skipped > 0) msg += \`，跳过 \${d.skipped} 条（已存在）\`;
          showLoaderDone(msg);
          setTimeout(() => { hideLoader(); fetchConfigs(); loadDashboard(); }, 2000);
        } else {
          showLoaderDone(d.message || '导入失败');
          setTimeout(hideLoader, 2000);
        }
      }).catch(() => {
        showLoaderDone('网络错误');
        setTimeout(hideLoader, 2000);
      });
    } catch(e) {
      showLoaderDone('JSON 格式错误');
      setTimeout(hideLoader, 2000);
    }
  };
  reader.readAsText(file);
  this.value = '';
});

exportBtn.addEventListener('click', () => {
  const catalog = currentCatalog || '';
  const url = catalog ? '/api/config/export?catalog=' + encodeURIComponent(catalog) : '/api/config/export';
  showLoader('正在生成导出文件...');
  fetch(url).then(r => {
    if (!r.ok) throw new Error('导出失败');
    return r.blob();
  }).then(blob => {
    showLoaderDone('导出准备就绪，开始下载...');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = catalog ? \`config_\${catalog}.json\` : 'config.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    setTimeout(hideLoader, 1500);
  }).catch(() => {
    showLoaderDone('导出失败，数据量可能过大或网络错误');
    setTimeout(hideLoader, 2000);
  });
});

// ============================================================
// 筛选 & 分页事件
// ============================================================
catalogFilter.addEventListener('change', function() {
  currentCatalog = this.value;
  currentPage = 1;
  selectedIds.clear();
  fetchConfigs();
});
pageSizeSelect.addEventListener('change', function() {
  pageSize = parseInt(this.value, 10);
  currentPage = 1;
  selectedIds.clear();
  fetchConfigs();
});
searchInput.addEventListener('input', function() {
  currentKeyword = this.value.trim();
  currentPage = 1;
  selectedIds.clear();
  fetchConfigs();
});
prevBtn.addEventListener('click', () => { if (currentPage > 1) { selectedIds.clear(); fetchConfigs(currentPage - 1); } });
nextBtn.addEventListener('click', () => {
  const totalPages = Math.ceil(totalItems / (currentCatalog !== '' ? Math.min(pageSize, 500) : pageSize));
  if (currentPage < totalPages) { selectedIds.clear(); fetchConfigs(currentPage + 1); }
});
pendingPrev.addEventListener('click', () => { if (pendingPage > 1) fetchPending(pendingPage - 1); });
pendingNext.addEventListener('click', () => { if (pendingPage < Math.ceil(pendingTotal / pendingPageSize)) fetchPending(pendingPage + 1); });
refreshCatsBtn.addEventListener('click', fetchCategories);
// ============================================================
// 初始化
// ============================================================
loadDashboard();
fetchConfigs();
fetchPending();
if (categoryBody) fetchCategories();

console.log('✅ Admin.js 加载完成，所有功能已初始化。')`
    };
    return fileContents[filePath];
  },

  async renderAdminPage(config) {
    let html = await this.getFileContent('admin.html');
    html = html.replace(/__SITE_NAME__/g, config.site_name || '洛宸导航');
    html = html.replace(/__SITE_ICON__/g, config.site_icon || 'https://img.lcit.cc.cd/file/1784204385655_主页.png');
    html = html.replace(/__SITE_COPYRIGHT__/g, config.site_copyright || '洛宸导航');
    html = html.replace(/__SITE_BLOG__/g, config.site_blog || 'https://lcbg.cc.cd/');
    html = html.replace(/__SITE_BACKGROUND__/g, config.site_background || 'https://bj.lcit.cc.cd/');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },

  async renderLoginPage(message = '') {
    const hasError = Boolean(message);
    const safeMessage = hasError ? escapeHTML(message) : '';
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>管理员登录</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box}html,body{height:100%;margin:0;padding:0;font-family:'Noto Sans SC',sans-serif}
body{display:flex;justify-content:center;align-items:center;background:#f1f5f9;padding:1rem}
.login-container{background:#fff;padding:2.5rem;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,0.08);width:100%;max-width:380px}
.login-title{font-size:1.6rem;font-weight:700;text-align:center;margin:0 0 1.8rem;color:#0f172a}
.form-group{margin-bottom:1.2rem}label{display:block;margin-bottom:0.4rem;font-weight:500;color:#475569}
input[type="text"],input[type="password"]{width:100%;padding:0.75rem 1rem;border:1px solid #d1d5db;border-radius:8px;font-size:1rem}
input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.12)}
button{width:100%;padding:0.8rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:500;cursor:pointer}
button:hover{background:#4338ca}
.error-message{color:#dc2626;font-size:0.875rem;margin-top:0.5rem;text-align:center;display:none}
.back-link{display:block;text-align:center;margin-top:1.5rem;color:#4f46e5;text-decoration:none;font-size:0.9rem}
.back-link:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="login-container">
<h1 class="login-title">管理员登录</h1>
<form method="post" action="/admin" novalidate>
<div class="form-group"><label for="username">用户名</label><input type="text" id="username" name="name" required autocomplete="username"></div>
<div class="form-group"><label for="password">密码</label><input type="password" id="password" name="password" required autocomplete="current-password"></div>
${hasError ? `<div class="error-message" style="display:block;">${safeMessage}</div>` : `<div class="error-message">用户名或密码错误</div>`}
<button type="submit">登录</button>
</form>
<a href="/" class="back-link">返回首页</a>
</div>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};

// ============================================================
// 前端主页面（用户导航）
// ============================================================
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const catalog = url.searchParams.get('catalog');
  const config = await getSiteConfig(env);

  let sites = [];
  try {
    const { results } = await env.NAV_DB.prepare('SELECT * FROM sites ORDER BY sort_order ASC, create_time DESC').all();
    sites = results;
  } catch (e) {
    return new Response(`Failed to fetch data: ${e.message}`, { status: 500 });
  }
  if (!sites || sites.length === 0) return new Response('No site configuration found.', { status: 404 });

  const categoryMinSort = new Map();
  const categorySet = new Set();
  sites.forEach((site) => {
    const categoryName = (site.catelog || '').trim() || '未分类';
    categorySet.add(categoryName);
    const rawSort = Number(site.sort_order);
    const normalized = Number.isFinite(rawSort) ? rawSort : 9999;
    if (!categoryMinSort.has(categoryName) || normalized < categoryMinSort.get(categoryName)) {
      categoryMinSort.set(categoryName, normalized);
    }
  });

  const categoryOrderMap = new Map();
  try {
    const { results: orderRows } = await env.NAV_DB.prepare('SELECT catelog, sort_order FROM category_orders').all();
    orderRows.forEach(row => categoryOrderMap.set(row.catelog, normalizeSortOrder(row.sort_order)));
  } catch (error) {
    if (!/no such table/i.test(error.message || '')) {
      return new Response(`Failed to fetch category orders: ${error.message}`, { status: 500 });
    }
  }

  const catalogsWithMeta = Array.from(categorySet).map((name) => {
    const fallbackSort = categoryMinSort.has(name) ? normalizeSortOrder(categoryMinSort.get(name)) : 9999;
    const order = categoryOrderMap.has(name) ? categoryOrderMap.get(name) : fallbackSort;
    return { name, order, fallback: fallbackSort };
  });
  catalogsWithMeta.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.fallback !== b.fallback) return a.fallback - b.fallback;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' });
  });
  const catalogs = catalogsWithMeta.map(item => item.name);

  const requestedCatalog = (catalog || '').trim();
  const catalogExists = Boolean(requestedCatalog && catalogs.includes(requestedCatalog));
  const currentCatalog = catalogExists ? requestedCatalog : catalogs[0];
  const currentSites = catalogExists
    ? sites.filter((s) => ((s.catelog || '').trim() || '未分类') === currentCatalog)
    : sites;

  const datalistOptions = catalogs.map((cat) => `<option value="${escapeHTML(cat)}">`).join('');
  const submissionEnabled = isSubmissionEnabled(env);

  const backgroundUrl = escapeHTML(config.site_background || 'https://bj.lcit.cc.cd/');
  const blogUrl = escapeHTML(config.site_blog || 'https://lcbg.cc.cd/');
  const siteName = escapeHTML(config.site_name || '洛宸导航');
  const siteIcon = escapeHTML(config.site_icon || 'https://img.lcit.cc.cd/file/1784204385655_主页.png');
  const siteCopyright = escapeHTML(config.site_copyright || '洛宸导航');
  const bgUrl = backgroundUrl;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${siteName}</title>
<link rel="icon" href="${siteIcon}" type="image/png" />
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet" />
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{primary:{50:'#f3f5f9',100:'#e1e7f1',200:'#c3d0e3',300:'#9cb3d1',400:'#6c8fba',500:'#416d9d',600:'#305580',700:'#254267',800:'#1d3552',900:'#192e45',950:'#101e2d'},accent:{50:'#f2faf6',100:'#d9f0e5',200:'#b4dfcb',300:'#89caa9',400:'#61b48a',500:'#4f46e5',600:'#4338ca',700:'#3730a3',800:'#312e81',900:'#1e1b4b',950:'#0e103b'}},fontFamily:{sans:['Noto Sans SC','sans-serif']}}}}</script>
<style>
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:rgba(195,208,227,0.7);border-radius:10px}
header{box-shadow:none!important;padding-top:4rem;padding-bottom:4rem}
body::after{content:"";position:fixed;left:0;bottom:0;width:100%;height:45vh;pointer-events:none;background:linear-gradient(to top,rgba(244,248,251,0.75),transparent);z-index:-1}
.site-card{transition:all 0.3s cubic-bezier(0.25,0.8,0.25,1);box-shadow:0 1px 3px rgba(0,0,0,0.04);border-radius:12px;overflow:hidden;padding:8px 4px;text-align:center;background:rgba(255,255,255,0.88)}
.site-card:hover{transform:translateY(-2px);box-shadow:0 4px 10px rgba(0,0,0,0.06)}
#sidebar{transition:transform 0.3s ease;transform:translateX(-100%);z-index:50}#sidebar.open{transform:translateX(0)}
.mobile-overlay{opacity:0;pointer-events:none;transition:opacity 0.3s ease;z-index:40}.mobile-overlay.open{opacity:1;pointer-events:auto}
.glass-white{background:rgba(255,255,255,0.9);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.4)}
.text-shadow{text-shadow:0 2px 8px rgba(0,0,0,0.28)}
.search-input:focus{outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.12)}
#main-content{transition:margin-left 0.3s ease}#main-content.sidebar-open{margin-left:16rem}
@media(max-width:768px){#main-content.sidebar-open{margin-left:0}}
.category-block{scroll-margin-top:90px}
</style>
</head>
<body class="font-sans text-gray-800 bg-fixed bg-cover bg-center min-h-screen" style="background-image:url('${bgUrl}');">
<div class="fixed top-4 left-4 z-[60]" id="menuToggleContainer">
<button id="sidebarOpenBtn" class="p-2 rounded-lg glass-white shadow-sm hover:bg-gray-100 cursor-pointer">
<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
</button>
</div>
<div class="fixed top-4 right-4 z-50 text-white text-lg text-shadow hidden md:block"><div id="dateText" class="block font-medium tracking-wide"></div><div id="timeText" class="block text-3xl md:text-4xl font-bold mt-1" style="font-variant-numeric:tabular-nums;"></div></div>
<div id="mobileOverlay" class="mobile-overlay fixed inset-0 bg-black bg-opacity-50"></div>
<aside id="sidebar" class="fixed left-0 top-0 h-full w-64 glass-white overflow-y-auto">
<div class="p-6"><div class="flex items-center justify-between mb-8"><h2 class="text-2xl font-bold text-primary-600 tracking-tight">${siteName}</h2><button id="closeSidebar" class="p-1 rounded-full hover:bg-gray-200 cursor-pointer"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button></div>
<div class="mb-6"><div class="relative"><input id="searchInput" type="text" placeholder="搜索书签..." class="w-full pl-10 pr-4 py-2 border border-primary-100 rounded-lg glass-white focus:outline-none focus:ring-2 transition"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-400 absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0z"/></svg></div></div>
<div class="mb-6"><h3 class="text-sm font-medium text-gray-500 mb-3">分类快速跳转</h3><div class="space-y-2" id="sidebarCategoryList">${catalogs.map(cat => `<a href="#cat-${escapeHTML(cat)}" class="block px-3 py-2 rounded glass-white hover:text-primary-600 text-sm category-link">${escapeHTML(cat)}</a>`).join('')}</div></div>
<div class="mt-8 pt-6 border-t border-gray-200">
${submissionEnabled ? `<button id="addSiteBtnSidebar" class="w-full flex items-center justify-center px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition shadow-sm"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>添加新书签</button>` : `<div class="w-full px-4 py-3 text-xs text-primary-600 glass border border-secondary-100 rounded-lg">访客书签提交功能已关闭</div>`}
<a href="${blogUrl}" target="_blank" class="mt-4 flex items-center px-4 py-2 text-gray-600 hover:text-primary-500 transition"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>访问博客</a>
<a href="/admin" target="_blank" class="mt-4 flex items-center px-4 py-2 text-gray-600 hover:text-primary-500 transition"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>后台管理</a>
</div></div></aside>
<main id="main-content" class="main-content min-h-screen transition-all duration-300">
<header class="relative overflow-hidden"><div class="relative max-w-3xl mx-auto text-center px-4"><h1 class="text-4xl md:text-5xl font-bold text-white text-shadow mb-3">上网，从这里开始！</h1><div class="text-white/85 text-sm mb-8 text-shadow"><a href="https://hitokoto.cn/" target="_blank" id="hitokoto_text">加载每日一言中...</a></div><div class="glass-white rounded-2xl p-4 border border-white/20"><div class="flex items-center gap-2"><input id="homeSearchInput" type="text" placeholder="搜索内容..." class="search-input flex-1 px-4 py-3 rounded-xl border border-primary-200 bg-white/90 text-gray-800 text-sm"><button id="baiduSearchBtn" class="px-4 py-3 bg-blue-500 text-white rounded-xl hover:bg-blue-600 text-sm">百度一下</button><button id="googleSearchBtn" class="px-4 py-3 bg-red-500 text-white rounded-xl hover:bg-red-600 text-sm">Google</button></div></div></div></header>
<section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
<div id="searchEmpty" style="display:none;text-align:center;padding:40px 0;color:#94a3b8;font-size:16px;">🔍 未找到匹配的书签</div>
${catalogs.map(cat => {
  const safeCat = escapeHTML(cat);
  const filterSites = currentSites.filter(s => s.catelog === cat);
  return `<div id="cat-${safeCat}" class="category-block mb-8"><h2 class="text-lg text-white text-shadow mb-3 font-semibold">${safeCat}</h2><div class="rounded-2xl glass-white p-3 sm:p-4"><div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-2 sm:gap-3">${filterSites.map(site => {
    const rawName = site.name || '未命名';
    const normalizedUrl = sanitizeUrl(site.url);
    const hrefValue = escapeHTML(normalizedUrl || '#');
    const logoUrl = sanitizeUrl(site.logo);
    const cardInitial = escapeHTML((rawName.trim().charAt(0) || '站').toUpperCase());
    const safeName = escapeHTML(rawName);
    const hasValidUrl = Boolean(normalizedUrl);
    return `<div class="site-card" data-id="${site.id}"><a href="${hrefValue}" ${hasValidUrl ? 'target="_blank" rel="noopener noreferrer"' : ''}><div class="flex justify-center mb-1">${logoUrl ? `<img src="${escapeHTML(logoUrl)}" alt="${safeName}" class="w-8 h-8 rounded-lg object-cover" onerror="this.src='https://img.lcit.cc.cd/file/1784446532749_icon_网页.png'" />` : `<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-500 to-primary-600 flex items-center justify-center text-white text-xs">${cardInitial}</div>`}</div><h3 class="text-xs font-medium text-gray-900 truncate">${safeName}</h3></a></div>`;
  }).join('')}</div></div></div>`;
}).join('')}
</section>
<footer class="glass-white py-8 px-6 mt-12 border-t border-white/30"><div class="max-w-5xl mx-auto text-center"><p class="text-gray-600">© ${new Date().getFullYear()} ${siteCopyright}</p></div></footer>
</main>
<button id="backToTop" class="fixed bottom-8 right-8 p-3 rounded-full bg-accent-500 text-white shadow-sm opacity-0 invisible transition-all hover:bg-accent-600"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M5 11l7-7 7 7M5 19l7-7 7 7"/></svg></button>
${submissionEnabled ? `<div id="addSiteModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60 opacity-0 invisible transition-all"><div class="glass-white rounded-xl shadow-lg w-full max-w-md mx-4 transform translate-y-8 transition-all"><div class="p-6"><div class="flex items-center justify-between mb-4"><h2 class="text-xl font-semibold text-gray-900">添加新书签</h2><button id="closeModal" class="text-gray-400 hover:text-gray-500"><svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button></div><form id="addSiteForm" class="space-y-4"><div><label class="block text-sm font-medium text-gray-700">名称</label><input type="text" id="addSiteName" required class="mt-1 w-full px-3 py-2 border rounded-md glass-white"></div><div><label class="block text-sm font-medium text-gray-700">网址</label><input type="text" id="addSiteUrl" required class="mt-1 w-full px-3 py-2 border rounded-md glass-white"></div><div><label class="block text-sm font-medium text-gray-700">Logo (可选)</label><div class="flex items-center gap-2 mt-1"><input type="text" id="addSiteLogo" class="flex-1 px-3 py-2 border rounded-md glass-white"><button type="button" class="magic-btn p-2 bg-accent-500 text-white rounded-md hover:bg-accent-600 transition" data-url-input="addSiteUrl" data-logo-input="addSiteLogo" title="自动获取图标">✨</button></div></div><div><label class="block text-sm font-medium text-gray-700">描述 (可选)</label><textarea id="addSiteDesc" rows="2" class="mt-1 w-full px-3 py-2 border rounded-md glass-white"></textarea></div><div><label class="block text-sm font-medium text-gray-700">分类</label><input type="text" id="addSiteCatelog" required list="catalogList" class="mt-1 w-full px-3 py-2 border rounded-md glass-white"><datalist id="catalogList">${datalistOptions}</datalist></div><div class="flex justify-end pt-4"><button type="button" id="cancelAddSite" class="glass-white py-2 px-4 border mr-3">取消</button><button type="submit" class="bg-accent-500 text-white py-2 rounded-md" id="submitSiteBtn">提交</button></div></form></div></div></div>` : ''}
<script>
document.addEventListener('DOMContentLoaded',function(){
(function(){const bgKey='nav_bg_date';const today=new Date().toDateString();if(localStorage.getItem(bgKey)!==today){const body=document.body;const bg=body.style.backgroundImage;if(bg){const m=bg.match(/url\\(["']?([^"')]+)["']?\\)/);if(m&&m[1]){let u=m[1];u+=(u.includes('?')?'&':'?')+'t='+Date.now();body.style.backgroundImage='url("'+u+'")';localStorage.setItem(bgKey,today);}}}})();

const sidebar=document.getElementById('sidebar'),mainContent=document.getElementById('main-content'),mobileOverlay=document.getElementById('mobileOverlay'),sidebarOpenBtn=document.getElementById('sidebarOpenBtn'),closeSidebar=document.getElementById('closeSidebar'),categoryList=document.getElementById('sidebarCategoryList'),menuToggleContainer=document.getElementById('menuToggleContainer');
function openSidebar(){sidebar.classList.add('open');mainContent.classList.add('sidebar-open');mobileOverlay.classList.add('open');document.body.style.overflow='hidden';if(menuToggleContainer)menuToggleContainer.style.display='none';}
function closeSidebarMenu(){sidebar.classList.remove('open');mainContent.classList.remove('sidebar-open');mobileOverlay.classList.remove('open');document.body.style.overflow='';if(menuToggleContainer)menuToggleContainer.style.display='block';}
sidebarOpenBtn.addEventListener('click',function(e){e.stopPropagation();if(!sidebar.classList.contains('open'))openSidebar();else closeSidebarMenu();});
closeSidebar.addEventListener('click',function(e){e.stopPropagation();closeSidebarMenu();});
mobileOverlay.addEventListener('click',closeSidebarMenu);
document.body.addEventListener('click',function(e){if(sidebar.classList.contains('open')&&!sidebar.contains(e.target)&&!sidebarOpenBtn.contains(e.target))closeSidebarMenu();});

categoryList.addEventListener('click',function(e){const link=e.target.closest('a');if(!link)return;e.preventDefault();const targetId=link.getAttribute('href'),targetDom=document.querySelector(targetId);categoryList.querySelectorAll('a').forEach(a=>a.classList.remove('bg-primary-100','text-primary-600'));link.classList.add('bg-primary-100','text-primary-600');closeSidebarMenu();if(targetDom){setTimeout(function(){targetDom.scrollIntoView({behavior:'smooth',block:'start'});},300);}});

function updateDateTime(){const d=new Date(),y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'),weekArr=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'],h=String(d.getHours()).padStart(2,'0'),min=String(d.getMinutes()).padStart(2,'0');document.getElementById('dateText').textContent=y+'年'+m+'月'+day+' '+weekArr[d.getDay()];document.getElementById('timeText').textContent=h+':'+min;}
updateDateTime();setInterval(updateDateTime,60000);
fetch('https://v1.hitokoto.cn').then(r=>r.json()).then(data=>{const hit=document.getElementById('hitokoto_text');hit.href='https://hitokoto.cn/?uuid='+data.uuid;hit.innerText=data.hitokoto;}).catch(()=>{document.getElementById('hitokoto_text').innerText='每日一言加载失败';});

const homeSearch=document.getElementById('homeSearchInput'),baiduBtn=document.getElementById('baiduSearchBtn'),googleBtn=document.getElementById('googleSearchBtn');
function getKey(){return homeSearch?homeSearch.value.trim():'';}
if(baiduBtn)baiduBtn.addEventListener('click',function(){const kw=getKey();if(kw)window.open('https://www.baidu.com/s?wd='+encodeURIComponent(kw),'_blank');});
if(googleBtn)googleBtn.addEventListener('click',function(){const kw=getKey();if(kw)window.open('https://www.google.com/search?q='+encodeURIComponent(kw),'_blank');});
if(homeSearch)homeSearch.addEventListener('keydown',function(e){if(e.key==='Enter'){const kw=getKey();if(kw)window.open('https://www.baidu.com/s?wd='+encodeURIComponent(kw),'_blank');}});

const backTop=document.getElementById('backToTop');window.addEventListener('scroll',function(){if(window.scrollY>300){backTop.classList.remove('opacity-0','invisible');}else{backTop.classList.add('opacity-0','invisible');}});if(backTop)backTop.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'});});

const modal=document.getElementById('addSiteModal'),addBtn=document.getElementById('addSiteBtnSidebar'),closeModalBtn=document.getElementById('closeModal'),cancelBtn=document.getElementById('cancelAddSite'),form=document.getElementById('addSiteForm');
function openModal(){modal.classList.remove('opacity-0','invisible');modal.querySelector('.max-w-md').classList.remove('translate-y-8');document.body.style.overflow='hidden';}
function closeModalFn(){modal.classList.add('opacity-0','invisible');modal.querySelector('.max-w-md').classList.add('translate-y-8');document.body.style.overflow='';}
if(addBtn)addBtn.addEventListener('click',openModal);
closeModalBtn.addEventListener('click',closeModalFn);cancelBtn.addEventListener('click',closeModalFn);
if(modal)modal.addEventListener('click',function(e){if(e.target===modal)closeModalFn();});

const submitBtn=document.getElementById('submitSiteBtn');
if(form&&submitBtn){form.addEventListener('submit',async function(e){e.preventDefault();if(submitBtn.disabled)return;submitBtn.disabled=true;submitBtn.textContent='提交中...';const payload={name:document.getElementById('addSiteName').value.trim(),url:document.getElementById('addSiteUrl').value.trim(),logo:document.getElementById('addSiteLogo').value.trim(),desc:document.getElementById('addSiteDesc').value.trim(),catelog:document.getElementById('addSiteCatelog').value.trim()};try{const res=await fetch('/api/config/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(data.code===201){const tip=document.createElement('div');tip.className='fixed top-4 right-4 z-50 bg-accent-500 text-white p-3 rounded';tip.innerText='提交成功，等待管理员审核';document.body.appendChild(tip);setTimeout(function(){tip.remove();},2500);closeModalFn();form.reset();}else{alert(data.message);}}catch(e){alert('网络错误，请重试');}finally{submitBtn.disabled=false;submitBtn.textContent='提交';}});}

function magicFillFavicon(urlInputId,logoInputId){const urlInput=document.getElementById(urlInputId),logoInput=document.getElementById(logoInputId);if(!urlInput||!logoInput){alert('未找到输入框');return;}const url=urlInput.value.trim();if(!url){alert('请先输入网址');return;}let domain;try{domain=new URL(url).hostname;}catch(e){let clean=url.replace(/^https?:\\/\\//i,'').replace(/^\\/\\//,'');domain=clean.split('/')[0].split('?')[0];}if(!domain){alert('无法提取域名');return;}logoInput.value='https://www.faviconextractor.com/favicon/'+domain+'?larger=true';}
document.querySelectorAll('.magic-btn').forEach(btn=>{btn.addEventListener('click',function(e){e.preventDefault();const urlInputId=this.dataset.urlInput,logoInputId=this.dataset.logoInput;if(urlInputId&&logoInputId)magicFillFavicon(urlInputId,logoInputId);});});

const sideSearch=document.getElementById('searchInput');const blocks=document.querySelectorAll('.category-block');const emptyEl=document.getElementById('searchEmpty');
if(sideSearch){sideSearch.addEventListener('input',function(){const kw=sideSearch.value.toLowerCase().trim();let visible=false;blocks.forEach(function(block){const cards=block.querySelectorAll('.site-card');let hasMatch=false;cards.forEach(function(card){const name=card.querySelector('h3').innerText.toLowerCase();const cat=block.querySelector('h2').innerText.toLowerCase();if(name.indexOf(kw)>-1||cat.indexOf(kw)>-1){card.classList.remove('hidden');hasMatch=true;}else{card.classList.add('hidden');}});const container=block.querySelector('div:last-child');if(container){const visibleCards=container.querySelectorAll('.site-card:not(.hidden)');if(visibleCards.length===0){block.style.display='none';}else{block.style.display='block';visible=true;}}else{block.style.display=hasMatch?'block':'none';if(hasMatch)visible=true;}});if(visible){emptyEl.style.display='none';}else{emptyEl.style.display='block';}});}
});
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
// ============================================================
// 导出主模块
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      return api.handleRequest(request, env, ctx);
    } else if (url.pathname === '/admin' || url.pathname.startsWith('/static')) {
      return admin.handleRequest(request, env, ctx);
    } else {
      return handleRequest(request, env, ctx);
    }
  },
};
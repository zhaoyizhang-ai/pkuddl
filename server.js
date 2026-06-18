process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================================
//  原生 fetch（绕过 SSL 验证）
// ============================================================

const agent = new https.Agent({ rejectUnauthorized: false });

function rawFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: isHttps ? agent : undefined,
    };

    const req = mod.request(reqOpts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body)),
          getHeader: (name) => res.headers[name.toLowerCase()],
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.setHeader('Content-Length', Buffer.byteLength(options.body));
      req.write(options.body);
    }
    req.end();
  });
}

// ============================================================
//  Cookie Jar
// ============================================================

class SimpleCookieJar {
  constructor() { this.cookies = new Map(); }
  setCookies(headers) {
    // 从 rawHeaders 中提取 set-cookie
    const raw = headers.rawHeaders || [];
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i].toLowerCase() === 'set-cookie') {
        const c = raw[i + 1];
        const parts = c.split(';')[0].split('=');
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        this.cookies.set(name, value);
      }
    }
  }
  toString() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ============================================================
//  PKU 教学网
// ============================================================

const IAAA_IS_MOBILE = 'https://iaaa.pku.edu.cn/iaaa/isMobileAuthen.do';
const IAAA_OAUTH_LOGIN = 'https://iaaa.pku.edu.cn/iaaa/oauthlogin.do';
const SSO_LOGIN = 'https://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin';
const BB_HOME = 'https://course.pku.edu.cn/webapps/portal/execute/tabs/tabAction';
const LIST_CONTENT = 'https://course.pku.edu.cn/webapps/blackboard/content/listContent.jsp';
const UPLOAD_ASSIGNMENT = 'https://course.pku.edu.cn/webapps/assignment/uploadAssignment';

// ============================================================
//  1. IAAA OAuth 登录
// ============================================================

// 从响应中提取 cookie 字符串
function extractCookies(res) {
  const cookies = {};
  const raw = res.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'set-cookie') {
      const parts = raw[i + 1].split(';')[0].split('=');
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function iaaaLogin(username, password, otpCode = '') {
  // 检查是否需要 OTP
  const checkRes = await rawFetch(`${IAAA_IS_MOBILE}?appId=blackboard&userName=${username}&_rand=${Math.random()}`);
  const checkData = await checkRes.json();
  console.log('[auth] OTP check:', checkData.authenMode);

  // 从 isMobileAuthen 响应中拿 JSESSIONID
  const iaaaCookie = extractCookies(checkRes);
  console.log('[auth] IAAA cookie:', iaaaCookie);

  // 获取 OAuth token（必须带 cookie）
  const loginRes = await rawFetch(IAAA_OAUTH_LOGIN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': iaaaCookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: new URLSearchParams({
      appid: 'blackboard',
      userName: username,
      password: password,
      randCode: '',
      smsCode: '',
      otpCode: otpCode || '',
      redirUrl: 'http://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin'
    }).toString()
  });
  const loginRaw = await loginRes.text();
  console.log('[auth] IAAA response:', loginRaw);
  const loginData = JSON.parse(loginRaw);
  if (!loginData.success) {
    throw new Error(`登录失败: ${loginData.errors?.msg || loginRaw}`);
  }
  console.log('[auth] got token');

  // 用 token 登录教学网（跟随重定向）
  const jar = new SimpleCookieJar();
  let res = await rawFetch(`${SSO_LOGIN}?_rand=${Math.random()}&token=${loginData.token}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  jar.setCookies(res);

  // 跟随重定向
  let redirectCount = 0;
  while (res.status >= 300 && res.status < 400 && redirectCount < 10) {
    const loc = res.getHeader('location');
    if (!loc) break;
    // 处理相对路径
    const fullUrl = loc.startsWith('http') ? loc : `https://course.pku.edu.cn${loc}`;
    res = await rawFetch(fullUrl, {
      headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
    });
    jar.setCookies(res);
    redirectCount++;
  }

  console.log('[auth] login done, cookies:', jar.cookies.size);
  return jar;
}

// ============================================================
//  2. 获取课程列表
// ============================================================

async function getCourses(jar) {
  const res = await rawFetch(`${BB_HOME}?tab_tab_group_id=_1_1`, {
    headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const courses = [];
  const re = /key=([\d_]+),/;

  $('div.portlet').each((_, portlet) => {
    const title = $(portlet).find('span.moduleTitle').text();
    const isCurrent = title.includes('当前') || title.includes('Current');

    $(portlet).find('ul.courseListing li a').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(re);
      if (m) {
        courses.push({
          key: m[1],
          name: $(a).text().replace(/^.*?: /, '').replace(/\(\d+-\d+学年第\d学期.*?\)/, '').trim(),
          isCurrent
        });
      }
    });
  });

  console.log(`[courses] found ${courses.length} courses`);
  return courses;
}

// ============================================================
//  3. 获取课程内容
// ============================================================

async function getCourseContents(jar, courseId, contentId) {
  const res = await rawFetch(`${LIST_CONTENT}?content_id=${contentId}&course_id=${courseId}`, {
    headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $('#content_listContainer > li').each((_, li) => {
    const $li = $(li);
    const imgAlt = $li.find('img').first().attr('alt') || '';
    const titleDiv = $li.children().eq(1);

    let kind = 'unknown';
    if (imgAlt === '作业') kind = 'assignment';
    else if (imgAlt === '内容文件夹') kind = 'folder';
    else if (imgAlt === '测试') kind = 'quiz';
    else if (imgAlt === '文件') kind = 'file';
    else if (imgAlt === '项目') kind = 'document';

    const id = titleDiv.attr('id') || '';
    const title = titleDiv.text().trim();
    const hasLink = titleDiv.find('a').length > 0;

    items.push({ id, title, kind, hasLink, courseId });
  });

  return items;
}

async function getAllContents(jar, courseId, courseEntries) {
  const allContents = [];
  const visited = new Set();

  const contentIds = [];
  for (const [text, href] of Object.entries(courseEntries)) {
    if (href && href.includes('listContent.jsp')) {
      const m = href.match(/content_id=([^&]+)/);
      if (m) contentIds.push(m[1]);
    }
  }

  const probe = [...contentIds];
  while (probe.length > 0) {
    const batch = probe.splice(0, 8);
    const results = await Promise.all(
      batch.map(id => getCourseContents(jar, courseId, id).catch(() => []))
    );
    for (const items of results) {
      for (const item of items) {
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        allContents.push(item);
        if (item.hasLink) probe.push(item.id);
      }
    }
  }

  return allContents;
}

// ============================================================
//  4. 获取课程菜单
// ============================================================

async function getCourseMenu(jar, courseId) {
  const url = `https://course.pku.edu.cn/webapps/blackboard/execute/announcement?method=search&context=course_entry&course_id=${courseId}&handle=announcements_entry&mode=view`;
  const res = await rawFetch(url, {
    headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const entries = {};
  $('#courseMenuPalette_contents > li > a').each((_, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr('href') || '';
    entries[text] = href;
  });
  return entries;
}

// ============================================================
//  5. 获取作业 DDL
// ============================================================

async function getAssignmentDeadline(jar, courseId, contentId) {
  const url = `${UPLOAD_ASSIGNMENT}?action=newAttempt&content_id=${contentId}&course_id=${courseId}`;
  const res = await rawFetch(url, {
    headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const deadlineText = $('#assignMeta2 + div').text().replace(/\s+/g, ' ').trim();

  // 检查是否已提交
  const viewUrl = `${UPLOAD_ASSIGNMENT}?mode=view&content_id=${contentId}&course_id=${courseId}`;
  const viewRes = await rawFetch(viewUrl, {
    headers: { 'Cookie': jar.toString(), 'User-Agent': 'Mozilla/5.0' }
  });
  const viewHtml = await viewRes.text();
  const $view = cheerio.load(viewHtml);
  const attemptLabel = $view('h3#current_attempt_label').text().trim() ||
                        $view('h3#currentAttempt_label').text().trim() || null;

  return { deadlineText, submitted: !!attemptLabel, attemptLabel };
}

function parseDeadline(text) {
  if (!text) return null;
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*星期.\s*(上午|下午)(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  let hour = parseInt(m[5]);
  if (m[4] === '下午' && hour < 12) hour += 12;
  if (m[4] === '上午' && hour === 12) hour = 0;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), hour, parseInt(m[6]));
}

// ============================================================
//  6. 主流程
// ============================================================

async function getAllDDL(username, password, otpCode) {
  const jar = await iaaaLogin(username, password, otpCode);
  const courses = await getCourses(jar);

  const allDDL = [];

  for (const course of courses) {
    console.log(`[ddl] processing ${course.name}...`);
    try {
      const menu = await getCourseMenu(jar, course.key);
      const contents = await getAllContents(jar, course.key, menu);
      const assignments = contents.filter(c => c.kind === 'assignment');

      for (const a of assignments) {
        try {
          const { deadlineText, submitted, attemptLabel } = await getAssignmentDeadline(jar, a.courseId, a.id);
          const deadline = parseDeadline(deadlineText);
          allDDL.push({
            id: `${course.key}_${a.id}`,
            courseName: course.name,
            title: a.title,
            deadline: deadline ? deadline.toISOString() : null,
            deadlineText: deadlineText || '无截止时间',
            submitted,
            attemptLabel
          });
        } catch (e) {
          console.error(`  [ddl] error on ${a.title}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[ddl] error on course ${course.name}:`, e.message);
    }
  }

  allDDL.sort((a, b) => {
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return new Date(a.deadline) - new Date(b.deadline);
  });

  return allDDL;
}

// ============================================================
//  7. Notion 同步
// ============================================================

async function syncToNotion(ddlList, notionToken, databaseId) {
  const { Client } = require('@notionhq/client');
  const notion = new Client({ auth: notionToken });

  // 获取数据源 ID
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const dsId = db.data_sources?.[0]?.id;
  if (!dsId) throw new Error('无法获取数据源 ID');

  const existing = await notion.dataSources.query({ data_source_id: dsId, page_size: 100 });
  const existingIds = new Set();
  for (const page of existing.results) {
    const idProp = page.properties?.['作业ID'];
    if (idProp?.rich_text?.[0]?.text?.content) {
      existingIds.add(idProp.rich_text[0].text.content);
    }
  }

  let created = 0, skipped = 0;
  for (const ddl of ddlList) {
    if (existingIds.has(ddl.id)) { skipped++; continue; }

    const now = new Date();
    const deadline = ddl.deadline ? new Date(ddl.deadline) : null;
    let status = '未完成';
    if (ddl.submitted) status = '已完成';
    else if (deadline && deadline < now) status = '已过期';

    try {
      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          'Name': { title: [{ text: { content: ddl.title } }] },
          '课程': { select: { name: ddl.courseName } },
          '截止时间': ddl.deadline ? { date: { start: ddl.deadline } } : { date: null },
          '状态': { select: { name: status } },
          '作业ID': { rich_text: [{ text: { content: ddl.id } }] }
        }
      });
      created++;
    } catch (e) {
      console.error(`[notion] failed: ${ddl.title}:`, e.message);
    }
  }

  return { created, skipped, total: ddlList.length };
}

// 一键创建 Notion 数据库
async function createNotionDatabase(notionToken, parentPageId) {
  const { Client } = require('@notionhq/client');
  const notion = new Client({ auth: notionToken });

  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: 'PKU DDL Tracker' } }],
  });

  // 通过数据源 API 添加属性
  const dsId = db.data_sources?.[0]?.id;
  if (dsId) {
    await notion.dataSources.update({
      data_source_id: dsId,
      properties: {
        '课程': { select: { options: [] } },
        '截止时间': { date: {} },
        '状态': { select: { options: [
          { name: '未完成', color: 'red' },
          { name: '已完成', color: 'green' },
          { name: '已过期', color: 'gray' }
        ]}},
        '作业ID': { rich_text: {} }
      }
    });
  }

  return { databaseId: db.id, url: db.url };
}

// ============================================================
//  API 路由
// ============================================================

let currentDDL = [];
let ignoredCourses = new Set();  // 被忽略的课程名

// 登录并获取 DDL
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, otpCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入学号和密码' });

    console.log(`\n[api] login: ${username}`);
    currentDDL = await getAllDDL(username, password, otpCode);
    res.json({ success: true, count: currentDDL.length, data: currentDDL, ignoredCourses: [...ignoredCourses] });
  } catch (e) {
    console.error('[api] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 获取 DDL 列表
app.get('/api/ddl', (req, res) => {
  res.json({ data: currentDDL, ignoredCourses: [...ignoredCourses] });
});

// 手动添加 DDL
app.post('/api/ddl', (req, res) => {
  const { title, courseName, deadline } = req.body;
  if (!title) return res.status(400).json({ error: '请输入作业名称' });

  const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    courseName: courseName || '手动添加',
    title,
    deadline: deadline ? new Date(deadline).toISOString() : null,
    deadlineText: deadline || '无截止时间',
    submitted: false,
    attemptLabel: null,
    manual: true
  };
  currentDDL.push(item);
  currentDDL.sort((a, b) => {
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return new Date(a.deadline) - new Date(b.deadline);
  });
  res.json({ success: true, data: currentDDL });
});

// 删除 DDL
app.delete('/api/ddl/:id', (req, res) => {
  const before = currentDDL.length;
  currentDDL = currentDDL.filter(d => d.id !== req.params.id);
  if (currentDDL.length === before) return res.status(404).json({ error: '未找到该条目' });
  res.json({ success: true, data: currentDDL });
});

// 标记已完成/未完成
app.put('/api/ddl/:id/submit', (req, res) => {
  const item = currentDDL.find(d => d.id === req.params.id);
  if (!item) return res.status(404).json({ error: '未找到该条目' });
  item.submitted = !item.submitted;
  res.json({ success: true, data: currentDDL });
});

// 忽略/取消忽略课程
app.post('/api/ignore-course', (req, res) => {
  const { courseName, ignore } = req.body;
  if (!courseName) return res.status(400).json({ error: '课程名不能为空' });
  if (ignore) ignoredCourses.add(courseName);
  else ignoredCourses.delete(courseName);
  res.json({ success: true, ignoredCourses: [...ignoredCourses] });
});

// 清空所有数据
app.post('/api/clear', (req, res) => {
  currentDDL = [];
  ignoredCourses.clear();
  res.json({ success: true });
});

// 一键创建 Notion 数据库
app.post('/api/create-notion-db', async (req, res) => {
  try {
    const { notionToken, parentPageId } = req.body;
    if (!notionToken) return res.status(400).json({ error: '请填写 Notion Token' });
    if (!parentPageId) return res.status(400).json({ error: '请填写父页面 ID' });

    const result = await createNotionDatabase(notionToken, parentPageId);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[api] create db error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Notion 同步
app.post('/api/sync-notion', async (req, res) => {
  try {
    const { notionToken, databaseId } = req.body;
    if (!notionToken || !databaseId) return res.status(400).json({ error: '请填写 Notion Token 和数据库 ID' });

    // 过滤掉被忽略的课程
    const toSync = currentDDL.filter(d => !ignoredCourses.has(d.courseName));
    if (toSync.length === 0) return res.status(400).json({ error: '没有可同步的数据（可能全被忽略了）' });

    const result = await syncToNotion(toSync, notionToken, databaseId);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[api] notion error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 http://localhost:${PORT}\n`));

#!/usr/bin/env node
/**
 * playwright:doctor — диагностика окружения фазы 1 (живой Playwright MCP-браузер).
 * Запуск:  npm run playwright:doctor
 *
 * Ничего не чинит и не ставит — только говорит, ЧТО не так и что сделать. Зависимостей нет:
 * только встроенные модули Node, поэтому работает даже до `npm install`. Креды НЕ читает и не
 * меняет их логику — лишь проверяет, что файл заполнен (частая причина «залипания» на логине).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');

const ROOT = process.cwd();
const MCP_PORT = 8931;

let hardFail = false;
const line = (icon, msg, hint) => {
  console.log(`${icon}  ${msg}`);
  if (hint) console.log(`     → ${hint}`);
};
const ok = (m, h) => line('✅', m, h);
const warn = (m, h) => line('⚠️', m, h);
const bad = (m, h) => { hardFail = true; line('❌', m, h); };

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const readMaybe = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; }
};

function checkPort(port) {
  // Успешный connect → порт занят (вероятно, MCP-сервер уже поднят).
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.on('connect', () => done('inuse'));
    sock.on('error', () => resolve('free'));
    sock.setTimeout(1000, () => done('free'));
  });
}

function ping(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    let req;
    try {
      req = lib.get(url, { timeout: 4000 }, (res) => { res.resume(); resolve(res.statusCode); });
    } catch { return resolve(null); }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function baseUrlFromConfig() {
  // playwright.config.ts:  baseURL: process.env.BASE_URL || 'http://…'
  for (const p of ['playwright.config.ts', 'scenarios/playwright.config.ts']) {
    const c = readMaybe(p);
    if (!c) continue;
    const m =
      c.match(/baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"`]([^'"`]+)['"`]/) ||
      c.match(/baseURL:\s*['"`]([^'"`]+)['"`]/);
    if (m) return process.env.BASE_URL || m[1];
  }
  return process.env.BASE_URL || null;
}

(async () => {
  console.log('\n=== playwright:doctor — окружение фазы 1 ===\n');

  // 1. Кит развёрнут?
  const stateRaw = readMaybe('.agent-kit.json');
  if (stateRaw) {
    try {
      const j = JSON.parse(stateRaw);
      ok(`Кит развёрнут (.agent-kit.json, hashScheme=${j.hashScheme ?? '—'})`);
    } catch { warn('.agent-kit.json есть, но не парсится'); }
  } else {
    warn('.agent-kit.json не найден — тут не запускали init',
      'npx github:wYeha/playwright-tester-agent init --base-url <url>');
  }

  // 2. Node
  const major = parseInt(process.versions.node, 10);
  if (major >= 18) ok(`Node ${process.version}`);
  else bad(`Node ${process.version} — нужен 18+`, 'обнови Node.js');

  // 3. Зависимости
  const deps = [
    ['@playwright/test', 'node_modules/@playwright/test'],
    ['playwright', 'node_modules/playwright'],
    ['@playwright/mcp', 'node_modules/@playwright/mcp'],
  ];
  const missing = deps.filter(([, p]) => !exists(p)).map(([n]) => n);
  if (!missing.length) ok('Зависимости на месте (@playwright/test, playwright, @playwright/mcp)');
  else bad(`Не установлены: ${missing.join(', ')}`, 'npm install && npm run playwright:install');

  // 4. MCP-конфиг
  if (exists('.mcp.json') || exists('.cursor/mcp.json')) ok('MCP-конфиг найден');
  else warn('MCP-конфиг не найден (.mcp.json / .cursor/mcp.json)',
    'без него агент не получит инструменты браузера — см. README');

  // 5. Порт MCP
  const port = await checkPort(MCP_PORT);
  if (port === 'inuse') ok(`Порт ${MCP_PORT} занят — MCP-сервер, похоже, поднят`);
  else warn(`Порт ${MCP_PORT} свободен — MCP-сервер НЕ запущен`,
    'подними в ОТДЕЛЬНОМ терминале: npm run playwright:mcp — затем перезапусти сессию Claude Code / Cursor');

  // 6. Креды (только диагностика заполненности; логику кредов не трогаем)
  const authRaw = readMaybe('scenarios/auth.json');
  if (authRaw) {
    try {
      const a = JSON.parse(authRaw);
      if (!a.user || !a.pass || a.user === 'CHANGE_ME' || a.pass === 'CHANGE_ME') {
        bad('scenarios/auth.json есть, но user/pass не заполнены (CHANGE_ME)',
          'впиши реальные user/pass — иначе агент залипнет на форме логина');
      } else ok('scenarios/auth.json заполнен');
    } catch { bad('scenarios/auth.json не парсится как JSON'); }
  } else if (process.env.TEST_USER && process.env.TEST_PASS) {
    ok('Креды из env (TEST_USER / TEST_PASS)');
  } else {
    warn('scenarios/auth.json нет и env TEST_USER/TEST_PASS не заданы',
      'cp scenarios/auth.example.json scenarios/auth.json и впиши user/pass');
  }

  // 7. Приложение по baseUrl
  const baseUrl = baseUrlFromConfig();
  if (!baseUrl || /\{\{|<baseUrl|app\.local/.test(baseUrl)) {
    warn(`baseURL не настроен внятно (${baseUrl || '—'})`,
      'проверь playwright.config.ts или переменную окружения BASE_URL');
  } else {
    const code = await ping(baseUrl);
    if (code && code >= 200 && code < 500) ok(`Приложение отвечает: ${baseUrl} (HTTP ${code})`);
    else bad(`Приложение недоступно по ${baseUrl}${code ? ` (HTTP ${code})` : ''}`,
      'подними стенд или поправь baseURL');
  }

  console.log(
    `\n${hardFail
      ? '❌ Есть блокеры — фаза 1 не пойдёт, пока не исправишь их.'
      : '✅ Критичных блокеров нет.'}\n`
  );
  process.exit(hardFail ? 1 : 0);
})();

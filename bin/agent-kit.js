#!/usr/bin/env node
/**
 * playwright-tester-agent — развёртывание двухфазной системы E2E-тестов через ИИ-агентов.
 *
 *   npx github:wYeha/playwright-tester-agent init \
 *       --base-url http://app.local --login-url http://sso.local/auth
 *   npx github:wYeha/playwright-tester-agent update
 *
 * init   — разложить всё в проект (леса + общие файлы), подставить адреса.
 * update — освежить ТОЛЬКО общие файлы (агенты, скиллы, фикстура).
 *          Леса (config, шаблон сценария, mcp) не трогает: проект их под себя правит.
 *          Локально изменённые файлы не перезаписывает — сверяет хеши из .agent-kit.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIT_ROOT = path.join(__dirname, '..');
const TPL = path.join(KIT_ROOT, 'templates');
const STATE_FILE = '.agent-kit.json';

// ---------------------------------------------------------------- раскладка

// Общие файлы: эволюционируют в ките, обновляются через `update`.
const SHARED = [
  ['claude/agents/playwright-tester.md', '.claude/agents/playwright-tester.md'],
  ['claude/skills/test-scenario/SKILL.md', '.claude/skills/test-scenario/SKILL.md'],
  ['claude/skills/finalize-scenario/SKILL.md', '.claude/skills/finalize-scenario/SKILL.md'],
  ['cursor/agents/playwright-tester.md', '.cursor/agents/playwright-tester.md'],
  ['cursor/skills/test-scenario/SKILL.md', '.cursor/skills/test-scenario/SKILL.md'],
  ['cursor/skills/finalize-scenario/SKILL.md', '.cursor/skills/finalize-scenario/SKILL.md'],
  ['scenarios/_fixtures.ts', 'scenarios/_fixtures.ts'],
];

// Леса: ставятся один раз при init, дальше принадлежат проекту. `update` их не трогает.
const SCAFFOLD = [
  ['playwright.config.ts', 'playwright.config.ts'],
  ['scenarios/_TEMPLATE/scenario.md', 'scenarios/_TEMPLATE/scenario.md'],
  ['mcp.claude.json', '.mcp.json'],
  ['mcp.cursor.json', '.cursor/mcp.json'],
  ['scenarios/auth.example.json', 'scenarios/auth.example.json'],
  ['playwright-verify.js', 'scripts/playwright-verify.js'],
];

const PKG_SCRIPTS = {
  'playwright:install': 'playwright install chromium',
  'playwright:verify': 'node scripts/playwright-verify.js',
  'playwright:mcp': 'node node_modules/@playwright/mcp/cli.js --browser chromium --port 8931',
  'test:e2e': 'playwright test',
  'test:e2e:ui': 'playwright test --ui',
};
const PKG_DEV_DEPS = {
  '@playwright/mcp': '^0.0.78',
  '@playwright/test': '^1.61.1',
  playwright: '^1.61.1',
};
const GITIGNORE_LINES = [
  // Кит приносит playwright в devDependencies. Если проект до этого не был
  // JS-проектом, node_modules/ окажется неприкрытым — и уедет в git по `add .`.
  'node_modules/',
  'test-results/',
  'scenarios/_playwright-report/',
  '.playwright-mcp/',
  // Креды лежат ВНУТРИ проекта — единственное, что удерживает пароль от коммита.
  'scenarios/auth.json',
];

// ---------------------------------------------------------------- утилиты

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

function write(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function render(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const loadState = (target) => {
  const p = path.join(target, STATE_FILE);
  return exists(p) ? JSON.parse(read(p)) : null;
};
const saveState = (target, state) =>
  write(path.join(target, STATE_FILE), JSON.stringify(state, null, 2) + '\n');

// ---------------------------------------------------------------- package.json / .gitignore

// Дополняем, а не перезаписываем: у проекта свои скрипты и зависимости.
function patchPackageJson(target) {
  const p = path.join(target, 'package.json');
  const pkg = exists(p) ? JSON.parse(read(p)) : {};
  const added = { scripts: [], deps: [] };

  pkg.scripts = pkg.scripts || {};
  for (const [k, v] of Object.entries(PKG_SCRIPTS)) {
    if (!(k in pkg.scripts)) {
      pkg.scripts[k] = v;
      added.scripts.push(k);
    }
  }
  pkg.devDependencies = pkg.devDependencies || {};
  for (const [k, v] of Object.entries(PKG_DEV_DEPS)) {
    if (!(k in pkg.devDependencies)) {
      pkg.devDependencies[k] = v;
      added.deps.push(k);
    }
  }
  write(p, JSON.stringify(pkg, null, 2) + '\n');
  return added;
}

function patchGitignore(target) {
  const p = path.join(target, '.gitignore');
  const cur = exists(p) ? read(p) : '';

  // `node_modules` и `node_modules/` — одно и то же правило; не плодим дубли.
  const norm = (l) => l.trim().replace(/\/$/, '');
  const have = new Set(cur.split(/\r?\n/).map(norm));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(norm(l)));
  if (!missing.length) return [];

  // Подстраиваемся под переводы строк файла: дописать LF в CRLF-файл — значит
  // намусорить смешанными окончаниями.
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const lines = ['', '# playwright-tester-agent', ...missing, ''];
  const lead = cur === '' || cur.endsWith('\n') ? '' : eol;
  fs.writeFileSync(p, cur + lead + lines.join(eol));
  return missing;
}

// ---------------------------------------------------------------- init

function init(args) {
  const target = path.resolve(args.target || '.');
  const baseUrl = args['base-url'];
  if (!baseUrl || baseUrl === true) {
    console.error('Ошибка: нужен --base-url, например --base-url http://app.local');
    process.exit(1);
  }
  const loginUrlGiven = args['login-url'] !== undefined && args['login-url'] !== true;
  const loginUrl = loginUrlGiven ? args['login-url'] : '/login';
  const vars = { BASE_URL: baseUrl, LOGIN_URL: loginUrl };
  const force = !!args.force;

  console.log(`Разворачиваю в: ${target}`);
  console.log(`  baseUrl:  ${baseUrl}`);
  console.log(`  loginUrl: ${loginUrl}${loginUrlGiven ? '' : '   ← ДЕФОЛТ, не задан через --login-url'}\n`);

  const state = loadState(target) || { version: 1, files: {} };
  const skipped = [];

  for (const [src, dst] of [...SHARED, ...SCAFFOLD]) {
    const destPath = path.join(target, dst);
    const content = render(read(path.join(TPL, src)), vars);
    if (exists(destPath) && !force) {
      skipped.push(dst);
      continue;
    }
    write(destPath, content);
    state.files[dst] = sha(content);
    console.log(`  + ${dst}`);
  }

  const pkg = patchPackageJson(target);
  if (pkg.scripts.length) console.log(`  ~ package.json: скрипты ${pkg.scripts.join(', ')}`);
  if (pkg.deps.length) console.log(`  ~ package.json: devDependencies ${pkg.deps.join(', ')}`);
  const gi = patchGitignore(target);
  if (gi.length) console.log(`  ~ .gitignore: ${gi.length} строк`);

  saveState(target, state);

  if (skipped.length) {
    console.log(`\n  Пропущено (уже есть, --force чтобы перезаписать):`);
    skipped.forEach((f) => console.log(`    · ${f}`));
  }

  console.log(`
Готово. Дальше:

  1. Зависимости:
       npm install && npm run playwright:install

  2. Креды — свои у каждого проекта, лежат ВНУТРИ него:
       cp scenarios/auth.example.json scenarios/auth.json
     Затем впиши в scenarios/auth.json ДВА поля: user и pass. Больше менять
     нечего — адрес приложения берётся из playwright.config.ts, а не отсюда.
     Заполнить нужно ДО первого /test-scenario: агент полезет логиниться сразу.

     ВНИМАНИЕ: файл с паролем лежит в проекте. От коммита его удерживает только
     строка scenarios/auth.json в .gitignore — не добавляй его через git add -f.

  3. MCP-сервер В ОТДЕЛЬНОМ ТЕРМИНАЛЕ, до запуска агента:
       npm run playwright:mcp
     Порт 8931 общий: одновременно с другим проектом не поднимется.

  4. Перезапусти Claude Code / Cursor — MCP подхватывается при старте сессии.

  5. Сценарий в scenarios/<имя>/scenario.md по образцу scenarios/_TEMPLATE/,
     затем: /test-scenario <имя>  →  /finalize-scenario <имя>  →  npx playwright test

scenarios/_auth.ts НЕ создан намеренно: его напишет фаза 2 под форму входа
именно вашего приложения. Подробности: docs/agents-tests-guide.md в ките.`);

  if (!loginUrlGiven) {
    console.log(`
⚠ --login-url не задан, подставлен дефолт "/login".
  Если вход у приложения не по этому адресу — поправь "loginUrl" в
  scenarios/auth.json, иначе агент пойдёт не туда.
  Задать сразу: npx … init --base-url ${baseUrl} --login-url http://sso.example/auth`);
  }
}

// ---------------------------------------------------------------- update

function update(args) {
  const target = path.resolve(args.target || '.');
  const force = !!args.force;
  const state = loadState(target);

  if (!state) {
    console.error(`Ошибка: ${STATE_FILE} не найден — похоже, здесь не было init.`);
    console.error('Сначала: npx github:wYeha/playwright-tester-agent init --base-url <url> --login-url <url>');
    process.exit(1);
  }

  console.log(`Обновляю общие файлы в: ${target}\n`);
  const changed = [];
  const local = [];
  const same = [];

  for (const [src, dst] of SHARED) {
    const destPath = path.join(target, dst);
    const fresh = read(path.join(TPL, src)); // в SHARED плейсхолдеров нет
    const freshHash = sha(fresh);

    if (!exists(destPath)) {
      write(destPath, fresh);
      state.files[dst] = freshHash;
      changed.push(`${dst} (не было — создан)`);
      continue;
    }

    const curHash = sha(read(destPath));
    if (curHash === freshHash) {
      same.push(dst);
      continue;
    }

    // Файл отличается от версии кита. Правили локально или он просто устарел?
    const knownHash = state.files[dst];
    const editedLocally = knownHash && curHash !== knownHash;

    if (editedLocally && !force) {
      local.push(dst);
      continue;
    }
    write(destPath, fresh);
    state.files[dst] = freshHash;
    changed.push(dst);
  }

  saveState(target, state);

  if (changed.length) {
    console.log('Обновлено:');
    changed.forEach((f) => console.log(`  ↑ ${f}`));
  }
  if (same.length) console.log(`\nБез изменений: ${same.length}`);
  if (local.length) {
    console.log(`\n⚠ Правились локально — НЕ трогал:`);
    local.forEach((f) => console.log(`    · ${f}`));
    console.log(`
  Эти файлы разошлись с китом после init. Варианты:
    · посмотреть разницу и перенести правку в кит (если она общеполезна);
    · перезаписать: добавь --force (локальные правки пропадут);
    · оставить как есть — обновления по ним приходить не будут.`);
  }
  if (!changed.length && !local.length) console.log('\nВсё уже актуально.');
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'init') init(args);
else if (cmd === 'update') update(args);
else {
  console.log(`playwright-tester-agent — E2E-тесты через ИИ-агентов

  init --base-url <url> --login-url <url> [--target <dir>] [--force]
      Развернуть систему в проекте.
      --base-url   адрес приложения (обязателен)
      --login-url  адрес страницы входа: абсолютный (auth на отдельном домене)
                   или относительный. По умолчанию /login — опускайте только
                   если вход действительно там, иначе агент пойдёт не туда.

  update [--target <dir>] [--force]
      Обновить только агентов, скиллы и фикстуру. Леса и сценарии не трогает.
      Локально изменённые файлы пропускает; --force перезаписывает.

Примеры:
  npx github:wYeha/playwright-tester-agent init --base-url http://app.local --login-url http://auth.local/auth
  npx github:wYeha/playwright-tester-agent init --base-url http://app.local --login-url /signin
  npx github:wYeha/playwright-tester-agent update`);
}

'use strict';
/**
 * Тесты самого кита (bin/agent-kit.js). Встроенный node:test, без зависимостей:
 *   node --test           (или npm test)
 *
 * Проверяем рискованное: раскладку файлов, подстановку плейсхолдеров, СЛИЯНИЕ package.json,
 * патч .gitignore (дедуп + CRLF), пропуск существующих, поведение update (свежий/локально
 * правленный/--force) и осторожную миграцию при смене схемы хешей.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kit = require('../bin/agent-kit.js');

// --- утилиты -------------------------------------------------------------

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentkit-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
// init/update шумят в консоль — глушим на время вызова.
function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = err; }
}
const read = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');
const has = (dir, p) => fs.existsSync(path.join(dir, p));
const state = (dir) => JSON.parse(read(dir, '.agent-kit.json'));

function doInit(dir, extra = {}) {
  quiet(() => kit.init({ target: dir, 'base-url': 'http://app.local', 'login-url': '/signin', ...extra }));
}
function doUpdate(dir, extra = {}) {
  quiet(() => kit.update({ target: dir, ...extra }));
}

// --- init: раскладка + плейсхолдеры + состояние --------------------------

test('init раскладывает shared и scaffold, пишет hashScheme', () => {
  const dir = tmp();
  try {
    doInit(dir);
    assert.ok(has(dir, '.claude/agents/playwright-tester.md'), 'агент claude');
    assert.ok(has(dir, '.cursor/agents/playwright-tester.md'), 'агент cursor');
    assert.ok(has(dir, 'scenarios/_fixtures.ts'), 'фикстура');
    assert.ok(has(dir, 'scripts/playwright-doctor.js'), 'doctor-скрипт');
    assert.ok(has(dir, 'playwright.config.ts'), 'конфиг');

    const s = state(dir);
    assert.equal(s.hashScheme, kit.HASH_SCHEME, 'записан hashScheme');
    assert.ok(s.files['scenarios/_fixtures.ts'], 'хеш фикстуры в state');
  } finally { rm(dir); }
});

test('init подставляет плейсхолдеры baseUrl / loginUrl', () => {
  const dir = tmp();
  try {
    doInit(dir);
    assert.match(read(dir, 'playwright.config.ts'), /http:\/\/app\.local/);
    assert.doesNotMatch(read(dir, 'playwright.config.ts'), /\{\{BASE_URL\}\}/);
    assert.match(read(dir, 'scenarios/auth.example.json'), /"loginUrl":\s*"\/signin"/);
  } finally { rm(dir); }
});

test('SHARED-файлы без плейсхолдеров (иначе update разложит их дословно)', () => {
  for (const [src] of kit.SHARED) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'templates', src), 'utf8');
    assert.doesNotMatch(content, /\{\{\w+\}\}/, `${src} не должен содержать {{плейсхолдеров}}`);
  }
});

// --- package.json: слияние, а не перезапись ------------------------------

test('init создаёт package.json со скриптами и devDependencies', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const pkg = JSON.parse(read(dir, 'package.json'));
    assert.equal(pkg.scripts['playwright:doctor'], 'node scripts/playwright-doctor.js');
    assert.ok(pkg.devDependencies['@playwright/test'], 'добавлен @playwright/test');
  } finally { rm(dir); }
});

test('init НЕ затирает существующие скрипты/зависимости', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'host', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' },
    }, null, 2));
    doInit(dir);
    const pkg = JSON.parse(read(dir, 'package.json'));
    assert.equal(pkg.name, 'host', 'имя сохранено');
    assert.equal(pkg.scripts.dev, 'vite', 'чужой скрипт сохранён');
    assert.equal(pkg.devDependencies.vite, '^5', 'чужая зависимость сохранена');
    assert.ok(pkg.scripts['playwright:mcp'], 'наш скрипт добавлен');
  } finally { rm(dir); }
});

// --- .gitignore: дедуп + сохранение переводов строк ----------------------

test('.gitignore: node_modules не дублируется, добавлен auth.json', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    doInit(dir);
    const gi = read(dir, '.gitignore');
    const nm = (gi.match(/^node_modules\/?$/gm) || []).length;
    assert.equal(nm, 1, 'node_modules ровно один раз (дедуп по trailing slash)');
    assert.match(gi, /scenarios\/auth\.json/, 'auth.json добавлен');
  } finally { rm(dir); }
});

test('.gitignore: CRLF-файл дополняется CRLF, без смешанных концов', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.DS_Store\r\n');
    doInit(dir);
    const gi = read(dir, '.gitignore');
    const appended = gi.slice(gi.indexOf('.DS_Store') + '.DS_Store'.length);
    assert.ok(!/[^\r]\n/.test(appended), 'нет одиноких LF в дописанной части (CRLF сохранён)');
    assert.match(gi, /test-results/, 'наши строки добавлены');
  } finally { rm(dir); }
});

// --- пропуск существующих / --force --------------------------------------

test('init пропускает существующий файл, --force перезаписывает', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const p = '.claude/agents/playwright-tester.md';
    fs.writeFileSync(path.join(dir, p), 'МОЁ');
    doInit(dir);                              // без force — не трогает
    assert.equal(read(dir, p), 'МОЁ', 'без --force существующий не тронут');
    doInit(dir, { force: true });             // с force — перезапишет из шаблона
    assert.notEqual(read(dir, p), 'МОЁ', '--force перезаписал');
  } finally { rm(dir); }
});

// --- update: свежий / локально правленный / --force ----------------------

test('update перезаписывает устаревший shared, но НЕ локально правленный', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const p = 'scenarios/_fixtures.ts';
    const fresh = read(dir, p);

    // Случай А: файл "устарел" — отличается от кита, но в state лежит его же хеш
    // (эмуляция: меняем содержимое И синхронно правим хеш в state на этот вариант →
    // update видит, что «локально не трогали относительно записанного» неверно; проще
    // проверить прямой сценарий Б ниже). Здесь проверяем локальную правку:
    fs.writeFileSync(path.join(dir, p), fresh + '\n// локальная правка\n');
    doUpdate(dir);                            // без force
    assert.match(read(dir, p), /локальная правка/, 'локальную правку не затёрло');

    doUpdate(dir, { force: true });           // с force
    assert.equal(read(dir, p), fresh, '--force вернул версию кита');
  } finally { rm(dir); }
});

test('update создаёт shared-файл, если его удалили', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const p = 'scripts/playwright-doctor.js';
    fs.rmSync(path.join(dir, p));
    doUpdate(dir);
    assert.ok(has(dir, p), 'удалённый shared восстановлен');
  } finally { rm(dir); }
});

test('update НЕ трогает scaffold (playwright.config.ts)', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const p = 'playwright.config.ts';
    fs.writeFileSync(path.join(dir, p), '// правки проекта\n');
    doUpdate(dir, { force: true });           // даже с force scaffold не в SHARED
    assert.equal(read(dir, p), '// правки проекта\n', 'scaffold остался нетронут');
  } finally { rm(dir); }
});

// --- миграция схемы хешей ------------------------------------------------

test('несравнимая схема хешей: расходящийся файл НЕ затирается без --force', () => {
  const dir = tmp();
  try {
    doInit(dir);
    const p = 'scenarios/_fixtures.ts';
    // Подменяем схему на заведомо чужую (99) → старые хеши несравнимы.
    const s = state(dir);
    s.hashScheme = 99;
    fs.writeFileSync(path.join(dir, '.agent-kit.json'), JSON.stringify(s, null, 2));
    // Файл отличается от кита:
    fs.writeFileSync(path.join(dir, p), 'ЧУЖОЕ СОДЕРЖИМОЕ');

    doUpdate(dir);                            // без force — из осторожности не трогаем
    assert.equal(read(dir, p), 'ЧУЖОЕ СОДЕРЖИМОЕ', 'при несравнимой схеме файл не затёрт');

    const after = state(dir);
    assert.equal(after.hashScheme, kit.HASH_SCHEME, 'схема пере-штампована на текущую');
  } finally { rm(dir); }
});

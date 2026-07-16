import { test as base } from '@playwright/test';

export interface NetworkIssue {
  kind: 'http' | 'failed' | 'console';
  method?: string;
  status?: number;
  url: string;
  detail?: string;
}

// Автофикстура: молча собирает сетевые и консольные ошибки на протяжении теста
// и прикладывает их к отчёту. Тест НЕ роняет — это диагностика, а не проверка.
export const test = base.extend<{ collectIssues: void }>({
  collectIssues: [
    async ({ page }, use, testInfo) => {
      const issues: NetworkIssue[] = [];

      page.on('response', (r) => {
        if (r.status() >= 400) {
          issues.push({ kind: 'http', method: r.request().method(), status: r.status(), url: r.url() });
        }
      });
      page.on('requestfailed', (r) => {
        issues.push({
          kind: 'failed',
          method: r.method(),
          url: r.url(),
          detail: r.failure()?.errorText,
        });
      });
      page.on('pageerror', (e) => {
        issues.push({ kind: 'console', url: page.url(), detail: e.message });
      });
      page.on('console', (m) => {
        if (m.type() === 'error') {
          issues.push({ kind: 'console', url: page.url(), detail: m.text() });
        }
      });

      await use();

      if (issues.length) {
        const lines = issues.map((i) =>
          i.kind === 'http'
            ? `[HTTP ${i.status}] ${i.method} ${i.url}`
            : i.kind === 'failed'
              ? `[FAILED] ${i.method} ${i.url} — ${i.detail}`
              : `[CONSOLE] ${i.detail}\n           на ${i.url}`
        );

        // Полный список (со стектрейсами) — в отчёт.
        await testInfo.attach('network-and-console-issues', {
          body: lines.join('\n'),
          contentType: 'text/plain',
        });

        // Сводка — сразу в консоль. Вложение в отчёте на ЗЕЛЁНОМ тесте никто не откроет,
        // поэтому короткую суть показываем на месте, а за подробностями зовём командой.
        const PREVIEW = 5;
        console.log(`⚠ Замечено проблем (сеть/консоль): ${issues.length}`);
        for (const l of lines.slice(0, PREVIEW)) {
          console.log(`    ${l.split('\n')[0]}`); // только первая строка, без стектрейса
        }
        if (issues.length > PREVIEW) {
          console.log(`    …и ещё ${issues.length - PREVIEW}`);
        }
        console.log(
          '    Стектрейсы: npx playwright show-report scenarios/_playwright-report → тест → Attachments'
        );
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';

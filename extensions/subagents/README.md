# subagents — интерактивные субагенты для pi под Windows (WezTerm + pwsh)

Спавньте субагентов в собственные WezTerm-панели, продолжайте работать в главной
сессии — результат придёт steer-сообщением, когда агент закончит. Полностью
асинхронно.

Адаптация лучших практик
[amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
(tmux) под текущий стек: **Windows 11 + PowerShell 7 + WezTerm**. Surface-слой
переписан на `wezterm cli`, шелл-обвязка — на pwsh-лаунчеры.

## Инструменты

| Инструмент | Описание |
|---|---|
| `subagent` | Заспавнить субагента в отдельной панели (fire-and-forget) |
| `subagent_message` | Написать по имени: работающему — steer, завершившемуся — resume |
| `subagents_list` | Список доступных определений агентов |
| `task_batch` | Headless-батч без панелей (блокирующий): single / parallel (до 8) / chain с `{previous}` |
| `/subagent <agent> <task>` | Спавн с клавиатуры (с автодополнением имён) |

## Как это работает

```
родитель (pi)                      WezTerm
┌────────────────┐    split-pane ┌────────────────┐
│  subagent() ───┼──+───────────►│ scout   (панель)│
│  работает дальше│              │                 │
│  ◄─ steer ──────┼── .done файл ─│ pi --session …  │
│  (новый ход)    │  + сентинел   │ auto-exit       │
└────────────────┘               └────────────────┘
```

1. **Спавн.** Первый субагент — правый сплит родительской панели (50/50);
   следующие — вниз по правой колонке с процентом `k/(k+1)`, чтобы стопка
   оставалась ровной (`computeStackPercent`). После каждого сплайта фокус
   немедленно возвращается родителю через `activate-pane` (WezTerm всегда
   фокусирует новую панель — в отличие от tmux `split-window -d`).
2. **Лаунчер.** Панель исполняет `pwsh -NoExit -File <launcher.ps1>`. Скрипт
   выставляет `PI_SUBAGENT_*` env, делает `Set-Location`, запускает
   `pi --session <файл> -e <child-ext> … '@<task.md>'` и по выходе пишет
   сентинел `__SUBAGENT_DONE_<code>__` на экран и код выхода в `<session>.done`.
   Задача передаётся файлом-артефактом (`@path`), а не в командной строке.
3. **Завершение.** Вотчер (тик 1 с) детектит завершение по цепочке «файл →
   сайдкар → экран»: `.done` (быстрый путь), `.exit` (ошибка от child-ext),
   исчезновение панели (краш/закрыли руками), сентинел на экране (fallback).
4. **Результат.** Родитель извлекает из JSONL-сессии ребёнка последнее
   assistant-сообщение + usage (input/output/cost), пишет артефакт для
   `/trace` (`session-trace:subagents`) и доставляет итог steer-сообщением,
   запускающим новый ход родителя.
5. **Steer / resume.** `subagent_message` по имени: работающей панели —
   bracketed-paste в живой редактор pi; завершившейся — resume: тот же
   `--session <файл>` в её же панели (она остаётся открытой на pwsh-промпте)
   или в новой, если панель закрыли. Реестр имён —
   `<artifacts>/<sessionId>/subagent-registry.json`, переживает рестарт pi.

## Headless-батчи (`task_batch`)

Панельный `subagent` — асинхронный и интерактивный. Когда нужны результаты
«здесь и сейчас» в том же ходе, работает `task_batch`: дети запускаются как
`pi --mode json -p` без панелей, инструмент блокируется и возвращает всё одной
пачкой.

- **single** — `{ agent, task }` → финальный вывод ребёнка;
- **parallel** — `{ tasks: [...] }`, до 8 задач, конкурентность 4, вывод каждой
  задачи обрезается до 50 КБ;
- **chain** — `{ chain: [...] }` последовательно, `{previous}` в задаче
  подменяется выводом предыдущего шага, при ошибке цепочка останавливается.

Дети получают сессию под `~/.pi/agent/sessions/subagents/` (появляются
карточками в `/trace`) и нативный denylist `-xt subagent,subagent_message,subagents_list` —
панельные инструменты в headless-ребёнке бессмысленны и только жгут контекст.
Запуск разрешает и вложенность: `task_batch` сам себе не запрещён.

Windows-нюанс: Node не спавнит `.cmd`-шимы (EINVAL), поэтому раннер парсит шим
`pi.cmd` и запускает `node <dist/bundle/cli.js>` напрямую (`resolvePiEntry`).

## Живой статус

Child-расширение (`subagent-done.ts`, загружается в каждого субагента) пишет
activity-файл: фаза (starting/active/waiting/done), текущий инструмент,
монотонный sequence. Родитель раз в секунду читает его и рисует виджет:

```
Subagents — 2 running
▸ scout   active · grep  42s
▸ worker  waiting        2m10s
```

Если sequence не меняется дольше 60 с у auto-exit агента — steer-уведомление
«выглядит застывшим», при возобновлении — «снова активен».

## Авто-выход и вложенность

- По умолчанию агенты **автономные** (`auto-exit`): когда ход агента завершён и
  детей в полёте нет, child-ext глушит процесс (`ctx.shutdown()`), и родитель
  получает результат. `auto-exit: false` в frontmatter — интерактивный режим
  (панель живёт до закрытия человеком).
- Субагент может сам спавнить детей: перечислите разрешённых агентов в
  frontmatter (`subagents: scout, researcher`) — ему загрузится тот же
  оркестратор, ограниченный `PI_SUBAGENT_ALLOWED`. Пока дети не отчитались,
  auto-exit родителя-агента подавлен (`runningChildrenCount`).
- Frontmatter агентов: `name`, `description`, `model`, `thinking`, `tools`
  (allowlist → `--tools` + `-ne` в ребёнке), `subagents`, `auto-exit`;
  тело файла — identity, добавляется через `--append-system-prompt`.
  Приоритет: `.pi/agents/` проекта > `~/.pi/agent/agents/` глобальных.

## Отличия от tmux-оригинала

- **WezTerm вместо tmux**: сплайты с возвратом фокуса, ровная стопка процентами
  вместо `select-layout`, текст — bracketed paste (`send-text`), экран —
  `get-text`.
- **pwsh вместо bash**: лаунчеры — `.ps1` с одинарными кавычками (`''`),
  завершение — через `.done`-сайдкар (быстрее и надёжнее опроса экрана).
- **Нет ask_question** (v1): механика `.ask`-файлов из оригинала не портирована.
- Панели завершившихся агентов **не закрываются** — остаются на pwsh-промпте
  с видимым транскриптом; resume работает прямо в них.

## Файлы

| Файл | Роль |
|---|---|
| `index.ts` | Оркестратор: инструменты, `/subagent`, вотчер, виджет, реестр |
| `subagent-done.ts` | Child-расширение: identity, активность, auto-exit, `.exit` |
| `wezterm.ts` | Surface-слой: все вызовы `wezterm cli` изолированы здесь |
| `launcher.ts` | Генерация `.ps1`-лаунчеров (чистая, тестируемая) |
| `agents.ts` | Обнаружение агентов + парсер frontmatter |
| `activity.ts` | Рекордер активности (ребёнок) и читалка (родитель) |
| `session-read.ts` | Извлечение summary/usage из сессии ребёнка |
| `batch.ts` | Headless-батчи: парсинг JSON-событий, chain/parallel, раннер процессов |
| `registry.ts` | Реестр имён (tmp+rename, переживает рестарты) |

## Тесты

```bash
node --test extensions/subagents/test/*.test.ts   # юнит-тесты чистых модулей
node extensions/subagents/test/e2e-surface.manual.ts   # живой WezTerm, фейковый pi
node extensions/subagents/test/e2e-pi.manual.ts        # живой WezTerm + настоящий pi-ребёнок
node extensions/subagents/test/e2e-batch.manual.ts     # headless task_batch с настоящим pi
```

Manual-E2E открывают реальные панели и тратят токены — в `npm test` не входят.

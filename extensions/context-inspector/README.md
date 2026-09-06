# context-inspector

Расширение pi, показывающее, что модель реально видит в запросе: сколько занимает окно контекста, какая доля промпта пришла из кэша, из чего состоит system prompt, сколько весят схемы инструментов и какие сообщения самые тяжёлые.

Ничего не блокирует и не меняет. Только читает события и состояние сессии.

## Команды

| Команда | Действие |
|---|---|
| `/context` | Отчёт в прокручиваемом виде (TUI). В RPC режиме отправляет сводку одной строкой |
| `/context status` | Включить или выключить строку в футере: `ctx 42.1K/200K 21% · cache 91% · sys 8.2K · tools 6.1K · msgs 27.8K` |
| `/context log` | Включить или выключить запись снимков в `.pi/context-inspector.jsonl` после каждого ответа модели и каждой компакции |

Клавиши в отчёте: стрелки, PgUp, PgDn, Home, End, `j`/`k`, `r` пересчитать, `q` или Esc закрыть.

## Что в отчёте

- **Occupancy**. Оценка занятости окна от pi и порог автокомпакции с учётом `compaction.reserveTokens` из глобального и проектного settings.json.
- **Last response**. Точные числа из usage последнего ответа провайдера: input, cache read, cache write, output, стоимость. Доля кэша считается как cacheRead от всего промпта.
- **Last payload**. Размер последнего реально отправленного запроса и его разбивка на system, tools, messages. Определяет форму payload для Anthropic, OpenAI completions, OpenAI responses и Google.
- **System prompt**. Базовый промпт, каждый файл AGENTS.md или CLAUDE.md отдельно, блок skills, сниппеты инструментов, guidelines, `--append-system-prompt`.
- **Tools**. Токены каждой зарегистрированной схемы, активные отдельно от неактивных.
- **Messages**. Записи, которые сейчас в контексте после компакции: по ролям, по инструментам, десять самых тяжёлых с превью и id записи для `/tree`.

Все оценки, кроме Last response, считаются как символы делить на четыре. Это та же эвристика, что использует pi для своих оценок, поэтому числа согласуются с футером pi.

## Источники данных

| Событие или API | Что даёт |
|---|---|
| `before_agent_start` | `systemPromptOptions` со структурой system prompt |
| `before_provider_request` | реальный payload запроса |
| `message_end` | usage ответа провайдера |
| `sessionManager.buildContextEntries()` | записи в контексте после компакции |
| `getAllTools()`, `getActiveTools()` | схемы инструментов |
| `getContextUsage()` | занятость окна по оценке pi |

## Установка

Как часть этого пакета:

```bash
pi install /path/to/pi-extensions
```

Или напрямую на время сессии:

```bash
pi -e ./extensions/context-inspector/index.ts
```

## Разработка

```bash
npm test          # node --test, без зависимостей от pi
npm run smoke     # pi --list-models -e ..., проверяет загрузку factory
```

Для проверки типов нужны junction-ссылки на глобальную установку pi в `node_modules/@earendil-works` и `node_modules/@types`, затем `npx -p typescript tsc -p tsconfig.json`.

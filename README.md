# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [context-inspector](extensions/context-inspector/) | `/context` | Что реально видит модель: занятость окна, доля кэша, состав system prompt, вес схем инструментов, самые тяжёлые сообщения |
| [session-ledger](extensions/session-ledger/) | `/stats` | Расходы и активность по всем сессиям на машине: стоимость, токены, кэш, вызовы и ошибки инструментов, компакции |
| [session-recall](extensions/session-recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [session-trace](extensions/session-trace/) | `/trace`, `/trace-web` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; плюс CLI и веб-вьюер |
| [subagents](extensions/subagents/) | `subagent`, `task_batch`, `/subagent`, `/workers` | Субагенты: интерактивные в терминальных панелях — WezTerm или herdr (спавн/steer+interrupt/resume/cancel, живой статус) + headless-батчи single/parallel/chain (Windows + pwsh); глобальный индекс живых воркеров |
| [web-search](extensions/web-search/) | `web_search` | Веб-поиск DuckDuckGo без API-ключей: структурированные запросы (точные фразы/исключения/сайт), таймаут и ретрай. На основе расширения Eero Alvar (amosblomqvist) |

## Запуск

Требуется Node >= 22.18.

```bash
npm test   # тесты всех расширений
npm smoke  # проверить, что расширения грузятся в pi
```

### Деплой в ~/.pi/agent/extensions

pi грузит расширения из установленных копий в `~/.pi/agent/extensions/`, а разработка идёт в `extensions/` этого репозитория. После правок синкайте, иначе сессия выполняет протухший код:

```bash
npm run sync        # скопировать изменившиеся файлы в ~/.pi/agent/extensions
npm run sync:check  # только проверить расхождения (exit 1, если протухло)
```

Скрипт не удаляет ничего (файлы, которых нет в репозитории, остаются и помечаются как extras), не трогает расширения вне репозитория и пропускает `test/`.

Каждое расширение работает и без pi — через CLI:

```bash
npm run stats        # session-ledger
npm run recall       # session-recall
npm run trace        # session-trace, терминальный вьюер
npm run trace:web    # session-trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.

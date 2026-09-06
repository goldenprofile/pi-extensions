# pi-extensions

Личный pi-пакет: расширения для pi coding agent. Подключается ключом `"pi"` в package.json, все расширения грузятся при старте pi.

| Расширение | Команда | Что делает |
|---|---|---|
| [context-inspector](extensions/context-inspector/) | `/context` | Что реально видит модель: занятость окна, доля кэша, состав system prompt, вес схем инструментов, самые тяжёлые сообщения |
| [session-ledger](extensions/session-ledger/) | `/stats` | Расходы и активность по всем сессиям на машине: стоимость, токены, кэш, вызовы и ошибки инструментов, компакции |
| [session-recall](extensions/session-recall/) | `/recall` | Полнотекстовый поиск по всем сессиям всех проектов с переходом в найденную сессию |
| [session-trace](extensions/session-trace/) | `/trace`, `/trace-web` | Живой flow-граф сессии: карточки ходов, чипы инструментов, маркеры на таймлайне; плюс CLI и веб-вьюер |

## Запуск

Требуется Node >= 22.18.

```bash
npm test   # тесты всех расширений
npm smoke  # проверить, что расширения грузятся в pi
```

Каждое расширение работает и без pi — через CLI:

```bash
npm run stats        # session-ledger
npm run recall       # session-recall
npm run trace        # session-trace, терминальный вьюер
npm run trace:web    # session-trace, веб-вьюер
```

Подробнее — README внутри каждой папки в `extensions/`.

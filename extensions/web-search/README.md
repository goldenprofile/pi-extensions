# web-search — DuckDuckGo-поиск для pi без API-ключей

Инструмент `web_search`: полнотекстовый веб-поиск через HTML-endpoint
DuckDuckGo. Без ключей, без квот, со структурированными аргументами
(базовый запрос + точные фразы + исключения + сайт).

Основа — расширение **web-search** автора **Eero Alvar
([amosblomqvist](https://github.com/amosblomqvist))** из
[pi-config](https://github.com/amosblomqvist/pi-config/tree/main/extensions/web-search),
использовавшее Google Custom Search API. Эта версия вместо него ходит на
DuckDuckGo (`html.duckduckgo.com/html/`): тот же контракт инструмента, но
без учётных данных; плюс таймаут, ретрай на бот-чек, отдельный парсер и тесты.

## Использование

```
web_search({
  query: "postgres skip locked",        // базовый запрос
  exactPhrases: ["FOR UPDATE SKIP"],    // станут "точными фразами"
  excludeTerms: ["mysql", "sqlite 3"],  // -mysql -"sqlite 3"
  site: "stackoverflow.com",            // site:stackoverflow.com
  count: 5,                             // 1..10, по умолчанию 5
})
```

Один вызов — один угол поиска: не собирай несколько запросов в один вызов,
точные фразы передавай через `exactPhrases`, а не кавычками внутри `query`.

## Как это работает

- **Запрос** строится в чистом `query.ts` (без зависимостей — полностью покрыт
  тестами): нормализация `site`, экранирование кавычек, склейка операторов.
- **Сеть**: POST form-encoded на `html.duckduckgo.com/html/` с полным набором
  браузерных заголовков (GET и голый UA получают 403/202 бот-чек). Таймаут 20 с
  (`AbortSignal.timeout`), один ретрай с паузой 1.5 с на транзиентные ответы
  (202/403/429/challenge-page). Отмена инструмента пробрасывается сразу.
- **Парсинг** (`parse.ts`, linkedom): `div.result` → `a.result__a` (заголовок +
  редирект-обёртка `//duckduckgo.com/l/?uddg=<encoded>` разворачивается обратно
  в целевой URL) + `a.result__snippet`.
- В `details` возвращается составленный запрос, счётчик результатов и время
  выполнения; рендереры показывают запрос при вызове и «N results in Xs» при
  результате (раскрытие — превью выдачи).

## Файлы

| Файл | Роль |
|---|---|
| `index.ts` | Инструмент `web_search`: схема, сеть, ретрай, рендереры |
| `query.ts` | Чистая логика построения запроса (без зависимостей) |
| `parse.ts` | Парсер выдачи DuckDuckGo (linkedom) |
| `test/` | Юнит-тесты `query.ts` и `parse.ts` |

## Тесты

```bash
npm install          # linkedom для parse.test.ts
node --test extensions/web-search/test/*.test.ts
```

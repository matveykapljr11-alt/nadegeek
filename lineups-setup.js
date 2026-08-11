/*
 * Lineups — разовая настройка бота через Telegram Bot API (без зависимостей).
 * Ставит кнопку меню бота на Web App (Mini App открывается прямо из чата с ботом),
 * задаёт короткое описание и команду /start.
 *
 * Запуск (после деплоя сервера):
 *   BOT_TOKEN=123:ABC PUBLIC_URL=https://lineups.onrender.com node lineups-setup.js
 *   // или: BOT_TOKEN=123:ABC node lineups-setup.js https://lineups.onrender.com
 *
 * Что нельзя сделать через Bot API (делается вручную в @BotFather один раз):
 *   - /newapp — создать именованный Mini App, чтобы работали ссылки t.me/<bot>/<app>?startapp=<id>.
 *     Deep-link «поделиться раскидкой» использует именно эту форму (APP_NAME на сервере).
 */

const https = require('https');
const TOKEN = process.env.BOT_TOKEN || '';
const URL = process.env.PUBLIC_URL || process.argv[2] || '';

if (!TOKEN || !URL) {
  console.error('Нужны BOT_TOKEN и PUBLIC_URL (или URL аргументом).');
  console.error('Пример: BOT_TOKEN=123:ABC node lineups-setup.js https://lineups.onrender.com');
  process.exit(1);
}
if (!/^https:\/\//.test(URL)) { console.error('PUBLIC_URL должен начинаться с https://'); process.exit(1); }

function call(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, resp => {
      let b = ''; resp.on('data', c => b += c);
      resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  const me = await call('getMe');
  if (!me.ok) { console.error('getMe:', me); process.exit(1); }
  console.log('Бот: @' + me.result.username);

  const btn = await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Раскидки', web_app: { url: URL } }
  });
  console.log('Кнопка меню (Web App):', btn.ok ? 'ок → ' + URL : btn.description);

  const sd = await call('setMyShortDescription', {
    short_description: 'Раскидки гранат по картам: где встать, куда целиться, как бросить.'
  });
  console.log('Короткое описание:', sd.ok ? 'ок' : sd.description);

  const cmd = await call('setMyCommands', {
    commands: [{ command: 'start', description: 'Открыть раскидки' }]
  });
  console.log('Команды:', cmd.ok ? 'ок' : cmd.description);

  console.log('\nГотово. Открой чат с @' + me.result.username + ' и нажми кнопку «Раскидки».');
  console.log('Для ссылок t.me/' + me.result.username + '/<app>?startapp=<id> создай Mini App через @BotFather /newapp и задай APP_NAME на сервере.');
})().catch(e => { console.error('Ошибка:', e.message || e); process.exit(1); });

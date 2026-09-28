/**
 * טריוויה טלפונית - ימות המשיח + Cloudflare Workers
 * ================================================
 * כתובות:
 *   /            - זה מה שימות המשיח קורא (api_link)
 *   /admin       - פאנל ניהול (עריכת ת"ז, שאלות, וצפייה בתוצאות)
 *   /results     - JSON גולמי עם כל התוצאות
 *
 * מרגע שהמערכת רצה פעם אחת, עריכת שאלות/ת"ז נעשית דרך /admin -
 * אין יותר צורך לערוך את הקובץ הזה או לעשות git commit בשביל זה.
 * עורכים את הקובץ הזה רק אם רוצים לשנות את עצם ההתנהגות של המערכת.
 */

// ============ לערוך פה רק פעם אחת: סוד לכניסה לפאנל הניהול ============
const ADMIN_SECRET = 'CHANGE_ME_TO_SOMETHING_SECRET';

// ============ ברירת מחדל להתחלה - אח"כ עורכים הכל דרך /admin ============
const DEFAULT_ALLOWED_IDS = ['123456789', '987654321'];
const DEFAULT_QUESTIONS = [
    {
        text: 'מהי בירת ישראל להקשה 1 תל אביב להקשה 2 ירושלים להקשה 3 חיפה',
        validKeys: '123',
        correct: '2',
    },
    {
        text: 'כמה זה שתיים ועוד שתיים להקשה 1 שלוש להקשה 2 ארבע להקשה 3 חמש',
        validKeys: '123',
        correct: '2',
    },
];

// ============ קוד המערכת ============

async function loadConfig(env) {
    const raw = await env.TRIVIA_KV.get('config');
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            // אם משהו השתבש בשמירה, נופלים חזרה לברירת המחדל
        }
    }
    const initial = { allowedIds: DEFAULT_ALLOWED_IDS, questions: DEFAULT_QUESTIONS };
    await env.TRIVIA_KV.put('config', JSON.stringify(initial));
    return initial;
}

async function saveConfig(env, config) {
    await env.TRIVIA_KV.put('config', JSON.stringify(config));
}

function checkSecret(url) {
    return url.searchParams.get('secret') === ADMIN_SECRET;
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

// ---------- לוגיקת השיחה הטלפונית (ימות המשיח) ----------

function sanitizeTTS(text) {
    return String(text)
        .replace(/=/g, ' שווה ')
        .replace(/&/g, ' וגם ')
        .replace(/,/g, ' ')
        .replace(/\./g, ' ')
        .replace(/-/g, ' ')
        .replace(/["']/g, '')
        .trim();
}

function buildRead(name, ttsMessage, { max, min, sayAs = 'NO', allowedDigits = '' }) {
    const params = [
        name, '', String(max), String(min), '7', sayAs, '', '', '',
        allowedDigits, '1', 'Ok', 'timeout', '', 'no',
    ].join(',');
    return `read=t-${sanitizeTTS(ttsMessage)}=${params}`;
}

function plainTextResponse(body) {
    return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleYemot(request, env) {
    const url = new URL(request.url);
    const params = url.searchParams;
    const config = await loadConfig(env);
    const id = params.get('id');

    if (!id) {
        return plainTextResponse(
            buildRead('id', 'ברוכים הבאים לטריוויה הטלפונית אנא הקישו את מספר תעודת הזהות שלכם ולאחר מכן הקישו סולמית',
                { max: 9, min: 8, sayAs: 'TeudatZehut' })
        );
    }

    const cleanId = id.replace(/\D/g, '');
    if (!config.allowedIds.includes(cleanId)) {
        return plainTextResponse(
            `id_list_message=t-מספר תעודת הזהות שהוקש אינו מזוהה במערכת להתראות&go_to_folder=..`
        );
    }

    const answers = [];
    for (let i = 0; i < config.questions.length; i++) {
        const given = params.get(`ans_${i}`);
        if (given === null) break;
        const question = config.questions[i];
        answers.push({
            questionIndex: i,
            questionText: question.text,
            answerGiven: given,
            correct: given === question.correct,
        });
    }

    await env.TRIVIA_KV.put(
        cleanId,
        JSON.stringify({ id: cleanId, lastUpdated: new Date().toISOString(), answers })
    );

    const answeredCount = answers.length;

    if (answeredCount < config.questions.length) {
        const nextQuestion = config.questions[answeredCount];
        return plainTextResponse(
            buildRead(`ans_${answeredCount}`, nextQuestion.text, { max: 1, min: 1, allowedDigits: nextQuestion.validKeys })
        );
    }

    const correctCount = answers.filter((a) => a.correct).length;
    return plainTextResponse(
        `id_list_message=t-סיימתם את הטריוויה ענית נכון על ${correctCount} מתוך ${config.questions.length} שאלות תודה ולהתראות&go_to_folder=..`
    );
}

// ---------- API לפאנל הניהול ----------

async function handleAdminGetConfig(request, env) {
    const url = new URL(request.url);
    if (!checkSecret(url)) return jsonResponse({ error: 'unauthorized' }, 401);
    const config = await loadConfig(env);
    return jsonResponse(config);
}

async function handleAdminSaveConfig(request, env) {
    const url = new URL(request.url);
    if (!checkSecret(url)) return jsonResponse({ error: 'unauthorized' }, 401);
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResponse({ error: 'invalid json' }, 400);
    }
    if (!Array.isArray(body.allowedIds) || !Array.isArray(body.questions)) {
        return jsonResponse({ error: 'invalid structure' }, 400);
    }
    await saveConfig(env, { allowedIds: body.allowedIds, questions: body.questions });
    return jsonResponse({ ok: true });
}

async function handleAdminResults(request, env) {
    const url = new URL(request.url);
    if (!checkSecret(url)) return jsonResponse({ error: 'unauthorized' }, 401);
    const list = await env.TRIVIA_KV.list();
    const results = {};
    for (const key of list.keys) {
        if (key.name === 'config') continue;
        const value = await env.TRIVIA_KV.get(key.name);
        try {
            results[key.name] = JSON.parse(value);
        } catch (e) {
            results[key.name] = value;
        }
    }
    return jsonResponse(results);
}

// ---------- דף הניהול (HTML) ----------

function adminPageHTML(secret) {
    return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ניהול טריוויה</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f4f5f7; margin: 0; padding: 20px; color: #1a1a1a; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #666; margin-bottom: 20px; font-size: 14px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 10px 18px; background: #fff; border-radius: 10px; cursor: pointer; border: 2px solid transparent; font-weight: 600; }
  .tab.active { border-color: #4f46e5; color: #4f46e5; }
  .panel { display: none; }
  .panel.active { display: block; }
  .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  input[type=text], textarea { width: 100%; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
  textarea { resize: vertical; min-height: 50px; }
  .small { width: 70px; flex: none; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 600; font-size: 14px; }
  .btn-primary { background: #4f46e5; color: #fff; }
  .btn-danger { background: #fee2e2; color: #b91c1c; }
  .btn-secondary { background: #eee; color: #333; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; }
  th, td { padding: 10px; text-align: right; border-bottom: 1px solid #eee; font-size: 14px; }
  th { background: #f0f0f0; }
  .correct { color: #15803d; font-weight: 700; }
  .wrong { color: #b91c1c; font-weight: 700; }
  .toast { position: fixed; bottom: 20px; left: 20px; background: #1a1a1a; color: #fff; padding: 12px 20px; border-radius: 10px; display: none; }
  .qlabel { font-size: 12px; color: #888; margin-bottom: 2px; }
</style>
</head>
<body>

<h1>ניהול טריוויה</h1>
<div class="sub">כל שינוי שנשמר כאן נכנס לתוקף מיד בשיחה הבאה</div>

<div class="tabs">
  <div class="tab active" data-tab="ids">ת"ז מאושרות</div>
  <div class="tab" data-tab="questions">שאלות</div>
  <div class="tab" data-tab="results">תוצאות</div>
</div>

<div id="panel-ids" class="panel active">
  <div class="toolbar">
    <button class="btn-primary" onclick="addId()">+ ת"ז חדשה</button>
    <button class="btn-secondary" onclick="saveConfig()">שמור שינויים</button>
  </div>
  <div id="ids-list"></div>
</div>

<div id="panel-questions" class="panel">
  <div class="toolbar">
    <button class="btn-primary" onclick="addQuestion()">+ שאלה חדשה</button>
    <button class="btn-secondary" onclick="saveConfig()">שמור שינויים</button>
  </div>
  <div id="questions-list"></div>
</div>

<div id="panel-results" class="panel">
  <div class="toolbar">
    <button class="btn-secondary" onclick="loadResults()">רענן</button>
  </div>
  <table id="results-table">
    <thead><tr><th>ת"ז</th><th>עודכן לאחרונה</th><th>נכון מתוך</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<div class="toast" id="toast"></div>

<script>
const SECRET = ${JSON.stringify(secret)};
let config = { allowedIds: [], questions: [] };

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'results') loadResults();
  };
});

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
}

async function loadConfigFromServer() {
  const res = await fetch('/admin/api/config?secret=' + encodeURIComponent(SECRET));
  config = await res.json();
  renderIds();
  renderQuestions();
}

function renderIds() {
  const el = document.getElementById('ids-list');
  el.innerHTML = '';
  config.allowedIds.forEach((id, i) => {
    const row = document.createElement('div');
    row.className = 'card row';
    row.innerHTML = \`
      <input type="text" value="\${id}" oninput="config.allowedIds[\${i}] = this.value.replace(/\\\\D/g,'')" maxlength="9">
      <button class="btn-danger" onclick="removeId(\${i})">מחק</button>
    \`;
    el.appendChild(row);
  });
}

function addId() { config.allowedIds.push(''); renderIds(); }
function removeId(i) { config.allowedIds.splice(i, 1); renderIds(); }

function renderQuestions() {
  const el = document.getElementById('questions-list');
  el.innerHTML = '';
  config.questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = \`
      <div class="qlabel">שאלה \${i + 1} - טקסט (כולל הנחיית הקשות)</div>
      <textarea oninput="config.questions[\${i}].text = this.value">\${q.text}</textarea>
      <div class="row" style="margin-top:8px">
        <div>
          <div class="qlabel">ספרות מותרות</div>
          <input type="text" class="small" value="\${q.validKeys}" oninput="config.questions[\${i}].validKeys = this.value">
        </div>
        <div>
          <div class="qlabel">תשובה נכונה</div>
          <input type="text" class="small" value="\${q.correct}" oninput="config.questions[\${i}].correct = this.value">
        </div>
        <button class="btn-danger" onclick="removeQuestion(\${i})" style="margin-right:auto">מחק שאלה</button>
      </div>
    \`;
    el.appendChild(card);
  });
}

function addQuestion() {
  config.questions.push({ text: '', validKeys: '123', correct: '1' });
  renderQuestions();
}
function removeQuestion(i) { config.questions.splice(i, 1); renderQuestions(); }

async function saveConfig() {
  const res = await fetch('/admin/api/config?secret=' + encodeURIComponent(SECRET), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (res.ok) showToast('נשמר בהצלחה');
  else showToast('שגיאה בשמירה');
}

async function loadResults() {
  const res = await fetch('/admin/api/results?secret=' + encodeURIComponent(SECRET));
  const data = await res.json();
  const tbody = document.querySelector('#results-table tbody');
  tbody.innerHTML = '';
  Object.values(data).forEach(entry => {
    const correctCount = (entry.answers || []).filter(a => a.correct).length;
    const total = (entry.answers || []).length;
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td>\${entry.id}</td><td>\${new Date(entry.lastUpdated).toLocaleString('he-IL')}</td><td>\${correctCount} / \${total}</td>\`;
    tbody.appendChild(tr);
  });
}

loadConfigFromServer();
</script>
</body>
</html>`;
}

async function handleAdminPage(request) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== ADMIN_SECRET) {
        return new Response('סיסמה שגויה. הוסף ?secret=... לכתובת.', { status: 401 });
    }
    return new Response(adminPageHTML(secret), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------- ניתוב ----------

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/admin') return handleAdminPage(request);
        if (url.pathname === '/admin/api/config' && request.method === 'GET') return handleAdminGetConfig(request, env);
        if (url.pathname === '/admin/api/config' && request.method === 'POST') return handleAdminSaveConfig(request, env);
        if (url.pathname === '/admin/api/results') return handleAdminResults(request, env);
        if (url.pathname === '/results') return handleAdminResults(request, env); // תאימות לאחור

        return handleYemot(request, env);
    },
};

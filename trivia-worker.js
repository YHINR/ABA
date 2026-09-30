/**
 * טריוויה טלפונית - ימות המשיח + Cloudflare Workers
 * ================================================
 * כתובות:
 *   /            - זה מה שימות המשיח קורא (api_link)
 *   /admin       - פאנל ניהול (משתתפים, שאלות, תוצאות וייצוא)
 *
 * עריכת משתתפים ושאלות נעשית כולה דרך /admin - אין יותר צורך
 * לגעת בקובץ הזה בשביל זה. עורכים את הקובץ רק כדי לשנות את
 * ההתנהגות הבסיסית של המערכת עצמה.
 */

// ============ לערוך פה רק פעם אחת: סוד לכניסה לפאנל הניהול ============
const ADMIN_SECRET = 'ABATRIVIA';

// true  = המערכת תמיד משתמשת ברשימות שכתובות כאן בקוד (עריכה דרך גיטהב מיד נכנסת לתוקף).
//         עריכות שנעשות בפאנל /admin לא ישפיעו כל עוד זה true.
// false = המערכת משתמשת ברשימה ששמורה ב-KV (עריכה דרך /admin).
const USE_CODE_LISTS = true;

// מספר גרסה - מופיע בכתובת /version כדי לוודא איזה קוד רץ עכשיו
const VERSION = '6';

// הודעות המערכת המוקלטות בימות המשיח (מספר בלי האות M)
const MSG = {
    WELCOME: 1203,
    ASK_ID: 5666,
    CORRECT: 1200,
    WRONG: 1210,
    NEXT_QUESTION: 1206,
    QUESTION_IS: 1207,
    PRESS_CORRECT: 1208,
    TICK: 1209,
    ANSWER_NUMBERS: [1211, 1212, 1213, 1214],
    RETRY: 1215,
    FINISHED: 1239,
    ALL_CORRECT: 1228,
    NOT_ALL_CORRECT: 1248,
    REVEAL: 1216,
    TOTAL_NOW: 1222,
    TOTAL_END: 1235,
    DOUBLE: 1236,
    FAIL_RANGE: [1240, 1247],
    SUCCESS_RANGE: [1250, 1266],
};

// כמה שניות מחכים להקשה אחרי שהשאלה והתשובות הושמעו
const QUESTION_WAIT_SECONDS = 15;

// באיזה אחוז הצלחה לפחות נחשב "הצלחה" (להשמעת אחת מהודעות 1250-1266)
const SUCCESS_MIN_PERCENT = 100;

// ============ ברירת מחדל להתחלה - אח"כ הכל מנוהל דרך /admin ============
const DEFAULT_PARTICIPANTS = [
    { id: '216516435', lastName: 'ישראלי', firstName: 'ישראל', class: 'א\'', institution: 'בית ספר לדוגמה' },
];
const DEFAULT_QUESTIONS = [
    {
        text: 'מה קורה?',
        answers: ['בסדר', 'לא טוב', 'חמוד', 'לא בסדר'],
        validKeys: '1234',
        correct: '3',
    },
    {
        text: 'כמה אתה אוהב את חיפה?',
        answers: ['מאוד אוהב את חיפה', 'רוצה לברוח מחיפה'],
        validKeys: '12',
        correct: '1',
    },
];

// הגדרות כלליות לכל השאלות (נערך דרך trivia-editor.html). לכל שאלה אפשר לדרוס חלק מהן ב-overrides
const DEFAULT_SETTINGS = {
    "points1": 2,
    "points2": 1,
    "onlyOnce": false,
    "revealAnswer": true,
    "waitSeconds": 5,
    "dontSayOutcome": false,
    "order": "by_number",
    "maxQuestions": 0,
    "welcome": "trivia",
    "specialAnswer": true,
    "successMinPercent": 100,
    "sayTotal": true,
    "finishDoublePoints": false,
    "dontSayEndGame": false
};

function eff(G, q) { return { ...G, ...(q.overrides || {}) }; }

// סדר השמעה קבוע לכל משתתף (אקראי לפי ת.ז.) כדי שהשאלות לא יתחלפו בין הקשות
function playOrder(G, n, id) {
    const idx = Array.from({ length: n }, (_, i) => i);
    if (G.order === 'by_number_desc') idx.reverse();
    else if (G.order === 'random') {
        let s = 0;
        for (const c of id) s = (s * 31 + c.charCodeAt(0)) >>> 0;
        for (let i = n - 1; i > 0; i--) {
            s = (s * 1664525 + 1013904223) >>> 0;
            const j = s % (i + 1);
            [idx[i], idx[j]] = [idx[j], idx[i]];
        }
    }
    const max = Number(G.maxQuestions) || 0;
    return max > 0 ? idx.slice(0, max) : idx;
}

// ============ קוד המערכת ============

async function loadConfig(env) {
    if (USE_CODE_LISTS) {
        return { participants: DEFAULT_PARTICIPANTS, questions: DEFAULT_QUESTIONS };
    }
    const raw = await env.TRIVIA_KV.get('config');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            // תאימות לאחור: גרסה ישנה שהחזיקה allowedIds בלבד
            if (!parsed.participants && Array.isArray(parsed.allowedIds)) {
                parsed.participants = parsed.allowedIds.map((id) => ({
                    id, lastName: '', firstName: '', class: '', institution: '',
                }));
            }
            if (!Array.isArray(parsed.participants)) parsed.participants = [];
            if (!Array.isArray(parsed.questions)) parsed.questions = [];
            return parsed;
        } catch (e) {
            // נופל לברירת מחדל
        }
    }
    const initial = { participants: DEFAULT_PARTICIPANTS, questions: DEFAULT_QUESTIONS };
    await env.TRIVIA_KV.put('config', JSON.stringify(initial));
    return initial;
}

async function saveConfig(env, config) {
    await env.TRIVIA_KV.put('config', JSON.stringify(config));
}

// ---------- לוג בגיטהב (בנוסף ללוג ב-KV, לא משנה אותו) ----------
// כל אירוע נשמר כקובץ נפרד בתיקיית logs בענף נפרד (ברירת מחדל: logs).
// דורש: GITHUB_REPO ב-wrangler.toml, ו-GITHUB_TOKEN כ-secret.

function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function githubRequest(env, method, path, body) {
    return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'trivia-ivr-worker',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function ensureLogBranch(env, branch) {
    const base = env.GITHUB_BASE_BRANCH || 'main';
    const ref = await githubRequest(env, 'GET', `/git/ref/heads/${base}`);
    if (!ref.ok) return;
    const data = await ref.json();
    await githubRequest(env, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: data.object.sha });
}

async function writeGithubLog(env, event) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
    try {
        const branch = env.GITHUB_LOG_BRANCH || 'logs';
        const stamp = event.time.replace(/[:.]/g, '-');
        const rand = Math.random().toString(36).slice(2, 6);
        const path = `logs/${stamp}_${event.id || 'unknown'}_${rand}.json`;
        const body = {
            message: `log ${event.type} ${event.id || ''}`.trim(),
            content: toBase64(JSON.stringify(event, null, 2)),
            branch,
        };
        let branchChecked = false;
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await githubRequest(env, 'PUT', `/contents/${path}`, body);
            if (res.ok) return;
            if ((res.status === 404 || res.status === 422) && !branchChecked) {
                branchChecked = true;
                await ensureLogBranch(env, branch);
                continue;
            }
            if (res.status === 409) {
                await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
                continue;
            }
            return;
        }
    } catch (e) {
        // תקלה בלוג גיטהב אף פעם לא מפילה את השיחה
    }
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
        .replace(/[\r\n]+/g, ' ')
        .replace(/=/g, ' שווה ')
        .replace(/&/g, ' וגם ')
        .replace(/,/g, ' ')
        .replace(/\./g, ' ')
        .replace(/-/g, ' ')
        .replace(/["']/g, '')
        .trim();
}

function buildMessage(text) {
    const parts = String(text).split(/\[M?(\d+)\]/i);
    const out = [];
    parts.forEach((part, i) => {
        if (i % 2 === 1) {
            out.push(`m-${part}`);
        } else {
            const t = sanitizeTTS(part);
            if (t) out.push(`t-${t}`);
        }
    });
    return out.join('.');
}

function buildRead(name, ttsMessage, { max, min, sayAs = 'NO', allowedDigits = '', wait = 7, reEnter = false }) {
    const params = [
        name, reEnter ? 'yes' : '', String(max), String(min), String(wait), sayAs, '', '', '',
        allowedDigits, '1', 'Ok', 'timeout', '', 'no',
    ].join(',');
    return `read=${buildMessage(ttsMessage)}=${params}`;
}

function sysMsg(n) {
    return `[M${n}]`;
}

function randomBetween([from, to]) {
    return from + Math.floor(Math.random() * (to - from + 1));
}

function questionAnswers(question) {
    return Array.isArray(question.answers) ? question.answers.slice(0, MSG.ANSWER_NUMBERS.length) : [];
}

function questionKeys(question) {
    if (question.validKeys) return question.validKeys;
    return questionAnswers(question).map((_, i) => String(i + 1)).join('');
}

function buildQuestionText(question) {
    const parts = [sysMsg(MSG.QUESTION_IS), question.text];
    const answers = questionAnswers(question);
    if (answers.length) {
        parts.push(sysMsg(MSG.PRESS_CORRECT));
        answers.forEach((a, i) => parts.push(sysMsg(MSG.ANSWER_NUMBERS[i]), a));
    }
    parts.push(sysMsg(MSG.TICK));
    return parts.join(' ');
}

function buildFinish(answers, total, G, points, questions) {
    const correctCount = answers.filter((a) => a.correct).length;
    const allCorrect = correctCount === total;
    const success = total > 0 && (correctCount / total) * 100 >= (Number(G.successMinPercent) || 0);
    const last = answers[answers.length - 1];
    const parts = [];
    if (last) {
        const q = questions[last.qNumber];
        const E = eff(G, q);
        if (!E.dontSayOutcome) parts.push(sysMsg(last.correct ? MSG.CORRECT : MSG.WRONG));
        if (!last.correct && E.revealAnswer) parts.push(sysMsg(MSG.REVEAL), (q.answers || [])[Number(q.correct) - 1] || '');
    }
    if (!G.dontSayEndGame) {
        parts.push(sysMsg(MSG.FINISHED));
        if (G.specialAnswer) parts.push(sysMsg(randomBetween(success ? MSG.SUCCESS_RANGE : MSG.FAIL_RANGE)));
        parts.push(sysMsg(allCorrect ? MSG.ALL_CORRECT : MSG.NOT_ALL_CORRECT));
        parts.push(`ענית נכון על ${correctCount} מתוך ${total} שאלות`);
    }
    if (G.finishDoublePoints) parts.push(sysMsg(MSG.DOUBLE), String(points));
    else if (G.sayTotal) parts.push(sysMsg(MSG.TOTAL_END), String(points));
    return `id_list_message=${buildMessage(parts.join(' '))}&go_to_folder=..`;
}

function plainTextResponse(body) {
    return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleYemot(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    // ימות המשיח שולחת בקשה נוספת כשהשיחה מתנתקת - רק רושמים בלוג, בלי לעבד תשובות
    if (params.get('hangup') === 'yes') {
        const hangupId = (params.get('id') || '').replace(/\D/g, '');
        if (hangupId) {
            ctx.waitUntil(writeGithubLog(env, { time: new Date().toISOString(), type: 'hangup', id: hangupId }));
        }
        return plainTextResponse('');
    }

    const config = await loadConfig(env);
    const id = params.get('id');
    const G = { ...DEFAULT_SETTINGS, ...(config.settings || {}) };

    if (!id) {
        return plainTextResponse(
            buildRead('id', (G.welcome === 'quiet' ? '' : sysMsg(MSG.WELCOME)) + sysMsg(MSG.ASK_ID),
                { max: 9, min: 8, sayAs: 'TeudatZehut' })
        );
    }

    const cleanId = id.replace(/\D/g, '');
    const participant = config.participants.find((p) => p.id === cleanId);
    if (!participant) {
        ctx.waitUntil(writeGithubLog(env, { time: new Date().toISOString(), type: 'unknown_id', id: cleanId }));
        return plainTextResponse(
            `id_list_message=${buildMessage('מספר תעודת הזהות שהוקש אינו מזוהה במערכת להתראות')}&go_to_folder=..`
        );
    }

    const order = playOrder(G, config.questions.length, cleanId);
    const total = order.length;
    const answers = [];
    let timedOut = false, pending = null, points = 0;
    for (let pos = 0; pos < total && !pending; pos++) {
        const q = config.questions[order[pos]];
        const E = eff(G, q);
        let done = false;
        for (let t = 0; t < 2 && !done; t++) {
            const all = params.getAll(t ? `ans_${pos}_2` : `ans_${pos}`);
            const given = all[all.length - 1];
            if (given === undefined || given === 'timeout') {
                timedOut = given === 'timeout';
                pending = { pos, t };
                break;
            }
            const ok = given === q.correct;
            if (ok || t === 1 || E.onlyOnce) {
                const pts = ok ? Number(t === 0 ? E.points1 : E.points2) || 0 : 0;
                points += pts;
                answers.push({ questionIndex: pos, qNumber: order[pos], questionText: q.text, answerGiven: given, correct: ok, attempt: t + 1, points: pts });
                done = true;
            }
        }
    }
    if (!pending && G.finishDoublePoints) points *= 2;

    await env.TRIVIA_KV.put(
        cleanId,
        JSON.stringify({
            id: cleanId,
            lastName: participant.lastName,
            firstName: participant.firstName,
            class: participant.class,
            institution: participant.institution,
            lastUpdated: new Date().toISOString(),
            points,
            answers,
        })
    );

    ctx.waitUntil(writeGithubLog(env, {
        time: new Date().toISOString(),
        type: timedOut ? 'timeout' : answers.length === 0 ? 'login' : pending ? 'progress' : 'finished',
        id: cleanId,
        lastName: participant.lastName,
        firstName: participant.firstName,
        class: participant.class,
        institution: participant.institution,
        answers,
        points,
        correctCount: answers.filter((a) => a.correct).length,
        totalQuestions: total,
    }));

    if (pending) {
        const q = config.questions[order[pending.pos]];
        const E = eff(G, q);
        const pre = [];
        if (timedOut) pre.push(sysMsg(MSG.RETRY));
        else if (pending.t === 1) {
            if (!E.dontSayOutcome) pre.push(sysMsg(MSG.WRONG));
            pre.push(sysMsg(MSG.RETRY));
        } else if (pending.pos > 0) {
            const last = answers[pending.pos - 1];
            const pq = config.questions[last.qNumber];
            const PE = eff(G, pq);
            if (!PE.dontSayOutcome) pre.push(sysMsg(last.correct ? MSG.CORRECT : MSG.WRONG));
            if (!last.correct && PE.revealAnswer) pre.push(sysMsg(MSG.REVEAL), (pq.answers || [])[Number(pq.correct) - 1] || '');
            if (G.sayTotal) pre.push(sysMsg(MSG.TOTAL_NOW), String(points));
            pre.push(sysMsg(MSG.NEXT_QUESTION));
        }
        return plainTextResponse(
            buildRead(pending.t ? `ans_${pending.pos}_2` : `ans_${pending.pos}`, pre.concat(buildQuestionText(q)).join(' '), {
                max: 1,
                min: 1,
                allowedDigits: questionKeys(q),
                wait: Number(E.waitSeconds) || QUESTION_WAIT_SECONDS,
                reEnter: timedOut,
            })
        );
    }

    return plainTextResponse(buildFinish(answers, total, G, points, config.questions));
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
    if (!Array.isArray(body.participants) || !Array.isArray(body.questions)) {
        return jsonResponse({ error: 'invalid structure' }, 400);
    }
    await saveConfig(env, { participants: body.participants, questions: body.questions });
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: #f4f5f7; margin: 0; padding: 20px; color: #1a1a1a; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #666; margin-bottom: 20px; font-size: 14px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { padding: 10px 18px; background: #fff; border-radius: 10px; cursor: pointer; border: 2px solid transparent; font-weight: 600; }
  .tab.active { border-color: #4f46e5; color: #4f46e5; }
  .panel { display: none; }
  .panel.active { display: block; }
  .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  input[type=text], textarea, select { padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
  textarea { resize: vertical; min-height: 50px; width: 100%; }
  .small { width: 70px; flex: none; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 600; font-size: 14px; }
  .btn-primary { background: #4f46e5; color: #fff; }
  .btn-danger { background: #fee2e2; color: #b91c1c; }
  .btn-secondary { background: #eee; color: #333; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; font-size: 13px; }
  th, td { padding: 8px; text-align: right; border-bottom: 1px solid #eee; }
  th { background: #f0f0f0; }
  .correct { color: #15803d; font-weight: 700; }
  .wrong { color: #b91c1c; font-weight: 700; }
  .toast { position: fixed; bottom: 20px; left: 20px; background: #1a1a1a; color: #fff; padding: 12px 20px; border-radius: 10px; display: none; z-index: 999; }
  .qlabel { font-size: 12px; color: #888; margin-bottom: 2px; }
  .p-input { flex: 1; min-width: 90px; }
  .link-btn { background: none; color: #4f46e5; padding: 2px; font-weight: 600; text-decoration: underline; }
  table-wrap { overflow-x: auto; }
</style>
</head>
<body>

<h1>ניהול טריוויה</h1>
<div class="sub">כל שינוי שנשמר כאן נכנס לתוקף מיד בשיחה הבאה</div>

<div class="tabs">
  <div class="tab active" data-tab="participants">משתתפים</div>
  <div class="tab" data-tab="questions">שאלות</div>
  <div class="tab" data-tab="results">תוצאות וייצוא</div>
</div>

<div id="panel-participants" class="panel active">
  <div class="toolbar">
    <button class="btn-primary" onclick="addParticipant()">+ משתתף חדש</button>
    <button class="btn-secondary" onclick="saveConfig()">שמור שינויים</button>
    <button class="btn-secondary" onclick="downloadTemplate()">הורד קובץ אקסל לדוגמה</button>
    <label class="btn-secondary" style="display:inline-block">
      ייבוא מאקסל (מחליף את כל הרשימה)
      <input type="file" accept=".xlsx,.xls" onchange="handleFileUpload(event)" style="display:none">
    </label>
  </div>
  <div id="participants-list"></div>
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
    <select id="institution-filter" onchange="renderResultsTable()">
      <option value="">כל המוסדות</option>
    </select>
    <button class="btn-primary" onclick="exportResults()">ייצוא לאקסל</button>
  </div>
  <div class="table-wrap">
  <table id="results-table">
    <thead><tr><th>ת"ז</th><th>שם משפחה</th><th>שם פרטי</th><th>כיתה</th><th>מוסד</th><th>ציון</th><th>עודכן</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const SECRET = ${JSON.stringify(secret)};
let config = { participants: [], questions: [] };
let resultsData = [];

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
  setTimeout(() => t.style.display = 'none', 3000);
}

async function loadConfigFromServer() {
  const res = await fetch('/admin/api/config?secret=' + encodeURIComponent(SECRET));
  config = await res.json();
  renderParticipants();
  renderQuestions();
}

// ---------- משתתפים ----------

function renderParticipants() {
  const el = document.getElementById('participants-list');
  el.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'row';
  header.style.fontWeight = '700';
  header.innerHTML = '<div class="p-input">ת"ז</div><div class="p-input">שם משפחה</div><div class="p-input">שם פרטי</div><div class="p-input">כיתה</div><div class="p-input">מוסד</div><div style="width:60px"></div>';
  el.appendChild(header);
  config.participants.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'row card';
    row.innerHTML = \`
      <input class="p-input" type="text" value="\${p.id || ''}" maxlength="9" oninput="config.participants[\${i}].id = this.value.replace(/\\\\D/g,'')">
      <input class="p-input" type="text" value="\${p.lastName || ''}" oninput="config.participants[\${i}].lastName = this.value">
      <input class="p-input" type="text" value="\${p.firstName || ''}" oninput="config.participants[\${i}].firstName = this.value">
      <input class="p-input" type="text" value="\${p.class || ''}" oninput="config.participants[\${i}].class = this.value">
      <input class="p-input" type="text" value="\${p.institution || ''}" oninput="config.participants[\${i}].institution = this.value">
      <button class="btn-danger" onclick="removeParticipant(\${i})">מחק</button>
    \`;
    el.appendChild(row);
  });
}

function addParticipant() {
  config.participants.push({ id: '', lastName: '', firstName: '', class: '', institution: '' });
  renderParticipants();
}
function removeParticipant(i) { config.participants.splice(i, 1); renderParticipants(); }

function downloadTemplate() {
  const wsData = [
    ['ת.ז.', 'שם משפחה', 'שם פרטי', 'כיתה', 'מוסד'],
    ['123456789', 'ישראלי', 'ישראל', "א'", 'בית ספר לדוגמה'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'משתתפים');
  XLSX.writeFile(wb, 'תבנית_משתתפים.xlsx');
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const newParticipants = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row[0] === undefined || row[0] === '') continue;
      newParticipants.push({
        id: String(row[0]).replace(/\\D/g, ''),
        lastName: row[1] !== undefined ? String(row[1]) : '',
        firstName: row[2] !== undefined ? String(row[2]) : '',
        class: row[3] !== undefined ? String(row[3]) : '',
        institution: row[4] !== undefined ? String(row[4]) : '',
      });
    }
    config.participants = newParticipants;
    renderParticipants();
    showToast('יובאו ' + newParticipants.length + ' משתתפים - לא לשכוח ללחוץ שמור שינויים');
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

// ---------- שאלות ----------

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

// ---------- תוצאות ----------

async function loadResults() {
  const res = await fetch('/admin/api/results?secret=' + encodeURIComponent(SECRET));
  const data = await res.json();
  resultsData = Object.values(data);

  const select = document.getElementById('institution-filter');
  const current = select.value;
  const institutions = [...new Set(resultsData.map(r => r.institution).filter(Boolean))].sort();
  select.innerHTML = '<option value="">כל המוסדות</option>' +
    institutions.map(inst => \`<option value="\${inst}">\${inst}</option>\`).join('');
  select.value = current;

  renderResultsTable();
}

function filteredSortedResults() {
  const filter = document.getElementById('institution-filter').value;
  let rows = resultsData;
  if (filter) rows = rows.filter(r => r.institution === filter);
  rows = rows.slice().sort((a, b) => {
    const c = (a.class || '').localeCompare(b.class || '', 'he');
    if (c !== 0) return c;
    return (a.lastName || '').localeCompare(b.lastName || '', 'he');
  });
  return rows;
}

function renderResultsTable() {
  const tbody = document.querySelector('#results-table tbody');
  tbody.innerHTML = '';
  filteredSortedResults().forEach(entry => {
    const correctCount = (entry.answers || []).filter(a => a.correct).length;
    const total = (entry.answers || []).length;
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${entry.id}</td>
      <td>\${entry.lastName || ''}</td>
      <td>\${entry.firstName || ''}</td>
      <td>\${entry.class || ''}</td>
      <td>\${entry.institution || ''}</td>
      <td>\${correctCount} / \${total}</td>
      <td>\${entry.lastUpdated ? new Date(entry.lastUpdated).toLocaleString('he-IL') : ''}</td>
      <td><button class="link-btn" onclick='showDetails(\${JSON.stringify(entry).replace(/'/g, "&apos;")})'>פרטים</button></td>
    \`;
    tbody.appendChild(tr);
  });
}

function showDetails(entry) {
  const lines = (entry.answers || []).map((a, i) =>
    'שאלה ' + (i + 1) + ': הוקש ' + a.answerGiven + ' - ' + (a.correct ? 'נכון' : 'לא נכון')
  );
  alert((entry.firstName || '') + ' ' + (entry.lastName || '') + '\\n' + lines.join('\\n'));
}

function exportResults() {
  const qCount = config.questions.length;
  const header = ['ת.ז.', 'שם משפחה', 'שם פרטי', 'כיתה', 'מוסד', 'ציון'];
  for (let i = 0; i < qCount; i++) {
    header.push('שאלה ' + (i + 1) + ' - תשובה', 'שאלה ' + (i + 1) + ' - נכון');
  }
  const rows = [header];
  filteredSortedResults().forEach(entry => {
    const correctCount = (entry.answers || []).filter(a => a.correct).length;
    const total = (entry.answers || []).length;
    const row = [entry.id, entry.lastName || '', entry.firstName || '', entry.class || '', entry.institution || '', correctCount + '/' + total];
    for (let i = 0; i < qCount; i++) {
      const a = (entry.answers || []).find(x => x.questionIndex === i);
      row.push(a ? a.answerGiven : '', a ? (a.correct ? 'כן' : 'לא') : '');
    }
    rows.push(row);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'תוצאות');
  XLSX.writeFile(wb, 'תוצאות_טריוויה.xlsx');
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
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/version') {
            const cfg = await loadConfig(env);
            return plainTextResponse(
                `גרסה ${VERSION} | שאלות: ${cfg.questions.length} | משתתפים: ${cfg.participants.length} | רשימות מהקוד: ${USE_CODE_LISTS ? 'כן' : 'לא'}`
            );
        }
        if (url.pathname === '/admin') return handleAdminPage(request);
        if (url.pathname === '/admin/api/config' && request.method === 'GET') return handleAdminGetConfig(request, env);
        if (url.pathname === '/admin/api/config' && request.method === 'POST') return handleAdminSaveConfig(request, env);
        if (url.pathname === '/admin/api/results') return handleAdminResults(request, env);
        if (url.pathname === '/results') return handleAdminResults(request, env); // תאימות לאחור

        const response = await handleYemot(request, env, ctx);
        ctx.waitUntil((async () => {
            await writeGithubLog(env, {
                time: new Date().toISOString(),
                type: 'debug',
                id: (url.searchParams.get('id') || '').replace(/\D/g, ''),
                query: url.search,
                response: await response.clone().text(),
            });
        })());
        return response;
    },
};

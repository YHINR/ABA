/**
 * טריוויה טלפונית - ימות המשיח + Cloudflare Workers
 * ================================================
 * בנוי לפי התיעוד הרשמי של מודול ה-API בימות המשיח.
 *
 * מה שאתה צריך לערוך: 3 המקומות המסומנים למטה (ALLOWED_IDS, QUESTIONS, ADMIN_SECRET).
 * שום דבר אחר לא צריך לגעת בו.
 *
 * הגדרה חד-פעמית ב-wrangler.toml:
 *   npx wrangler kv namespace create TRIVIA_KV
 *   (להעתיק את ה-id שיוחזר לתוך wrangler.toml)
 *
 * צפייה בתוצאות (מי ענה מה):
 *   https://<your-worker>.workers.dev/results?secret=<ADMIN_SECRET>
 */

// ============ 1. לערוך: רשימת ת"ז מאושרות ============
const ALLOWED_IDS = [
    '123456789',
    '987654321',
];

// ============ 2. לערוך: השאלות ============
const QUESTIONS = [
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

// ============ 3. לערוך: סוד לצפייה בתוצאות ============
const ADMIN_SECRET = 'CHANGE_ME_TO_SOMETHING_SECRET';

// ============ מכאן ולמטה - קוד המערכת, אין צורך לערוך ============

// לפי התיעוד: בטקסט מסוג t- (TTS) אסור להשתמש בתווים נקודה ומקף.
// גם פסיק, & ו-= שוברים את מבנה התשובה לימות, לכן מוסרים גם אותם.
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

/**
 * בונה פקודת read לפי 15 הפרמטרים המדויקים מהתיעוד הרשמי (בסדר הזה בדיוק):
 *  1. name          - שם הפרמטר שיישלח בבקשה הבאה
 *  2. useExisting   - yes/no - להשתמש בערך קיים אם כבר הוזן
 *  3. max           - מקסימום ספרות
 *  4. min           - מינימום ספרות
 *  5. wait          - שניות המתנה להקשה
 *  6. sayAs         - איך להשמיע את מה שהוקש חזרה (NO / Number / Digits / TeudatZehut ...)
 *  7. blockAsterisk - yes/no - לחסום מקש כוכבית
 *  8. blockZero     - yes/no - לחסום כמות אפס
 *  9. replaceChar   - החלפת תו
 * 10. allowedDigits - אילו ספרות מותר להקיש (ריק = הכל מותר)
 * 11. retryCount    - כמות ניסיונות לפני שנחשב "ריק"
 * 12. ifEmptyOk     - Ok = להמשיך גם אם אין תשובה
 * 13. emptyValue    - הערך שיישלח אם אין תשובה
 * 14. keyboardLock  - נעילת שינוי שפת מקלדת
 * 15. askConfirm    - no = לא לבקש אישור על ההקשה
 */
function buildRead(name, ttsMessage, { max, min, sayAs = 'NO', allowedDigits = '' }) {
    const params = [
        name,
        '',
        String(max),
        String(min),
        '7',
        sayAs,
        '',
        '',
        '',
        allowedDigits,
        '1',
        'Ok',
        'timeout',
        '',
        'no',
    ].join(',');
    return `read=t-${sanitizeTTS(ttsMessage)}=${params}`;
}

function plainTextResponse(body) {
    return new Response(body, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

async function handleResults(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
    }
    const list = await env.TRIVIA_KV.list();
    const results = {};
    for (const key of list.keys) {
        const value = await env.TRIVIA_KV.get(key.name);
        try {
            results[key.name] = JSON.parse(value);
        } catch (e) {
            results[key.name] = value;
        }
    }
    return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/results') {
            return handleResults(request, env);
        }

        const params = url.searchParams;
        const id = params.get('id');

        // שלב 1: אין עדיין ת"ז - מבקשים להקיש.
        // sayAs=TeudatZehut גורם לימות לבדוק שזה מספר ת"ז תקין מבחינה מתמטית
        // (זה לא בודק שהוא ברשימה שלנו - זה נבדק בשלב הבא).
        if (!id) {
            return plainTextResponse(
                buildRead(
                    'id',
                    'ברוכים הבאים לטריוויה הטלפונית אנא הקישו את מספר תעודת הזהות שלכם ולאחר מכן הקישו סולמית',
                    { max: 9, min: 8, sayAs: 'TeudatZehut' }
                )
            );
        }

        // שלב 2: יש ת"ז - בודקים מול הרשימה המאושרת
        const cleanId = id.replace(/\D/g, '');
        if (!ALLOWED_IDS.includes(cleanId)) {
            return plainTextResponse(
                `id_list_message=t-מספר תעודת הזהות שהוקש אינו מזוהה במערכת להתראות&go_to_folder=..`
            );
        }

        // שלב 3: ת"ז מאושרת - כמה שאלות כבר נענו (לפי ans_0, ans_1...)
        const answers = [];
        for (let i = 0; i < QUESTIONS.length; i++) {
            const given = params.get(`ans_${i}`);
            if (given === null) break;
            const question = QUESTIONS[i];
            answers.push({
                questionIndex: i,
                questionText: question.text,
                answerGiven: given,
                correct: given === question.correct,
            });
        }

        // שומרים/מעדכנים את הרשומה של המשתמש הזה (מחליף בכל פעם, אין כפילויות)
        await env.TRIVIA_KV.put(
            cleanId,
            JSON.stringify({
                id: cleanId,
                lastUpdated: new Date().toISOString(),
                answers,
            })
        );

        const answeredCount = answers.length;

        // שלב 4: אם נשארו שאלות - שואלים את הבאה
        // חשוב: כל שאלה מקבלת שם פרמטר שונה (ans_0, ans_1...) - לפי התיעוד
        // אסור להשתמש פעמיים באותו שם פרמטר ב-read.
        if (answeredCount < QUESTIONS.length) {
            const nextQuestion = QUESTIONS[answeredCount];
            return plainTextResponse(
                buildRead(`ans_${answeredCount}`, nextQuestion.text, {
                    max: 1,
                    min: 1,
                    allowedDigits: nextQuestion.validKeys,
                })
            );
        }

        // שלב 5: כל השאלות נענו - מסכמים ומנתקים
        const correctCount = answers.filter((a) => a.correct).length;
        return plainTextResponse(
            `id_list_message=t-סיימתם את הטריוויה ענית נכון על ${correctCount} מתוך ${QUESTIONS.length} שאלות תודה ולהתראות&go_to_folder=..`
        );
    },
};

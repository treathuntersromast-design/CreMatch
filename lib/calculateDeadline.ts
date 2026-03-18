/**
 * lib/calculateDeadline.ts
 *
 * 納期自動計算エンジン
 * - 土日スキップ
 * - 日本祝日スキップ（Google Calendar「日本の祝日」から取得）
 * - クリエイターの対応曜日スキップ（プロフィール設定）
 * - Google Calendar の不在イベントをスキップ
 * - 上記すべてをクリアした稼働日を n 日分カウントして納品日を確定
 */

export interface CreatorSchedule {
  /** 対応可能な曜日（0=日, 1=月, ..., 6=土） */
  workDays: number[];
  /** 1案件の標準作業日数 */
  defaultWorkingDays: number;
}

export interface DeadlineResult {
  /** 確定した納品日 */
  deadline: Date;
  /** 計算に使った稼働日一覧 */
  workingDays: Date[];
  /** スキップされた日とその理由 */
  skippedDays: { date: Date; reason: 'weekend' | 'holiday' | 'calendar_event' | 'off_day' }[];
  /** カレンダーに登録するイベント情報 */
  calendarEvents: CalendarEventPayload[];
}

export interface CalendarEventPayload {
  summary: string;
  description: string;
  start: { date: string };
  end: { date: string };
  colorId?: string;
}

export interface GoogleCalendarEvent {
  summary?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  transparency?: string; // "transparent" = 予定あり（空き時間に影響しない）
  status?: string;       // "cancelled" は除外
}

// ─────────────────────────────────────────────
// 1. 祝日判定
// ─────────────────────────────────────────────

/**
 * Google Calendar API から「日本の祝日」を取得する
 * calendarId: 'ja.japanese#holiday@group.v.calendar.google.com'
 */
export async function fetchJapaneseHolidays(
  accessToken: string,
  from: Date,
  to: Date
): Promise<Set<string>> {
  const timeMin = from.toISOString();
  const timeMax = to.toISOString();
  const calendarId = encodeURIComponent('ja.japanese#holiday@group.v.calendar.google.com');

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    console.warn('祝日カレンダー取得失敗 – 祝日スキップなしで続行');
    return new Set();
  }

  const data = await res.json();
  const holidays = new Set<string>();
  for (const event of data.items ?? []) {
    const d = event.start?.date; // "2025-01-01" 形式
    if (d) holidays.add(d);
  }
  return holidays;
}

// ─────────────────────────────────────────────
// 2. クリエイターのカレンダーから不在イベント取得
// ─────────────────────────────────────────────

/**
 * クリエイター本人のカレンダーから「終日不在」または
 * 「ステータス = 不在（OOO）」のイベントを取得して日付セットを返す
 */
export async function fetchBusyDays(
  accessToken: string,
  from: Date,
  to: Date
): Promise<Set<string>> {
  const timeMin = from.toISOString();
  const timeMax = to.toISOString();

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=250`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) throw new Error('カレンダー取得エラー: ' + res.status);

  const data = await res.json();
  const busyDays = new Set<string>();

  for (const event of (data.items ?? []) as GoogleCalendarEvent[]) {
    if (event.status === 'cancelled') continue;
    // transparency = 'transparent' は「予定あり」でもカレンダー上は空き扱い → スキップしない
    if (event.transparency === 'transparent') continue;

    // 終日イベント（date 形式）のみ「不在」として扱う
    // 時刻付きイベントは作業の合間に対応できるためスキップ対象外
    const startDate = event.start?.date;
    if (!startDate) continue;

    // サマリーに「不在」「出張」「休暇」「OOO」「vacation」等が含まれる場合のみ対象
    const summary = (event.summary ?? '').toLowerCase();
    const isAbsence =
      summary.includes('不在') ||
      summary.includes('出張') ||
      summary.includes('休暇') ||
      summary.includes('休み') ||
      summary.includes('ooo') ||
      summary.includes('vacation') ||
      summary.includes('absent') ||
      summary.includes('holiday');

    if (isAbsence) {
      // 終日イベントは start.date〜end.date（end は翌日）の範囲をすべて追加
      const s = new Date(startDate);
      const e = event.end?.date ? new Date(event.end.date) : new Date(startDate);
      for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) {
        busyDays.add(toDateString(new Date(d)));
      }
    }
  }

  return busyDays;
}

// ─────────────────────────────────────────────
// 3. メイン: 納期計算
// ─────────────────────────────────────────────

export async function calculateDeadline(
  accessToken: string,
  requestDate: Date,        // 依頼日
  workingDaysRequired: number, // 必要作業日数
  creatorSchedule: CreatorSchedule
): Promise<DeadlineResult> {

  // 検索範囲を넉넉하게 3ヶ月に設定（極端に長い案件でも対応）
  const searchEnd = new Date(requestDate);
  searchEnd.setMonth(searchEnd.getMonth() + 3);

  // 祝日・不在日を並列取得
  const [holidays, busyDays] = await Promise.all([
    fetchJapaneseHolidays(accessToken, requestDate, searchEnd),
    fetchBusyDays(accessToken, requestDate, searchEnd),
  ]);

  const workingDays: Date[] = [];
  const skippedDays: DeadlineResult['skippedDays'] = [];

  // 依頼日の翌日から1日ずつチェック
  const cursor = new Date(requestDate);
  cursor.setDate(cursor.getDate() + 1);

  while (workingDays.length < workingDaysRequired) {
    const dateStr = toDateString(cursor);
    const dow = cursor.getDay(); // 0=日, 6=土

    if (dow === 0 || dow === 6) {
      skippedDays.push({ date: new Date(cursor), reason: 'weekend' });
    } else if (holidays.has(dateStr)) {
      skippedDays.push({ date: new Date(cursor), reason: 'holiday' });
    } else if (!creatorSchedule.workDays.includes(dow)) {
      skippedDays.push({ date: new Date(cursor), reason: 'off_day' });
    } else if (busyDays.has(dateStr)) {
      skippedDays.push({ date: new Date(cursor), reason: 'calendar_event' });
    } else {
      workingDays.push(new Date(cursor));
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  const deadline = workingDays[workingDays.length - 1];

  // カレンダー登録用イベント生成
  const calendarEvents = buildCalendarEvents(requestDate, workingDays, deadline);

  return { deadline, workingDays, skippedDays, calendarEvents };
}

// ─────────────────────────────────────────────
// 4. カレンダーイベント生成
// ─────────────────────────────────────────────

function buildCalendarEvents(
  requestDate: Date,
  workingDays: Date[],
  deadline: Date
): CalendarEventPayload[] {
  const events: CalendarEventPayload[] = [];

  // 作業期間ブロック（最初の稼働日 〜 納品日の前日）
  if (workingDays.length > 1) {
    const blockEnd = new Date(deadline);
    blockEnd.setDate(blockEnd.getDate()); // end は翌日（Google Calendar の仕様）
    const blockEndStr = toDateString(new Date(blockEnd.getTime() + 86400000));

    events.push({
      summary: '📦 作業期間',
      description: `依頼日: ${toDateString(requestDate)}\n作業日数: ${workingDays.length}日`,
      start: { date: toDateString(workingDays[0]) },
      end: { date: blockEndStr },
      colorId: '7', // 孔雀色
    });
  }

  // 納品日イベント
  const deadlineNextDay = new Date(deadline);
  deadlineNextDay.setDate(deadlineNextDay.getDate() + 1);

  events.push({
    summary: '🚀 納品日',
    description: `依頼日: ${toDateString(requestDate)} から ${workingDays.length}営業日`,
    start: { date: toDateString(deadline) },
    end: { date: toDateString(deadlineNextDay) },
    colorId: '11', // 赤
  });

  return events;
}

// ─────────────────────────────────────────────
// 5. カレンダーへ書き込み
// ─────────────────────────────────────────────

export async function insertCalendarEvents(
  accessToken: string,
  events: CalendarEventPayload[]
): Promise<void> {
  for (const event of events) {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`イベント登録失敗: ${JSON.stringify(err)}`);
    }
  }
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

/** Date を "YYYY-MM-DD" 文字列に変換 */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * app/api/deadline/calculate/route.ts
 *
 * POST /api/deadline/calculate
 *
 * body: {
 *   creator_id: string
 *   request_date: string        // "2025-03-18"
 *   working_days_required: number // 10
 * }
 *
 * response: {
 *   deadline: string            // "2025-04-03"
 *   working_days: string[]      // ["2025-03-19", ...]
 *   skipped_days: { date, reason }[]
 *   calendar_events_registered: boolean
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  calculateDeadline,
  insertCalendarEvents,
  toDateString,
  type CreatorSchedule,
} from '@/lib/calculateDeadline';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── トークン取得 + 自動リフレッシュ ───────────────────────
async function getValidAccessToken(creatorId: string): Promise<string> {
  const { data, error } = await supabase
    .from('creator_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('creator_id', creatorId)
    .single();

  if (error || !data) throw new Error('トークン未設定。Googleカレンダーを連携してください。');

  const isExpired = new Date(data.expires_at) <= new Date(Date.now() + 60_000); // 1分前に更新

  if (!isExpired) return data.access_token;

  // リフレッシュ
  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!refreshRes.ok) throw new Error('トークンのリフレッシュに失敗しました');

  const { access_token, expires_in } = await refreshRes.json();
  const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  await supabase
    .from('creator_tokens')
    .update({ access_token, expires_at: newExpiresAt })
    .eq('creator_id', creatorId);

  return access_token;
}

// ─── プロフィールからスケジュール設定を取得 ────────────────
async function getCreatorSchedule(creatorId: string): Promise<CreatorSchedule> {
  const { data } = await supabase
    .from('creator_profiles')
    .select('schedule')
    .eq('creator_id', creatorId)
    .single();

  // schedule.days: ["月","火","水","木","金"] → 曜日番号に変換
  const dayMap: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
  const days: string[] = data?.schedule?.days ?? ['月', '火', '水', '木', '金'];
  const workDays = days.map((d) => dayMap[d]).filter((n) => n !== undefined);

  return {
    workDays: workDays.length ? workDays : [1, 2, 3, 4, 5], // デフォルト平日
    defaultWorkingDays: data?.schedule?.default_working_days ?? 10,
  };
}

// ─── ハンドラー ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { creator_id, request_date, working_days_required } = body;

    if (!creator_id || !request_date) {
      return NextResponse.json({ error: 'creator_id と request_date は必須です' }, { status: 400 });
    }

    const [accessToken, creatorSchedule] = await Promise.all([
      getValidAccessToken(creator_id),
      getCreatorSchedule(creator_id),
    ]);

    const requestDateObj = new Date(request_date + 'T00:00:00+09:00');
    const workDays = working_days_required ?? creatorSchedule.defaultWorkingDays;

    const result = await calculateDeadline(
      accessToken,
      requestDateObj,
      workDays,
      creatorSchedule
    );

    // カレンダーへ自動登録
    await insertCalendarEvents(accessToken, result.calendarEvents);

    return NextResponse.json({
      deadline: toDateString(result.deadline),
      working_days: result.workingDays.map(toDateString),
      skipped_days: result.skippedDays.map((s) => ({
        date: toDateString(s.date),
        reason: s.reason,
      })),
      calendar_events_registered: true,
      summary: buildSummary(result, request_date, workDays),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildSummary(
  result: Awaited<ReturnType<typeof calculateDeadline>>,
  requestDate: string,
  workDays: number
): string {
  const deadline = toDateString(result.deadline);
  const calendarBlocks = result.skippedDays.filter((s) => s.reason === 'calendar_event').length;
  const holidays = result.skippedDays.filter((s) => s.reason === 'holiday').length;

  let msg = `依頼日 ${requestDate} から ${workDays} 営業日で計算。`;
  msg += `納品予定日: ${deadline}。`;
  if (holidays > 0) msg += ` 祝日 ${holidays} 日をスキップ。`;
  if (calendarBlocks > 0) msg += ` Googleカレンダーの不在予定 ${calendarBlocks} 日をスキップ。`;

  return msg;
}

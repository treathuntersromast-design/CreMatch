/**
 * app/api/auth/google/route.ts
 *
 * Step 1: Google OAuth 認可URLにリダイレクト
 * GET /api/auth/google  → Google の同意画面へ
 */
import { NextResponse } from 'next/server';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',   // イベント読み書き
  'https://www.googleapis.com/auth/calendar.readonly',  // カレンダー一覧・祝日
].join(' ');

export function GET() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_REDIRECT_URI!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');   // refresh_token を取得
  url.searchParams.set('prompt', 'consent');

  return NextResponse.redirect(url.toString());
}

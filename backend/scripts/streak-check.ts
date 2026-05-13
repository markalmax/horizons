/**
 * Standalone streak inspector. Given a Slack user ID, looks up the user's
 * hackatime account, timezone, and linked Hackatime project names from
 * the database (READ-ONLY — only `findUnique` is used), then hits
 * Hackatime directly and reuses the production spans math
 * (`unionIntervals` → `bucketSpansByLocalDay`) plus the same 1h-qualify /
 * consecutive-day chain rules as StreakService.
 *
 * Usage (from backend/):
 *   bun scripts/streak-check.ts <slack-user-id> \
 *     [--days <n>] [--from <YYYY-MM-DD>]
 *
 * Required env (loaded from shell or .env via dotenv):
 *   DATABASE_URL          read-only connection string
 *   HACKATIME_API_KEY     for /heartbeats/spans
 *
 * Defaults: days=30 (or --from overrides). The script never issues writes.
 */
import 'dotenv/config';
import * as tls from 'node:tls';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  fetchSpans,
  localDateOf,
  secondsPerLocalDay,
} from '../src/streaks/spans';

const QUALIFY_SECONDS = 3600;
const DAY_MS = 86_400_000;

interface Args {
  slackUserId: string;
  days: number;
  fromYmd?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      flags[key] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 1) {
    throw new Error(
      'Usage: streak-check.ts <slack-user-id> [--days N] [--from YYYY-MM-DD]',
    );
  }
  return {
    slackUserId: positional[0],
    days: flags.days ? Number(flags.days) : 30,
    fromYmd: flags.from,
  };
}

function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const ts = Date.UTC(y, m - 1, d) + deltaDays * DAY_MS;
  const dt = new Date(ts);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function ymdToMs(ymd: string): number {
  return Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
  );
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.HACKATIME_API_KEY;
  if (!apiKey) {
    console.error('HACKATIME_API_KEY env var is required.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var is required (read-only URL expected).');
    process.exit(1);
  }

  // `sslrootcert=system` in the URL is the libpq shorthand for "use the
  // OS trust store"; pg-connection-string resolves it by passing the
  // literal string `'system'` as the TLS `ca` option. Node 22 understands
  // that, but Bun doesn't — it tries to fs.open('system') and throws
  // ENOENT. Strip the param from the URL and supply Node's bundled
  // Mozilla root CAs via tls.rootCertificates instead. `verify-full`
  // semantics (cert chain + hostname check) are preserved by
  // rejectUnauthorized: true plus the default checkServerIdentity.
  const rawUrl = process.env.DATABASE_URL ?? '';
  let dbUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.has('sslrootcert')) {
      u.searchParams.delete('sslrootcert');
      dbUrl = u.toString();
    }
  } catch {
    // malformed URL — let pg surface a clear error
  }
  const useSsl = /sslmode=(require|verify-ca|verify-full|prefer|allow)/i.test(
    rawUrl,
  );
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: useSsl
      ? {
          ca: tls.rootCertificates as unknown as string[],
          rejectUnauthorized: true,
        }
      : undefined,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    // READ-ONLY lookup: same selection shape as StreakService.syncUserStreak
    // so we filter projects with non-empty nowHackatimeProjects.
    const user = await prisma.user.findUnique({
      where: { slackUserId: args.slackUserId },
      select: {
        userId: true,
        slackUsername: true,
        hackatimeAccount: true,
        timezone: true,
        currentStreak: true,
        longestStreak: true,
        lastActiveDate: true,
        projects: {
          where: { nowHackatimeProjects: { isEmpty: false } },
          select: { nowHackatimeProjects: true },
        },
      },
    });

    if (!user) {
      console.error(`No user found with slackUserId=${args.slackUserId}`);
      process.exit(2);
    }
    if (!user.hackatimeAccount) {
      console.error(
        `User ${user.userId} (${user.slackUsername ?? '?'}) has no hackatimeAccount linked.`,
      );
      process.exit(2);
    }

    const linkedNames = dedupe(
      user.projects.flatMap((p) => p.nowHackatimeProjects ?? []),
    );
    if (linkedNames.length === 0) {
      console.error(
        `User ${user.userId} has no Hackatime projects linked to any Project row — streak math returns 0.`,
      );
      process.exit(2);
    }

    const tz = user.timezone ?? 'UTC';
    const tzSource = user.timezone ? 'db' : 'fallback:UTC';

    const todayLocal = localDateOf(Math.floor(Date.now() / 1000), tz);
    const fromYmd = args.fromYmd ?? shiftYmd(todayLocal, -(args.days - 1));

    console.log(
      `User: ${user.slackUsername ?? '?'} (userId=${user.userId}, slack=${args.slackUserId})`,
    );
    console.log(`Hackatime account: ${user.hackatimeAccount}`);
    console.log(`Timezone: ${tz} (${tzSource})`);
    console.log(`Linked Hackatime projects (${linkedNames.length}): ${linkedNames.join(', ')}`);
    console.log(`DB-stored streak: current=${user.currentStreak} longest=${user.longestStreak} lastActive=${user.lastActiveDate?.toISOString().slice(0, 10) ?? 'null'}`);
    console.log(`Window: ${fromYmd} → ${todayLocal}`);
    console.log('');

    // Overshoot UTC window by 1 day each side so spans straddling local
    // midnight are captured. bucketSpansByLocalDay attributes each second
    // to the right local day; out-of-window spans don't land in our
    // buckets.
    const spans = await fetchSpans({
      hackatimeAccount: user.hackatimeAccount,
      apiKey,
      startDateYmd: shiftYmd(fromYmd, -1),
      endDateYmd: shiftYmd(todayLocal, 1),
      projectNames: linkedNames,
      timeoutMs: 30_000,
    });

    if (spans.length === 0) {
      console.log('No spans returned (empty, network error, or unknown user).');
    }

    const buckets = secondsPerLocalDay(spans, tz);

    // Walk every day in [fromYmd, todayLocal] so zero-activity days appear
    // in the breakdown — that's where streaks break.
    const fromMs = ymdToMs(fromYmd);
    const toMs = ymdToMs(todayLocal);
    const rows: Array<{ ymd: string; seconds: number; qualified: boolean }> =
      [];
    for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
      const d = new Date(ms);
      const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const seconds = Math.floor(buckets.get(ymd) ?? 0);
      rows.push({ ymd, seconds, qualified: seconds >= QUALIFY_SECONDS });
    }

    // Streak walk: mirrors recomputeStreakFromHistory. Iterate qualified
    // days chronologically; consecutive days extend the run, gaps reset.
    // Trailing run is the current streak (decayed if lastQualified <
    // yesterday-in-tz).
    let longest = 0;
    let run = 0;
    let prevMs: number | null = null;
    let lastQualifiedYmd: string | null = null;
    for (const r of rows) {
      if (!r.qualified) continue;
      const ms = ymdToMs(r.ymd);
      if (prevMs === null || ms !== prevMs + DAY_MS) run = 1;
      else run += 1;
      if (run > longest) longest = run;
      prevMs = ms;
      lastQualifiedYmd = r.ymd;
    }

    const yesterdayLocal = shiftYmd(todayLocal, -1);
    const currentStreak =
      lastQualifiedYmd && lastQualifiedYmd >= yesterdayLocal ? run : 0;

    console.log('Date         Seconds   Duration       Qualified');
    console.log('────────────────────────────────────────────────');
    for (const r of rows) {
      const tag = r.qualified ? '✓' : r.seconds > 0 ? '·' : ' ';
      console.log(
        `${r.ymd}   ${String(r.seconds).padStart(7)}   ${fmtDuration(r.seconds).padEnd(12)}   ${tag}`,
      );
    }

    console.log('');
    console.log(`Qualifying threshold: ${QUALIFY_SECONDS}s (1h) per local day`);
    console.log(`Total raw spans returned: ${spans.length}`);
    console.log(`Qualified days in window: ${rows.filter((r) => r.qualified).length}`);
    console.log(`Computed current streak: ${currentStreak}`);
    console.log(`Computed longest streak (in window): ${longest}`);
    if (lastQualifiedYmd) {
      console.log(`Last qualified day: ${lastQualifiedYmd}`);
      if (currentStreak === 0) {
        console.log(
          `  (streak decayed: last qualified < ${yesterdayLocal}, today=${todayLocal})`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

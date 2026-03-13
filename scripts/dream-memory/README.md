# Dream Memory Runner (v0 skeleton)

이 디렉터리는 Dream Memory System v0의 **실행 가능한 첫 뼈대**입니다.

현재 포함 범위:
- 전날(KST 기준) 세션 파일 탐색
- `.jsonl` 세션 로그 파싱
- explainable project hint detection (Phase 1)
- 기초 importance scoring
- candidate extraction
- promotion / retention 후보 판단
- `tmp/dream-memory/YYYY-MM-DD.report.json` 리포트 출력
- `memory/` 폴더 bootstrap
- **옵션으로 Supabase raw/archive 분석 결과 insert/upsert**
  - `dream_jobs`
  - `dream_sessions`
  - `dream_messages`
  - `dream_memory_candidates`
  - `dream_promotions`
- **옵션으로 markdown promotion write**
  - `--promote=true`
  - snapshot backup 후 append
- **옵션으로 purge dry-run 계획 생성**
  - `--purge=true`
  - 실제 삭제 없이 retention 기반 정리 후보만 계산

추가 문서:
- `scripts/dream-memory/ENV_BRIDGE.md` — `03_supabase` env를 dream-memory env로 연결하는 방법
- `03_supabase/dev/dream_memory.sql` — archive/candidate/promotion persistence용 스키마 초안

아직 미포함:
- purge 실행

## Run

```bash
node scripts/dream-memory/nightly.mjs --date yesterday --dry-run
```

실제 리포트를 파일로 남기려면:

```bash
node scripts/dream-memory/nightly.mjs --date 2026-03-12 --dry-run=false
```

Supabase raw archive까지 같이 넣으려면:

```bash
DREAM_SUPABASE_URL=... \
DREAM_SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/dream-memory/nightly.mjs --date 2026-03-12 --dry-run=false --archive=true
```

markdown promotion까지 실제로 쓰려면:

```bash
node scripts/dream-memory/nightly.mjs --date 2026-03-12 --dry-run=false --promote=true
```

archive + promote + purge plan까지 같이 보려면:

```bash
DREAM_SUPABASE_URL=... \
DREAM_SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/dream-memory/nightly.mjs --date 2026-03-12 --dry-run=false --archive=true --promote=true --purge=true
```

옵션:
- `--date YYYY-MM-DD|yesterday|today`
- `--tz Asia/Seoul`
- `--sessions-dir /path/to/sessions`
- `--memory-root /path/to/workspace`
- `--limit 10`
- `--dry-run true|false`
- `--archive true|false`
- `--promote true|false`
- `--purge true|false`

## Notes

- Phase 1 project-awareness currently adds `primaryProjectHint`, `projectHints`, and `projectSignals` into discovered session/report data.
- This step is intentionally non-destructive: it does **not** persist project links to Supabase yet.
- High-confidence session-project persistence is available in the writer path, but requires the v1 project schema extension (`supabase/dream_memory_v1_projects.sql`) to be applied before `--archive=true` is used for that path.

## Next

1. persist high-confidence session-project links
2. purge 실행기 추가
3. cron 연결
4. promotion merge/replace 고도화

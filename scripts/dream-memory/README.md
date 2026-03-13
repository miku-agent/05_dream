# Dream Memory Runner (v0 skeleton)

이 디렉터리는 Dream Memory System v0의 **실행 가능한 첫 뼈대**입니다.

현재 포함 범위:
- 전날(KST 기준) 세션 파일 탐색
- `.jsonl` 세션 로그 파싱
- explainable project hint detection (Phase 1)
  - `cwd`에서는 workspace/app root로 보이는 segment와 known project alias를 우선 사용
  - text에서는 known alias, numbered project dir(`05_dream`), 또는 project/repo context가 분명한 slug만 채택
- 기초 importance scoring
- candidate extraction
- promotion / retention 후보 판단
- `tmp/dream-memory/YYYY-MM-DD.report.json` 리포트 출력
- `MEMORY.md` + `memory/` 폴더 bootstrap
- project-aware markdown promotion target resolution
- entry slug marker 기반 merge/replace idempotent write
- **옵션으로 Supabase raw/archive 분석 결과 insert/upsert**
  - `dream_jobs`
  - `dream_sessions`
  - `dream_messages`
  - `dream_memory_candidates`
  - `dream_promotions`
- **옵션으로 markdown promotion write**
  - `--promote=true`
  - snapshot backup 후 section-aware merge/replace
  - 동일 `entry_slug` 재실행 시 duplicate append 대신 replace/no-op
  - project-linked candidate는 `memory/projects/<slug>.md`로, stable preference / operation rule은 `MEMORY.md`로 승격
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
- To reduce report noise, unknown slug-like tokens from text are only kept when they are numbered project dirs, repeated, or appear in explicit `project`/`repo` context.
- `cwd`-based detection is conservative: it prefers workspace/app-root project directories and ignores nested tool/script segments such as `scripts/dream-memory`.
- High-confidence project persistence is available in the writer path.
- Session-project links persist to `dream_session_projects`.
- Candidate-project links now also persist to `dream_candidate_projects`.
- `dream_promotions` row의 `target_file`, `target_section`, `entry_slug`, `promotion_mode`는 실제 markdown writer가 사용하는 경로/전략과 동일하게 계산된다.
- markdown writer는 `<!-- dream-memory:entry ... -->` marker를 사용해 기존 entry를 찾아 replace하며, 동일 내용 재실행은 no-op로 처리한다.
- Archive summary now reports `rowsRequested` and `rowsReturned` with `semantics: "upsert_returned_rows"` so the output matches Supabase upsert behavior more accurately. Legacy `*Inserted` aliases are still included for compatibility.
- The v1 project schema extension (`supabase/dream_memory_v1_projects.sql`) must be applied before `--archive=true` is used for these paths.

## Next

1. purge 실행기 추가
2. cron 연결
3. promotion merge/replace 고도화
4. selective embedding / recall path 연결

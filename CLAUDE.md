# 움짤공방 — 작업 메모 (Claude Code용)

개인용 움짤(GIF) 제작 웹앱. 휴대폰 앱 ImgPlay의 기능을 참고해 만들었고, GitHub Pages에 올려서 폰 홈 화면에 추가해 쓰는 게 목표.
사용자와는 **한국어**로 대화할 것.

## 원칙
- 빌드 도구·프레임워크 없음. `index.html` + `app.js`(ES 모듈) + `lib/` 그대로 정적 호스팅.
- 모든 경로는 **상대경로** 유지 (GitHub Pages가 `/저장소이름/` 하위 경로로 서비스되기 때문).
- 파일은 서버로 보내지 않고 전부 브라우저 안에서 처리.
- ImgPlay 이름·로고·UI 에셋은 쓰지 않음 (공개 저장소라서). 앱 이름은 '움짤공방'.

## 파일 구성
| 파일 | 역할 |
|---|---|
| `index.html` | 마크업 + 전체 CSS(:root 토큰) + SVG 아이콘 스프라이트 |
| `app.js` | 모든 로직 (약 1,300줄, 섹션 주석으로 구분) |
| `lib/gifenc.js` | GIF 인코더 gifenc 1.0.3 (MIT, 원본 ESM 그대로) |
| `lib/gifuct.js` | GIF 디코더 gifuct-js 2.1.2를 esbuild로 ESM 번들 (MIT) |
| `manifest.webmanifest`, `sw.js`, `icons/` | 홈 화면 추가(PWA)·오프라인 캐시 |
| `.nojekyll` | GitHub Pages가 Jekyll 처리 안 하게 |

## app.js 구조
- **상태**: `S`(편집 상태, `defaults()`로 초기화), `out`(저장 설정). 프레임은 `{id, bmp(ImageBitmap), w, h, thumb(canvas), on}`.
- **렌더 파이프라인** `renderFrame(ctx, W, H, frame, frac, preview)`: 배경(흐림/단색) → 원본(회전·반전·확대·위치) → 컬러 행렬 필터(getImageData로 픽셀 처리, Safari 호환 때문에 ctx.filter 안 씀) → 비네팅 → 테두리 → 펜 그림 → 텍스트/스티커 레이어. 미리보기와 저장이 같은 함수를 씀.
- 좌표는 전부 0~1 정규화 (텍스트 위치, 그림 좌표, 크기는 `min(W,H)` 대비 비율) → 해상도와 무관.
- **시퀀스** `getSeq()`: 켜진 프레임만, 방향(fwd/rev/boom) 반영. 속도는 전역 `S.delay`(초/프레임).
- **가져오기**: 동영상은 구간 선택 시트 → `seekTo()`로 한 프레임씩 seek 후 canvas에 그려 추출(긴 쪽 720px). 사진은 긴 쪽 1080px. GIF는 gifuct로 풀고 disposal 처리해서 합성.
- **메모리 보호**: `MAX_FRAMES = 360`, `PIXEL_BUDGET = 56e6`(프레임 픽셀 합). 넘으면 앞쪽만 가져오고 안내.
- **저장**: GIF는 gifenc로 프레임마다 팔레트 양자화(메인 스레드, 프레임마다 `sleep(0)`으로 진행률 갱신). 동영상은 숨긴 `#recCanvas`의 `captureStream` + `MediaRecorder`로 실시간 녹화(MP4 우선, 안 되면 WebM).
- **파일 내보내기 순서**: Claude 아티팩트 안이면 `window.claude.use('downloads')`(claude.ai 미리보기 전용, GitHub에선 자동으로 건너뜀) → 아니면 `navigator.share({files})`(아이폰 '이미지 저장'용) → `<a download>`.
- 디버그용으로 `window.__umjjal`에 상태가 노출돼 있음.

## 디자인
암실(darkroom) 콘셉트, 다크 단일 테마. 토큰은 `index.html` 맨 위 `:root`.
- 색: 바탕 `--bg #121011`, 강조 `--accent #ff5b3d` 하나만. 장식은 필름 스트립(스프로킷 구멍) 모티프만.
- 글꼴: 제목 Black Han Sans, 본문 IBM Plex Sans KR, 숫자·타임코드 IBM Plex Mono (Google Fonts).
- 모바일 우선, 최대 폭 560px. safe-area inset 처리돼 있음.
- **화면 틀 (iOS 26 상단 흐림 방지)**: html/body는 스크롤 안 함. 편집 화면 상단 막대 `header.topbar`는 body 바로 아래, `position: fixed; top: safe-area-inset-top`. 스크롤 영역은 `#root`(fixed, top = inset + `--tbh`). 상태바 뒤에는 html 바탕색만 보이게 아무것도 두지 않음(시트·로딩 오버레이도 inset 아래부터). `--tbh`는 app.js가 ResizeObserver로 재고, 첫 화면에선 막대가 숨겨져 0. 스크롤은 `window`가 아니라 `scroller()`(= #root) 기준. 시트가 열리면 `html.lock`으로 뒤 화면 잠금. 상태바 스타일은 `default`.

## 확인된 것 (데스크톱 Chrome + Playwright 기준)
- 예시 열기, 텍스트/필터/캔버스/그리기/테두리/부메랑 → GIF 저장(30프레임, 반복 정보 정상)
- MP4 저장, 4초 MP4 → 60프레임 추출, 사진 3장 추가, 저장한 GIF 다시 열기
- 콘솔 오류 없음

## 아직 확인 못 한 것 (우선순위)
1. **실제 iPhone Safari**: 동영상 seek 추출이 맞는 프레임을 그리는지, MediaRecorder MP4 저장, 공유 시트 '이미지 저장', 홈 화면 추가 후 standalone 동작
2. Android Chrome 동일 항목
3. 긴 동영상·큰 사진에서 메모리/속도 (GIF 인코딩을 Web Worker로 옮길지 검토)

## ImgPlay 대비 빠진 기능 (아이디어 목록)
Live Photo 읽기(웹에서 불가), GIF 검색(GIPHY API 키 필요), AI 배경 지우기, 콜라주/분할 화면, 밈 템플릿, 음악 넣기, 전체 되돌리기(지금은 그리기만 되돌리기 있음), 텍스트 회전.

## 배포·업데이트
- GitHub 무료 플랜은 **공개 저장소**에서만 Pages 사용 가능. Settings → Pages → Deploy from a branch → `main` / `(root)`.
- `sw.js`는 같은 출처 파일을 네트워크 우선으로 받아서 보통은 바로 반영됨. 서비스워커는 `cache: 'no-cache'`로 받아서 GitHub Pages의 10분 HTTP 캐시도 건너뜀.
- **버전**: 고칠 때마다 `app.js`의 `APP_VERSION.n`과 `sw.js`의 `CACHE = 'umjjal-vN'`을 같이 올릴 것 (지금 4). 홈 화면 맨 아래에 'v4 · 날짜 · 홈 화면 앱/브라우저 · 상태바 스타일'로 보여서 폰에 새 버전이 들어왔는지 확인 가능.
- 로컬 확인: `python3 -m http.server 8000` 후 `http://localhost:8000` (file://로 열면 ES 모듈이 막힘).

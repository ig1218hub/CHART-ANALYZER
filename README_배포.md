# Q-Terminal 업데이트 배포 안내

## 파일 (사이트에 모두 올리세요)
index.html · admin.html · **config.js(신규)** · **sw.js(신규)** · **manifest.webmanifest(신규)** · **icon.svg(신규)**
worker.js 는 Cloudflare Worker 에 따로 배포합니다.

## 1. Worker 설정 (Cloudflare 대시보드 → Worker → 설정 → 변수 및 비밀)
| 이름 | 종류 | 설명 |
|---|---|---|
| ALLOWED_ORIGINS | 텍스트 | **필수.** 내 사이트 주소. 예) https://내사이트.pages.dev (쉼표로 여러 개). 비우면 누구나 프록시를 쓸 수 있습니다 |
| ADMIN_SETUP_CODE | 비밀 | 최초 관리자 생성 때 입력할 코드 (이미 관리자가 있으면 사용 안 함) |
| TELEGRAM_BOT_TOKEN | 비밀 | 텔레그램 서버 알림용 (@BotFather 로 봇 생성) |
| TELEGRAM_BOT_NAME | 텍스트 | 봇 이름 (안내 문구용, 선택) |
| PBKDF2_ITER | 텍스트 | 비밀번호 해시 반복 횟수. 무료 플랜은 비워 두세요(30000). 유료 플랜이면 100000 이상. 기존 회원은 다음 로그인 때 자동 업그레이드 |

DB 테이블(rate_limit, user_tg)은 첫 요청 때 자동 생성됩니다.

## 2. 서버 가격 알림 켜기
Worker → 설정 → 트리거 → **Cron 트리거 추가** → `* * * * *` (1분마다)
그 뒤 사이트의 내 계정 → "텔레그램 알림"에서 채팅 ID를 연결합니다. (봇에게 먼저 /start 전송)
서버가 확인하는 알림: 코인(KRW·USDT 마켓), 주식(거래 통화로 만든 알림). 이번 업데이트 이전에 만든 알림은 마켓 정보가 없어 앱이 열려 있을 때만 동작하니 다시 등록하세요.

## 3. 주소 관리
Worker 주소는 이제 config.js 한 곳에서만 바꿉니다 (index.html·admin.html 공통).

## 4. 직접 하셔야 하는 것 (자동으로 할 수 없었던 부분)
- 외부 스크립트 무결성(SRI): 네트워크가 막혀 해시를 계산하지 못했습니다. 아래 명령으로 계산해 index.html 의 lightweight-charts `<script>` 태그에 `integrity="sha384-..."` 를 추가하세요.
  `curl -s https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js | openssl dgst -sha384 -binary | openssl base64 -A`

## 5. 한국 주식 차트가 안 나올 때
- TradingView 무료 위젯은 한국거래소(KRX) 종목을 제공하지 않습니다. 그래서 한국 주식은 **자체 차트(Worker 경유 시세)** 로만 볼 수 있고, Worker 연결이 끊기면 TradingView 대신 연결 실패 안내가 표시됩니다.
- 관심종목 가격이 전부 `—` 로 나오면 Worker 연결 문제입니다. 먼저 확인하세요.
  1. `ALLOWED_ORIGINS` 가 **실제 접속 주소와 글자까지 똑같은지** (예: `https://내사이트.pages.dev` — 끝에 `/` 를 붙이지 말고, http/https·www 여부도 일치해야 함). 여러 도메인이면 쉼표로 모두 등록.
  2. `config.js` 의 Worker 주소가 맞는지, worker.js 를 최신 버전으로 다시 배포했는지.
  3. 브라우저에서 Worker 주소를 직접 열어 상태 확인이 응답하는지.

## 6. 미국 데이마켓(주간거래) 시세 — 한국투자증권 Open API
앱 안의 시세 탭과 종목 헤더에 미국 주식의 데이마켓 가격이 표시됩니다. 키는 브라우저가 아니라 **Worker 비밀 값**으로만 보관합니다. (worker.js 를 다시 배포하세요)

1. 한국투자증권 Open API 포털(apiportal.koreainvestment.com)에서 서비스를 신청하고 **실전투자 앱키·앱시크릿**을 발급받습니다. 해외주식 시세를 보려면 해외주식 거래 신청이 되어 있어야 합니다.
2. Worker → 설정 → 변수 및 비밀에 추가
   | 이름 | 종류 | 설명 |
   |---|---|---|
   | KIS_APP_KEY | 비밀 | 앱키 |
   | KIS_APP_SECRET | 비밀 | 앱시크릿 |
   | KIS_BASE | 텍스트(선택) | 기본값 `https://openapi.koreainvestment.com:9443` |
3. **중요 — 포트 설정**: KIS 주소는 `:9443` 포트를 씁니다. Cloudflare Worker 는 기본적으로 포트 번호를 무시하므로 Worker → 설정 → 런타임 → 호환성 플래그에 `allow_custom_ports` 를 추가하세요. (wrangler 를 쓰면 `compatibility_flags = ["allow_custom_ports"]`) 설정하지 않으면 토큰 발급 단계에서 실패합니다.
4. 앱키를 넣지 않으면 데이마켓 항목에 "설정 필요"라고 표시되고 나머지 기능은 그대로 동작합니다.

참고: 접근토큰은 하루 한 번쯤만 발급되도록 D1(kis_token 테이블)에 저장해 재사용합니다. 조회 코드는 주간거래용 BAQ(나스닥)·BAY(뉴욕)·BAA(아멕스)를 차례로 시도합니다.

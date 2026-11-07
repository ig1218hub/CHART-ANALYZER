# Q-Terminal — 실시간 차트 분석 터미널

브라우저 하나로 동작하는 주식·ETF·지수·코인 차트 분석 도구입니다. 서버 없이 `index.html` 한 파일로 GitHub Pages에 올려 PC와 모바일에서 쓸 수 있습니다.

## 기능
- 전세계 주식·ETF·지수·선물·환율 검색 (Yahoo Finance), 한국 종목은 한글명·6자리 코드 검색
- 코인 전 종목: KRW(업비트) · USDT(바이낸스) · BTC 마켓 전환. 해당 마켓이 없으면 환산 차트로 표시
- 주식은 현지 통화 또는 USD·KRW·EUR·JPY 등 13개 통화로 **시점별 환율을 적용해** 환산
- 지표: 이동평균(20/50/200), 볼린저밴드, RSI, MACD, Stochastic RSI, ADX, ATR, OBV, 자동 지지/저항, 자동 추세선, 과거 매수·매도 신호 마커
- 종합 점수(−100~+100)와 매수 진입 구간·손절가·목표가·손익비 제시
- 거시경제 반영: VIX, 미 10년물 금리, 달러인덱스, 원/달러, S&P500·나스닥·코스피 추세
- (선택) Finnhub 키 → PER·ROE·성장률 등 펀더멘털과 뉴스 반영
- (선택) Anthropic 키 → Claude가 웹 검색까지 포함한 전문가 분석 작성
- 즐겨찾기, 한국식/미국식 상승·하락 색상 전환
- 로그인하면 즐겨찾기·작도가 PC·모바일 간 자동 동기화 (관리자 페이지 포함)
- 차트 전체화면(⛶ 버튼 또는 F 키), 모바일은 가로로 돌리면 더 넓게 표시
- 보조지표 창(RSI·MACD·Stoch RSI) 경계선을 끌어서 크기 조절, 두 번 누르면 원래 크기
- 어두운 모드 / 밝은 모드 / 기기 설정 따르기 (상단 해·달 버튼 또는 설정)
- 시세 탭: 시간별·일별 시세표, 미국 주식 프리마켓·애프터마켓 가격 (헤더에도 표시)
- 작도 도구: 추세선, 연장선, 확장선, 수평선, 수평 연장선, 수직선, 평행 채널, 피보나치 되돌림·확장·채널, 사각형, 텍스트
  - 피보나치 되돌림·확장·채널은 레벨 값·색상·표시 여부를 직접 편집 (선택 후 ⚙ 레벨 설정 또는 더블클릭, 기본값 저장 가능)
  - 약한/강한 마그넷, 선택 후 이동·색상·굵기 변경, 지우개, 삭제(Delete 키), 모두 삭제, 되돌리기(Ctrl+Z)
  - 종목·표시통화별로 브라우저에 자동 저장 (주기를 바꿔도 유지)
  - 단축키: Alt+T 추세선, Alt+H 수평선, Alt+V 수직선, Alt+F 피보나치, Esc 취소
- 실시간: 바이낸스·업비트 WebSocket(체결 즉시 반영), 주식 15초(설정 가능) 갱신
- 거래소 직접 연결이 막히면 Worker를 경유해 자동 재시도 (worker.js 최신 버전 필요)

## GitHub Pages에 올리기
1. 새 저장소를 만들고 `index.html`을 업로드합니다.
2. 저장소 **Settings → Pages → Branch: main / root** 를 선택하고 저장합니다.
3. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 로 접속합니다.

## 주식 데이터는 어떻게 표시되나요?
아무 설정이 없어도 주식·ETF·지수는 **TradingView 위젯으로 자동 표시**됩니다 (모든 기기에서 바로 동작). 이때 분석 패널에는 TradingView의 기술적 분석 요약(26개 지표 기반 매수/매도 판정)이 나옵니다.

매수 진입 구간·손절가·목표가, 매매 신호 마커, 통화 환산, 거시경제 점수까지 계산하는 **자체 분석 엔진**을 주식에도 쓰려면 아래 개인 프록시를 한 번만 만들어 두세요.

## 모든 기기 한 번에 설정 (권장, 무료, 5분)
1. https://dash.cloudflare.com 가입 → Workers & Pages → Create → Worker 생성
2. 아래 코드를 붙여 넣고 Deploy → 주소 확인 (예: `https://qt-proxy.내계정.workers.dev`)
3. `index.html`을 열어 맨 위 스크립트의 `APP_CONFIG`에 주소를 적고 저장소에 다시 올립니다.
   ```js
   const APP_CONFIG = {
     STOCK_PROXY: 'https://qt-proxy.내계정.workers.dev/?url=',
     FINNHUB_KEY: ''
   };
   ```
   이제 PC·휴대폰 어디서 접속해도 따로 설정할 필요가 없습니다.

```js
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const u = new URL(req.url).searchParams.get('url');
    if (!u) return new Response('missing url', { status: 400, headers: cors() });
    const target = new URL(u);
    const allow = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    if (!allow.includes(target.hostname)) return new Response('forbidden', { status: 403, headers: cors() });
    const r = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      cf: { cacheTtl: 5 }
    });
    const h = new Headers(r.headers);
    Object.entries(cors()).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }
};
const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
```
무료 플랜은 하루 10만 요청까지 가능합니다.

## 로그인 · 기기 간 동기화 설정 (PC에서 그린 작도를 휴대폰에서 보기)
즐겨찾기와 작도를 모든 기기에서 같이 쓰려면 회원 정보를 저장할 데이터베이스가 필요합니다. 이미 만든 Cloudflare Worker에 무료 D1 데이터베이스를 연결해서 씁니다.

1. **D1 데이터베이스 만들기**: Cloudflare 대시보드 → Storage & Databases → D1 SQL Database → Create → 이름 `qt-db` → Create
2. **Worker에 연결**: Workers & Pages → 기존 Worker(`cold-band-ed5d`) → Settings → Bindings → Add → D1 database → Variable name에 **`DB`** 입력, Database에서 `qt-db` 선택 → Save (Deploy)
3. **Worker 코드 교체**: Worker → Edit code → 기존 코드를 모두 지우고 `worker.js` 내용을 붙여 넣은 뒤 Deploy. (주식 시세 프록시 기능도 그대로 들어 있습니다. 표는 첫 요청 때 자동으로 만들어집니다.)
4. **파일 올리기**: 저장소에 `index.html`, `admin.html`을 함께 올립니다.
5. **관리자 계정 만들기**: `https://<아이디>.github.io/<저장소>/admin.html` 접속 → 처음 만드는 계정이 관리자가 됩니다.
6. 앱 오른쪽 위 사람 모양 버튼 → 로그인. 휴대폰에서도 같은 계정으로 로그인하면 끝입니다.

### 동작 방식
- 작도·즐겨찾기를 바꾸면 1.5초 뒤 서버에 저장되고, 다른 기기는 20초마다(또는 앱을 다시 열 때) 받아옵니다.
- 로그인 전에 이 기기에서 그린 작도는 로그인할 때 계정 데이터와 합쳐집니다 (지워지지 않음).
- 로그아웃해도 이 기기에 저장된 데이터는 남습니다.
- API 키(Claude, Finnhub)는 보안을 위해 동기화하지 않습니다. 설정 → "설정 링크 복사"를 쓰세요.

### 관리자 페이지 (admin.html)
- 가입 방식: 관리자 승인 후 사용(기본) / 자유 가입 / 가입 막기
- 회원 승인·거절, 사용 중지·재사용, 관리자 지정·해제, 비밀번호 초기화, 잠금 해제, 강제 로그아웃, 삭제
- 회원별 동기화 데이터 크기와 로그인 중인 기기 수 확인

### 보안 메모
- 비밀번호는 PBKDF2(SHA-256, 솔트)로 암호화해 저장하며, 로그인 5회 실패 시 10분간 잠깁니다.
- 로그인 토큰은 30일간 유지되고, 서버에는 토큰의 해시만 저장됩니다.
- (선택) Worker → Settings → Variables에 `ALLOWED_ORIGINS` = `https://<아이디>.github.io` 를 추가하면 내 사이트에서 온 요청만 받습니다.
- 무료 한도: Worker 하루 10만 요청, D1 하루 10만 건 쓰기·500만 건 읽기 — 개인·소규모 사용에 충분합니다.

## API 키를 다른 기기로 옮기기
Anthropic(Claude) 키는 과금되므로 `index.html`에 적으면 안 됩니다. 한 기기의 설정에서 키를 저장한 뒤 **설정 → 설정 링크 복사**를 누르고, 그 링크를 휴대폰에서 한 번 열면 키와 설정이 그대로 적용됩니다. 링크에 키가 들어 있으니 본인 기기에서만 여세요.

## 알아둘 점
- TradingView 위젯은 거래소 라이선스 때문에 일부 종목(특히 일부 국내 종목)이 위젯에서 표시되지 않을 수 있습니다. 이 경우 위 프록시를 설정하면 자체 엔진으로 표시됩니다.
- API 키는 사용자의 브라우저(localStorage)에만 저장되며 저장소에 올라가지 않습니다. 키를 코드에 직접 써넣지 마세요.
- 무료 데이터 특성상 일부 거래소 시세는 15~20분 지연될 수 있습니다. 미국 주식은 대체로 실시간에 가깝고, 코인은 거래소 실시간입니다.
- 바이낸스는 일부 국가에서 접속이 제한될 수 있어 공개 시세 전용 주소(data-api.binance.vision)를 사용합니다.
- 분석 결과는 규칙 기반 계산과 AI 의견이며 투자 권유가 아닙니다.

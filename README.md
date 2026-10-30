# 분양시장 레이더 — GitHub만으로 운영하기

시·군·구를 지도에서 고르면 **미분양 추이 · 향후 공급(입주예정·인허가) · 최근 3년 청약 결과**를 보여주는 사이트입니다.
**GitHub 하나로** 저장·자료 수집·배포를 모두 합니다. 완성되면 주소는 `https://내아이디.github.io/bunyang-radar/` 입니다.

## 어떻게 돌아가나
```
매일 07:17 (한국시간)
GitHub Actions ──(시크릿에 넣은 키로)──▶ 청약홈·KOSIS API
      │
      ├─ public/data/*.json 으로 저장(커밋)
      └─ GitHub Pages로 사이트 배포
사이트 ──▶ 저장된 JSON 파일만 읽음 (키는 사이트에 없음)
```
- API 키는 GitHub **시크릿**에만 있어서 사이트를 보는 사람에게 노출되지 않습니다.
- 실시간 대신 **하루 한 번** 갱신됩니다. 미분양은 월 단위, 청약은 공고 단위 자료라 실사용엔 차이가 거의 없습니다. 급할 땐 Actions에서 바로 한 번 더 돌리면 됩니다.

---

## 1. API 키 받기 (무료)
**공공데이터포털 (청약)**
1. data.go.kr 회원가입 → 로그인
2. `한국부동산원_청약홈 분양정보 조회 서비스` 검색 → **활용신청**
3. `한국부동산원_청약홈 청약접수 경쟁률 및 특별공급 신청현황 조회 서비스` 검색 → **활용신청**
4. 마이페이지 → Open API → 활용신청 현황 → **일반 인증키(Decoding)** 복사 (Encoding 아님)

**KOSIS (미분양·인허가)**
1. kosis.kr/openapi 회원가입 → 로그인 → **활용신청** → 마이페이지에서 인증키 복사

---

## 2. 저장소 만들기
1. github.com → 오른쪽 위 **＋ → New repository**
2. Repository name: `bunyang-radar`
3. **Public** 선택 (무료 계정은 Public 저장소만 GitHub Pages를 쓸 수 있습니다. 공개되는 건 코드와 공공데이터뿐이고 키는 공개되지 않습니다)
4. **Create repository**

## 3. 파일 올리기
**Claude에게 맡기는 경우**: 저장소 이름(예: `내아이디/bunyang-radar`)을 알려주면 Claude가 직접 올립니다. 이 단계를 건너뛰세요.

**직접 올리는 경우**
1. zip을 풀고, 저장소 화면의 **uploading an existing file** 클릭
2. 폴더 **안의 내용물 전부**를 끌어다 놓기 → **Commit changes**
3. ⚠️ `.github` 폴더는 숨김 폴더라 끌어 놓을 때 빠지기 쉽습니다. 저장소 첫 화면에 `.github` 폴더가 안 보이면:
   - **Add file → Create new file** → 파일 이름 칸에 `.github/workflows/update-and-deploy.yml` 입력
   - zip 안의 같은 파일 내용을 복사해 붙여넣기 → **Commit changes**

> 파일을 올리자마자 Actions가 자동으로 한 번 돌다가 **빨간 X로 실패**할 수 있습니다. 4·5단계 설정 전이라 생기는 정상 현상이니 무시하세요.

## 4. 키 넣기 (시크릿)
1. 저장소 → **Settings** → 왼쪽 **Secrets and variables → Actions**
2. **New repository secret** 두 번:
   | Name | Secret |
   |---|---|
   | `DATA_GO_KR_KEY` | 공공데이터포털 Decoding 키 |
   | `KOSIS_KEY` | KOSIS 키 |

## 5. GitHub Pages 켜기
1. 저장소 → **Settings → Pages**
2. **Build and deployment → Source** 를 **GitHub Actions** 로 선택 (저장 버튼 없음, 고르면 끝)

## 6. 첫 실행
1. 저장소 → **Actions** 탭 → (처음이면 "I understand… enable" 버튼 클릭)
2. 왼쪽 **데이터 갱신 및 배포** → 오른쪽 **Run workflow → Run workflow**
3. 노란 점 → 초록 체크가 되면 완료. **첫 실행은 10~20분** 걸립니다(최근 3년 전국 단지의 경쟁률을 처음 모으기 때문). 다음부터는 새 공고만 받아서 1~2분.
4. 실행 결과를 눌러 **deploy** 상자에 나온 주소가 내 사이트입니다.

## 7. 잘 됐는지 확인
- 사이트 상단 배지: **"미분양 KOSIS · 2026.xx · 매일 자동 갱신"** 이면 KOSIS 정상 (`내장자료`면 KOSIS 수집 실패)
- `https://내아이디.github.io/bunyang-radar/data/meta.json` 열기
  - `unsold.ok`, `permit.ok`, `cheongyak.ok` 가 `true` 인지
  - `compSample` 에 `SUBSCRPT_RANK_CODE`, `REQ_CNT`, `SUPLY_HSHLDCO` 가 있는지 (없으면 경쟁률 계산 필드를 맞춰야 함 → 이 화면을 Claude에게 보여주세요)
- 실패하면 Actions 실행 기록 → **공공 API에서 자료 받기** 단계를 펼쳐 빨간 글씨를 확인
  - `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`: Encoding 키를 넣었거나 승인 전 → Decoding 키, 1~2시간 뒤 재실행
  - `kosis_error`: KOSIS 키 확인. 인허가만 실패면 `lib/sources.mjs`의 통계표 ID 문제

---

## 수정하고 싶을 때
GitHub에서 파일을 열고 연필(✏️) → 수정 → **Commit changes** 하면 자동으로 다시 배포됩니다.
- **입주예정물량**(매년 2월경 발표): `public/data/supply.json` 숫자만 변경
- **인허가·착공 통계표**: `lib/sources.mjs`의 `tblId` 변경(`start`는 비워두면 화면에서 숨김)
- **갱신 시각**: `.github/workflows/update-and-deploy.yml`의 `cron` (UTC 기준, `17 22 * * *` = 한국 07:17)
- **행정구역 개편**: `scripts/build_geo.py`로 `public/data/geo.json` 재생성

## 폴더 구조
```
public/                     사이트 (GitHub Pages에 올라가는 부분)
  index.html, app.js, style.css
  data/geo.json             시·도/시·군·구 경계 (2026.10)
  data/supply.json          입주예정물량 (손으로 갱신)
  data/unsold-fallback.json 미분양 내장 자료 (KOSIS 수집 전·실패 시 사용)
  data/unsold.json          ┐
  data/permit.json          │ Actions가 매일 자동 생성
  data/cheongyak/<시도>.json │
  data/meta.json            ┘ 수집 결과 요약
scripts/fetch-data.mjs      자료 수집 스크립트
lib/                        KOSIS 호출·주소→시군구 변환·경쟁률 계산
cache/comp.json             경쟁률 캐시 (이미 받은 단지는 다시 안 물어봄)
.github/workflows/          매일 수집 + 배포 설정
```

## 알아둘 점
- 입주예정물량은 시·도 단위 자료라 시·군·구를 골라도 상위 시·도 값을 보여줍니다.
- 공급 부담 지표(입주예정 ÷ 현재 미분양)는 비교용 참고값이며 공식 지표가 아닙니다.
- 인천 2026.07 개편 전 청약 공고(중구·동구·서구)는 동 이름으로 새 구에 배정한 근사값입니다.
- 1순위 평균 경쟁률 = 1순위 접수 합계 ÷ 일반공급 세대(특별공급 제외). 최근 45일 안의 공고는 매일 다시 확인합니다.
- 분양 예정 단지 목록은 공식 통계가 없어 넣지 않았습니다.

출처: 국토교통부 시·군·구별 미분양현황(KOSIS DT_MLTM_2082), 한국부동산원 청약홈(공공데이터포털), 한국부동산원·부동산R114 공동주택 입주예정물량(2026.02 발표), 행정경계 vuski/admdongkor(ver20261001).

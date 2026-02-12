# 식품안전정보원 여비정산 시스템

영수증을 일괄 업로드하면 Claude AI가 자동으로 분석하여 출장을 생성하고, 공식 여비신청서 양식의 정산표를 출력하는 시스템입니다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| Frontend | React 18, Vite 6, Tailwind CSS 3 |
| Backend | Vercel Serverless Functions (Node.js) |
| AI | Claude Sonnet 4.5 (Vision API) |
| 배포 | Vercel |

## 프로젝트 구조

```
├── src/
│   ├── App.jsx          # 메인 앱 (UI + 비즈니스 로직 + 정산표)
│   ├── main.jsx         # 엔트리포인트
│   └── index.css        # Tailwind 스타일
├── api/
│   ├── analyze.js       # 영수증 이미지 분석 API (Claude Vision)
│   └── qa.js            # 영수증 Q&A 대화 API
├── vite.config.js
├── vercel.json
├── tailwind.config.js
└── package.json
```

## 시작하기

### 사전 요구사항

- Node.js 18+
- Anthropic API 키 (`ANTHROPIC_API_KEY`)

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 환경변수 설정
export ANTHROPIC_API_KEY=your-api-key

# 개발 서버 실행
npm run dev

# 프로덕션 빌드
npm run build
```

> 로컬 개발 시 API 요청은 Vite 프록시를 통해 `http://localhost:3000`으로 전달됩니다.
> Vercel CLI(`vercel dev`)로 서버리스 함수를 로컬에서 실행하거나, 별도 API 서버를 구성해야 합니다.

### Vercel 배포

```bash
# Vercel에 배포
vercel

# 환경변수 설정 (Vercel 대시보드 또는 CLI)
vercel env add ANTHROPIC_API_KEY
```

## 주요 기능

### 1. 영수증 AI 자동 분석
- 영수증 이미지/PDF를 일괄 업로드하면 Claude Vision API가 자동 분석
- 지원 영수증: **KTX/철도**, **숙박**, **톨게이트**, **현지영수증(편의점/식당 등)**, **지도캡처**
- 날짜 기준으로 자동 출장 그룹핑
- 신뢰도(confidence)가 낮을 경우 Q&A 대화로 보완

### 2. 출장 관리
- **관외출장**: 구간(leg)별 교통편, 일비, 식비, 숙박비 입력
- **관내출장**: 4시간 기준 정액 지급 (4h 미만 10,000원 / 4h 이상 20,000원)
- 임원(5급 이상) 특별 규정: KTX 특실, 숙박비 상한 없음

### 3. 정산표 출력
- 공식 여비신청서 17컬럼 양식 대응
- 법인카드/개인지출 구분, 카드번호/승인번호(KTX만)
- 금액 한글 표기 자동 변환
- 인쇄 최적화 스타일

## 여비 규정 (상수)

| 항목 | 금액 | 비고 |
|------|------|------|
| 일비 | 25,000원 | 공용차량 시 50% (12,500원) |
| 식비 | 25,000원 | 제공 식사 1끼당 8,330원 차감 |
| 자가차량 유류비 | 1,680원/km | |
| 숙박비 (서울) | 100,000원 상한 | 임원: 상한 없음 |
| 숙박비 (광역시) | 80,000원 상한 | 부산, 대구, 인천, 광주, 대전, 울산 |
| 숙박비 (기타) | 70,000원 상한 | |
| 관내출장 (4h 미만) | 10,000원 정액 | |
| 관내출장 (4h 이상) | 20,000원 정액 | |

> 상수 값은 `src/App.jsx` 상단에서 수정할 수 있습니다.

## API 엔드포인트

### `POST /api/analyze`
영수증 이미지를 Claude Vision으로 분석합니다.

**요청:**
```json
{
  "image": "<base64 인코딩된 이미지>",
  "mediaType": "image/jpeg",
  "fileName": "ktx_receipt.jpg"
}
```

**응답:** 영수증 유형별 분석 결과 배열 (`rail_receipt`, `lodging_receipt`, `toll_receipt`, `local_receipt`, `map_capture`, `unknown`)

### `POST /api/qa`
영수증 분석 결과에 대한 후속 Q&A 대화를 처리합니다.

**요청:**
```json
{
  "receiptData": { ... },
  "conversationHistory": [],
  "userMessage": "이건 자가차량 영수증입니다"
}
```

## 기본값 안내

- **일비/식비**: 새 출장 생성 시 "해당없음"이 기본 선택 (사용자가 직접 변경)
- **숙박비**: "해당없음"이 기본 선택
- **법인카드 번호/승인번호**: KTX 영수증만 자동 인식 및 표시, 그 외 영수증은 입력하지 않음
